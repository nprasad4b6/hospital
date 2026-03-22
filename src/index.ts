import 'dotenv/config';
import express, { Express, Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import connectDB from './config/database';
import Patient from './models/Patient';
import Doctor from './models/Doctor';
import { IPatient, IQueueItem } from './types/patient';
import { callPatient } from './controllers/patientController';

// Twilio setup
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
let twilio: any = null;

if (accountSid && authToken) {
  twilio = require('twilio')(accountSid, authToken);
}

const app: Express = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(express.json());
app.use(cors());

// Connect to MongoDB
connectDB();

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Generate tracking link for patient
 */
function generateTrackingLink(tokenNumber: number): string {
  // Use HOSPITAL_BASE_URL (preferred) or FRONTEND_URL, fallback to localhost
  const baseUrl = process.env.HOSPITAL_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
  return `${baseUrl}/track?token=${tokenNumber}`;
}

/**
 * Return start and end Date objects (UTC) for a calendar day in IST (Asia/Kolkata)
 * If `dateString` is provided, it must be in YYYY-MM-DD format.
 * If omitted, uses current date in IST.
 */
function getIstStartEnd(dateString?: string): { start: Date; end: Date } {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes
  if (dateString) {
    const parts = dateString.split('-').map((v) => parseInt(v, 10));
    const [y, m, d] = parts; // m is 1-based
    const startUtcMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
    const start = new Date(startUtcMs);
    const end = new Date(startUtcMs + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  // use current time shifted to IST to get today's date in IST
  const now = Date.now();
  const istNow = new Date(now + IST_OFFSET_MS);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d) - IST_OFFSET_MS;
  const start = new Date(startUtcMs);
  const end = new Date(startUtcMs + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Send WhatsApp message to patient via Twilio
 */
async function sendWhatsAppMessage(
  phoneNumber: string,
  tokenNumber: number,
  patientName: string
): Promise<boolean> {
  const shouldSend = process.env.SEND_WHATSAPP_ON_REGISTER !== 'false';
  
  if (!shouldSend || !twilio) {
    console.log(`WhatsApp message skipped (enabled: ${shouldSend}, Twilio configured: ${!!twilio})`);
    return false;
  }

  try {
    const trackingLink = generateTrackingLink(tokenNumber);
    const message = `Hello ${patientName}! Your token number is ${tokenNumber}. Track your queue status here: ${trackingLink}. Thank you!`;

    const result = await twilio.messages.create({
      from: `whatsapp:${twilioPhoneNumber}`,
      to: `whatsapp:+91${phoneNumber}`,
      body: message,
    });

    console.log(`✓ WhatsApp message sent to +91${phoneNumber} (SID: ${result.sid})`);
    return true;
  } catch (error) {
    console.error(`✗ Failed to send WhatsApp message to +91${phoneNumber}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

// ============================================
// QUEUE ORDERING
// ============================================

/**
 * getSortedQueue()
 * Queue order is strict arrival order (createdAt ascending).
 * Returns a single sorted array
 */
async function getSortedQueue(dateString?: string): Promise<IPatient[]> {
  try {
    // Limit to patients created within the requested IST calendar day.
    // If no dateString provided, `getIstStartEnd()` returns today's IST boundaries.
    const { start, end } = getIstStartEnd(dateString);

    const patients = await Patient.find({
      createdAt: { $gte: start, $lt: end },
      status: { $in: ['WAITING', 'IN_PROGRESS', 'SKIPPED', 'ON_HOLD'] },
    }).sort({ createdAt: 1 });

    // Active patients participate in queue ordering; skipped/on-hold are appended.
    const activePatients = patients.filter(
      (p) => p.status === 'WAITING' || p.status === 'IN_PROGRESS'
    );
    const awayPatients = patients
      .filter((p) => p.status === 'SKIPPED' || p.status === 'ON_HOLD')
      .sort((a, b) => new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime());

    const sortedQueue = activePatients
      .slice()
      .sort((a, b) => new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime());

    return [...sortedQueue, ...awayPatients];
  } catch (error) {
    console.error('Error in getSortedQueue:', error);
    return [];
  }
}

// ============================================
// CALCULATE WAIT TIME
// ============================================

/**
 * Calculates estimated wait time for all patients
 * Formula: Position * 15 minutes
 */
function calculateWaitTimes(queue: IPatient[]): IQueueItem[] {
  // Re-order queue so ETAs progress in ascending tokenNumber order:
  // 1) IN_PROGRESS (if any) first
  // 2) WAITING sorted by tokenNumber ascending
  // 3) COMPLETED (or others) after
  const inProgress = queue.find((p) => p.status === 'IN_PROGRESS');
  const waiting = queue
    .filter((p) => p.status === 'WAITING')
    .slice()
    .sort((a, b) => (a.tokenNumber || 0) - (b.tokenNumber || 0));
  const completed = queue.filter((p) => p.status === 'COMPLETED');
  const skipped = queue.filter((p) => p.status === 'SKIPPED' || p.status === 'ON_HOLD');

  const ordered: IPatient[] = [];
  if (inProgress) ordered.push(inProgress);
  ordered.push(...waiting);
  ordered.push(...completed);
  ordered.push(...skipped);

  let waitingCounter = 0;
  return ordered.map((patient) => {
    let position: number;
    let estimatedWaitTime: number;

    if (patient.status === 'IN_PROGRESS') {
      position = 0;
      estimatedWaitTime = 0;
    } else if (patient.status === 'WAITING') {
      waitingCounter += 1;
      position = waitingCounter;
      estimatedWaitTime = position * 15;
    } else {
      position = -1;
      estimatedWaitTime = 0;
    }

    const patientData = typeof (patient as any).toObject === 'function'
      ? (patient as any).toObject()
      : patient;

    return {
      ...patientData,
      position,
      estimatedWaitTime,
    } as IQueueItem;
  });
}

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('GET_QUEUE', async () => {
    const queue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(queue);
    socket.emit('QUEUE_UPDATE', queueWithWaitTimes);
  });

  /**
   * GET_QUEUE_BY_DATE Event
   * Fetches queue filtered by a specific date
   * Emits: QUEUE_UPDATE with filtered results
   */
  socket.on('GET_QUEUE_BY_DATE', async (dateString: string) => {
    try {
      // Compute IST start/end for the requested date
      const { start: startOfDay, end: endOfDay } = getIstStartEnd(dateString);

      // Fetch patients created on this date (IST range -> UTC timestamps)
      const patients = await Patient.find({
        createdAt: { $gte: startOfDay, $lt: endOfDay },
        status: { $in: ['WAITING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'ON_HOLD'] },
      }).sort({ createdAt: 1 });

      // Strict FIFO by arrival time.
      const sortedQueue = patients
        .slice()
        .sort((a, b) => new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime());

      const queueWithWaitTimes = calculateWaitTimes(sortedQueue);
      socket.emit('QUEUE_UPDATE', queueWithWaitTimes);
    } catch (error) {
      console.error('Error fetching queue by date:', error);
      socket.emit('ERROR', {
        message: 'Failed to fetch queue for selected date',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * START_CONSULTATION Event
   */
  socket.on('START_CONSULTATION', async () => {
    try {
      const currentPatient = await Patient.findOneAndUpdate(
        { status: 'IN_PROGRESS' },
        {
          status: 'COMPLETED',
          completedAt: new Date(),
        },
        { new: true }
      );

      if (currentPatient) {
        console.log(`Patient ${currentPatient.tokenNumber} consultation completed`);
      }

      // fetch current queue before moving next patient
      const queue = await getSortedQueue();
      let nextPatient = null;

      if (queue.length > 0) {
        nextPatient = await Patient.findByIdAndUpdate(
          queue[0]._id,
          {
            status: 'IN_PROGRESS',
            startedAt: new Date(),
          },
          { new: true }
        );

        console.log(`Patient ${nextPatient?.tokenNumber} consultation started`);
      }

      // after any updates, re‑compute the queue and wait times
      const updatedQueue = await getSortedQueue();
      const queueWithWaitTimes = calculateWaitTimes(updatedQueue);

      if (nextPatient) {
        io.emit('PATIENT_STARTED', {
          patient: nextPatient,
          queue: queueWithWaitTimes,
        });
        console.log(`[${new Date().toISOString()}] Patient started: token=${nextPatient.tokenNumber}`);
      }

      io.emit('QUEUE_UPDATE', queueWithWaitTimes);

      socket.emit('CONSULTATION_STARTED', {
        success: true,
        message: 'Consultation started successfully',
        queue: queueWithWaitTimes,
      });
    } catch (error) {
      console.error('Error in START_CONSULTATION:', error);
      socket.emit('ERROR', {
        message: 'Failed to start consultation',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  // Provide daily COMPLETED count on request
  socket.on('GET_DAILY_COMPLETED_COUNT', async () => {
    try {
      // Use IST (Asia/Kolkata) day boundaries for creation date
      const { start: startOfDay, end: endOfDay } = getIstStartEnd();

      const count = await Patient.countDocuments({
        createdAt: { $gte: startOfDay, $lt: endOfDay },
        status: 'COMPLETED',
      });

      socket.emit('DAILY_COMPLETED_COUNT', { count });
    } catch (err) {
      console.error('Error fetching daily completed count:', err);
      socket.emit('DAILY_COMPLETED_COUNT', { count: 0 });
    }
  });

  /**
   * RESET_QUEUE Event
   * Manually resets the queue to today's patients
   * Useful for starting a new shift
   */
  socket.on('RESET_QUEUE', async () => {
    try {
      // Compute today's IST start/end and fetch patients for that day
      const { start: startOfDay, end: endOfDay } = getIstStartEnd();

      const patients = await Patient.find({
        createdAt: { $gte: startOfDay, $lt: endOfDay },
        status: { $in: ['WAITING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'ON_HOLD'] },
      }).sort({ createdAt: 1 });

      const sortedQueue = patients
        .slice()
        .sort((a, b) => new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime());

      const queueWithWaitTimes = calculateWaitTimes(sortedQueue);
      io.emit('QUEUE_UPDATE', queueWithWaitTimes);
      socket.emit('RESET_SUCCESS', {
        message: 'Queue reset to today\'s patients (IST)',
        queue: queueWithWaitTimes,
      });
    } catch (error) {
      console.error('Error resetting queue:', error);
      socket.emit('ERROR', {
        message: 'Failed to reset queue',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

// ============================================
// REST API ENDPOINTS
// ============================================

/**
 * GET /api/queue
 */
app.get('/api/queue', async (req: Request, res: Response) => {
  try {
    const queue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(queue);
    res.json(queueWithWaitTimes);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * GET /api/queue-by-date?date=YYYY-MM-DD
 * Returns complete queue records for selected IST date across all statuses
 * (WAITING, IN_PROGRESS, COMPLETED, SKIPPED, ON_HOLD) with position + ETA fields.
 */
app.get('/api/queue-by-date', async (req: Request, res: Response) => {
  try {
    const dateString = typeof req.query.date === 'string' ? req.query.date : undefined;
    const { start: startOfDay, end: endOfDay } = getIstStartEnd(dateString);

    const patients = await Patient.find({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: { $in: ['WAITING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'ON_HOLD'] },
    }).sort({ createdAt: 1 });

    const sortedQueue = patients
      .slice()
      .sort((a, b) => new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime());

    const queueWithWaitTimes = calculateWaitTimes(sortedQueue);
    res.json(queueWithWaitTimes);
  } catch (error) {
    console.error('Error fetching queue by date via REST:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * GET /api/patients/history?months=3&search=term
 * Returns patient visits in the last N months (default: 3).
 * Optional search matches name/phone/tokenNumber.
 */
app.get('/api/patients/history', async (req: Request, res: Response) => {
  try {
    const monthsRaw = typeof req.query.months === 'string' ? parseInt(req.query.months, 10) : 3;
    const months = Number.isFinite(monthsRaw) && monthsRaw > 0 ? monthsRaw : 3;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const end = new Date();
    const start = new Date(end);
    start.setMonth(start.getMonth() - months);

    const filter: any = {
      createdAt: { $gte: start, $lte: end },
      // Include legacy DONE records so historical searches remain complete.
      status: { $in: ['WAITING', 'IN_PROGRESS', 'COMPLETED', 'DONE', 'SKIPPED', 'ON_HOLD'] },
    };

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const orConditions: any[] = [
        { name: regex },
        { phone: regex },
      ];

      const numeric = Number(search);
      if (Number.isFinite(numeric)) {
        orConditions.push({ tokenNumber: numeric });
      }

      filter.$or = orConditions;
    }

    const patients = await Patient.find(filter).sort({ createdAt: -1 });
    const normalized = patients.map((patient) => {
      const data = typeof (patient as any).toObject === 'function'
        ? (patient as any).toObject()
        : patient;

      if ((data as any).status === 'DONE') {
        (data as any).status = 'COMPLETED';
      }

      return data;
    });

    res.json(normalized);
  } catch (error) {
    console.error('Error fetching patient history:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * GET /api/stats/completed-today
 * Returns count of patients created today (by IST date) who have status COMPLETED
 * (regardless of when they were completed)
 */
app.get('/api/stats/completed-today', async (req: Request, res: Response) => {
  try {
    // Use IST boundaries for creation date
    const { start: startOfDay, end: endOfDay } = getIstStartEnd();

    const count = await Patient.countDocuments({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: 'COMPLETED',
    });

    res.json({ count });
  } catch (error) {
    console.error('Error fetching completed-today count:', error);
    res.status(500).json({ count: 0 });
  }
});

/**
 * GET /api/stats/today-all
 * Debug endpoint: Returns all patients for today grouped by status
 */
app.get('/api/stats/today-all', async (req: Request, res: Response) => {
  try {
    const { start: startOfDay, end: endOfDay } = getIstStartEnd();

    const waiting = await Patient.find({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: 'WAITING',
    }).sort({ createdAt: 1 });

    const inProgress = await Patient.find({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: 'IN_PROGRESS',
    }).sort({ createdAt: 1 });

    const completed = await Patient.find({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: 'COMPLETED',
    }).sort({ completedAt: -1 });

    const onHold = await Patient.find({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: 'ON_HOLD',
    }).sort({ createdAt: 1 });

    const skipped = await Patient.find({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: 'SKIPPED',
    }).sort({ createdAt: 1 });

    res.json({
      istDayRange: { start: startOfDay, end: endOfDay },
      counts: {
        waiting: waiting.length,
        inProgress: inProgress.length,
        completed: completed.length,
        onHold: onHold.length,
        skipped: skipped.length,
        total: waiting.length + inProgress.length + completed.length + onHold.length + skipped.length,
      },
      patients: { waiting, inProgress, completed, onHold, skipped },
    });
  } catch (error) {
    console.error('Error fetching today-all stats:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'An error occurred' });
  }
});

/**
 * POST /api/patients
 */
app.post('/api/patients', async (req: Request, res: Response) => {
  try {
    const { name, phone, type, age, gender, guardianName, relation, address, doctorId } = req.body;

    // Compute token number relative to the current IST calendar day so tokens start from 1 each day
    const { start: todayStart, end: todayEnd } = getIstStartEnd();
    const lastToday = await Patient.findOne({
      createdAt: { $gte: todayStart, $lt: todayEnd },
    }).sort({ tokenNumber: -1 });
    const tokenNumber = (lastToday?.tokenNumber && lastToday.tokenNumber >= 1)
      ? lastToday.tokenNumber + 1
      : 1;

    const patient = new Patient({
      name,
      phone,
      age,
      gender: gender || 'FEMALE',
      tokenNumber,
      type: type || 'WALK_IN',
      status: 'WAITING',
      ...(guardianName && { guardianName }),
      ...(relation && { relation }),
      ...(address && { address }),
      ...(doctorId && { doctorId }),
    });

    await patient.save();

    // Send WhatsApp message if enabled (default: true)
    const whatsappSent = await sendWhatsAppMessage(phone, tokenNumber, name);

    const queue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(queue);
    io.emit('QUEUE_UPDATE', queueWithWaitTimes);

    // Emit registration and queue update so all displays update immediately
    const response = {
      ...patient.toObject(),
      trackingLink: generateTrackingLink(tokenNumber),
      whatsappSent,
    };

    io.emit('PATIENT_REGISTERED', {
      patient: response,
      queue: queueWithWaitTimes,
    });
    console.log(`[${new Date().toISOString()}] Patient registered: token=${tokenNumber}, name=${name}`);

    res.status(201).json(response);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * POST /api/start-consultation
 * HTTP helper to trigger the same behavior as socket 'START_CONSULTATION'
 */
app.post('/api/start-consultation', async (req: Request, res: Response) => {
  try {
    const currentPatient = await Patient.findOneAndUpdate(
      { status: 'IN_PROGRESS' },
      {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
      { new: true }
    );

    if (currentPatient) {
      console.log(`Patient ${currentPatient.tokenNumber} consultation completed (via HTTP)`);
    }

    // fetch queue before advancing
    const queue = await getSortedQueue();
    let nextPatient = null;

    if (queue.length > 0) {
      nextPatient = await Patient.findByIdAndUpdate(
        queue[0]._id,
        {
          status: 'IN_PROGRESS',
          startedAt: new Date(),
        },
        { new: true }
      );

      console.log(`Patient ${nextPatient?.tokenNumber} consultation started (via HTTP)`);
    }

    const updatedQueue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(updatedQueue);

    if (nextPatient) {
      io.emit('PATIENT_STARTED', {
        patient: nextPatient,
        queue: queueWithWaitTimes,
      });
    }

    io.emit('QUEUE_UPDATE', queueWithWaitTimes);

    res.json({ success: true, queue: queueWithWaitTimes });
  } catch (error) {
    console.error('Error in start-consultation (HTTP):', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'An error occurred' });
  }
});

/**
 * POST /api/patients/call
 * Emergency/quick call: completes current IN_PROGRESS and starts selected patient
 */
app.post('/api/patients/call', callPatient);

/**
 * GET /api/patients/:id
 */
app.get('/api/patients/:id', async (req: Request, res: Response) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    const patientData = patient.toObject();
    res.json({
      ...patientData,
      trackingLink: generateTrackingLink(patientData.tokenNumber),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * PUT /api/patients/:id
 * Edit registration details for a patient
 */
app.put('/api/patients/:id', async (req: Request, res: Response) => {
  try {
    const {
      name,
      phone,
      age,
      gender,
      guardianName,
      relation,
      address,
    } = req.body;

    const updateData: Record<string, any> = {};

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName || trimmedName.length < 2) {
        return res.status(400).json({ error: 'Name must be at least 2 characters' });
      }
      updateData.name = trimmedName;
    }

    if (phone !== undefined) {
      const normalizedPhone = String(phone).trim();
      if (!/^\d{10}$/.test(normalizedPhone)) {
        return res.status(400).json({ error: 'Phone must be 10 digits' });
      }
      updateData.phone = normalizedPhone;
    }

    if (age !== undefined) {
      const parsedAge = Number(age);
      if (Number.isNaN(parsedAge) || parsedAge < 0 || parsedAge > 120) {
        return res.status(400).json({ error: 'Age must be between 0 and 120' });
      }
      updateData.age = parsedAge;
    }

    if (gender !== undefined) {
      if (!['MALE', 'FEMALE'].includes(String(gender))) {
        return res.status(400).json({ error: 'Invalid gender value' });
      }
      updateData.gender = gender;
    }

    if (guardianName !== undefined) {
      updateData.guardianName = String(guardianName).trim();
    }

    if (relation !== undefined) {
      const normalizedRelation = String(relation).trim();
      if (normalizedRelation && !['Father', 'Mother', 'Guardian'].includes(normalizedRelation)) {
        return res.status(400).json({ error: 'Invalid relation value' });
      }
      updateData.relation = normalizedRelation;
    }

    if (address !== undefined) {
      updateData.address = String(address).trim();
    }

    const patient = await Patient.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const queue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(queue);
    io.emit('QUEUE_UPDATE', queueWithWaitTimes);

    res.json(patient);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * PUT /api/patients/:id/status
 */
app.put('/api/patients/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const updateData: Record<string, any> = { status };

    if (status === 'IN_PROGRESS') {
      updateData.startedAt = new Date();
    }
    if (status === 'COMPLETED') {
      updateData.completedAt = new Date();
    }

    const patient = await Patient.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    const queue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(queue);
    io.emit('QUEUE_UPDATE', queueWithWaitTimes);

    res.json(patient);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * DELETE /api/patients/:id
 */
app.delete('/api/patients/:id', async (req: Request, res: Response) => {
  try {
    const patient = await Patient.findByIdAndDelete(req.params.id);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const queue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(queue);
    io.emit('QUEUE_UPDATE', queueWithWaitTimes);

    res.json({ message: 'Patient removed successfully' });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * POST /api/reset
 */
app.post('/api/reset', async (req: Request, res: Response) => {
  try {
    await Patient.deleteMany({});
    io.emit('QUEUE_UPDATE', []);
    res.json({ message: 'Queue reset successfully' });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * GET /api/doctors
 * Returns all active doctors (isActive: true), sorted by name.
 */
app.get('/api/doctors', async (req: Request, res: Response) => {
  try {
    const doctors = await Doctor.find({ isActive: true }).sort({ name: 1 }).select('_id doctorId name specialization roomNumber');
    res.json(doctors);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

/**
 * POST /api/doctors/bulk-insert
 * Accepts an array of doctor objects and inserts them all at once.
 * Returns a 409 on duplicate email/doctorId violations.
 */
app.post('/api/doctors/bulk-insert', async (req: Request, res: Response) => {
  try {
    const doctors = req.body;
    if (!Array.isArray(doctors) || doctors.length === 0) {
      res.status(400).json({ error: 'Request body must be a non-empty array of doctor objects.' });
      return;
    }
    const inserted = await Doctor.insertMany(doctors, { ordered: false });
    res.status(201).json({ message: `${inserted.length} doctor(s) inserted successfully.`, data: inserted });
  } catch (error: any) {
    // MongoDB duplicate key error code
    if (error.code === 11000 || (error.writeErrors && error.writeErrors.some((e: any) => e.code === 11000))) {
      const duplicates = error.writeErrors
        ? error.writeErrors.filter((e: any) => e.code === 11000).map((e: any) => e.err?.op?.email || e.err?.op?.doctorId)
        : [error.keyValue];
      res.status(409).json({
        error: 'Duplicate email or doctorId detected.',
        duplicates,
        inserted: error.result?.nInserted ?? 0,
      });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`\n🏥 Hospital Queue Server running on port ${PORT}`);
  console.log(`Socket.io is listening for client connections`);
});

export { app, io, Patient, getSortedQueue, calculateWaitTimes };
