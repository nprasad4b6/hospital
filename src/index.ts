import 'dotenv/config';
import express, { Express, Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import connectDB from './config/database';
import Patient from './models/Patient';
import { IPatient, IQueueItem } from './types/patient';

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
  const baseUrl = process.env.HOSPITAL_BASE_URL || 'http://localhost:3000';
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
// HYBRID SLOTTING ALGORITHM
// ============================================

/**
 * getSortedQueue()
 * Implements Hybrid Slotting Algorithm:
 * For every 3 BOOKED patients, insert 1 WALK_IN patient
 * Returns a single sorted array
 */
async function getSortedQueue(): Promise<IPatient[]> {
  try {
    const patients = await Patient.find({
      status: { $in: ['WAITING', 'IN_PROGRESS'] },
    }).sort({ createdAt: 1 });

    const bookedPatients = patients.filter((p) => p.type === 'BOOKED');
    const walkInPatients = patients.filter((p) => p.type === 'WALK_IN');

    const sortedQueue: IPatient[] = [];
    let bookedIndex = 0;
    let walkInIndex = 0;

    while (
      bookedIndex < bookedPatients.length ||
      walkInIndex < walkInPatients.length
    ) {
      for (let i = 0; i < 3 && bookedIndex < bookedPatients.length; i++) {
        sortedQueue.push(bookedPatients[bookedIndex++]);
      }

      if (walkInIndex < walkInPatients.length) {
        sortedQueue.push(walkInPatients[walkInIndex++]);
      }
    }

    return sortedQueue;
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
  // Compute positions relative to only IN_PROGRESS and WAITING patients.
  // IN_PROGRESS => position 0, WAITING => 1..n (increment per waiting patient),
  // DONE or other statuses get position -1 and ETA 0.
  let waitingCounter = 0;
  return queue.map((patient) => {
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
      // DONE or unknown status
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
        status: { $in: ['WAITING', 'IN_PROGRESS', 'DONE'] },
      }).sort({ createdAt: 1 });

      // Apply hybrid algorithm for sorting
      const bookedPatients = patients.filter((p) => p.type === 'BOOKED');
      const walkInPatients = patients.filter((p) => p.type === 'WALK_IN');

      const sortedQueue: IPatient[] = [];
      let bookedIndex = 0;
      let walkInIndex = 0;

      while (
        bookedIndex < bookedPatients.length ||
        walkInIndex < walkInPatients.length
      ) {
        for (let i = 0; i < 3 && bookedIndex < bookedPatients.length; i++) {
          sortedQueue.push(bookedPatients[bookedIndex++]);
        }

        if (walkInIndex < walkInPatients.length) {
          sortedQueue.push(walkInPatients[walkInIndex++]);
        }
      }

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
          status: 'DONE',
          completedAt: new Date(),
        },
        { new: true }
      );

      if (currentPatient) {
        console.log(`Patient ${currentPatient.tokenNumber} consultation completed`);
      }

      const queue = await getSortedQueue();

      if (queue.length > 0) {
        const nextPatient = await Patient.findByIdAndUpdate(
          queue[0]._id,
          {
            status: 'IN_PROGRESS',
            startedAt: new Date(),
          },
          { new: true }
        );

        console.log(`Patient ${nextPatient?.tokenNumber} consultation started`);
      }

      const updatedQueue = await getSortedQueue();
      const queueWithWaitTimes = calculateWaitTimes(updatedQueue);

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

  // Provide daily DONE count on request
  socket.on('GET_DAILY_DONE_COUNT', async () => {
    try {
      // Use IST (Asia/Kolkata) day boundaries
      const { start: startOfDay, end: endOfDay } = getIstStartEnd();

      const count = await Patient.countDocuments({
        status: 'DONE',
        completedAt: { $gte: startOfDay, $lt: endOfDay },
      });

      socket.emit('DAILY_DONE_COUNT', { count });
    } catch (err) {
      console.error('Error fetching daily done count:', err);
      socket.emit('DAILY_DONE_COUNT', { count: 0 });
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
        status: { $in: ['WAITING', 'IN_PROGRESS', 'DONE'] },
      }).sort({ createdAt: 1 });

      // Apply hybrid algorithm to today's patients
      const bookedPatients = patients.filter((p) => p.type === 'BOOKED');
      const walkInPatients = patients.filter((p) => p.type === 'WALK_IN');

      const sortedQueue: IPatient[] = [];
      let bookedIndex = 0;
      let walkInIndex = 0;

      while (
        bookedIndex < bookedPatients.length ||
        walkInIndex < walkInPatients.length
      ) {
        for (let i = 0; i < 3 && bookedIndex < bookedPatients.length; i++) {
          sortedQueue.push(bookedPatients[bookedIndex++]);
        }

        if (walkInIndex < walkInPatients.length) {
          sortedQueue.push(walkInPatients[walkInIndex++]);
        }
      }

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
 * GET /api/stats/done-today
 * Returns count of patients with status DONE for the current local date
 */
app.get('/api/stats/done-today', async (req: Request, res: Response) => {
  try {
    // Use IST boundaries
    const { start: startOfDay, end: endOfDay } = getIstStartEnd();

    const count = await Patient.countDocuments({
      status: 'DONE',
      completedAt: { $gte: startOfDay, $lt: endOfDay },
    });

    res.json({ count });
  } catch (error) {
    console.error('Error fetching done-today count:', error);
    res.status(500).json({ count: 0 });
  }
});

/**
 * POST /api/patients
 */
app.post('/api/patients', async (req: Request, res: Response) => {
  try {
    const { name, phone, type } = req.body;

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
      tokenNumber,
      type: type || 'WALK_IN',
      status: 'WAITING',
    });

    await patient.save();

    // Send WhatsApp message if enabled (default: true)
    const whatsappSent = await sendWhatsAppMessage(phone, tokenNumber, name);

    const queue = await getSortedQueue();
    const queueWithWaitTimes = calculateWaitTimes(queue);
    io.emit('QUEUE_UPDATE', queueWithWaitTimes);

    const response = {
      ...patient.toObject(),
      trackingLink: generateTrackingLink(tokenNumber),
      whatsappSent,
    };

    res.status(201).json(response);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'An error occurred',
    });
  }
});

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
 * PUT /api/patients/:id/status
 */
app.put('/api/patients/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const patient = await Patient.findByIdAndUpdate(
      req.params.id,
      { status },
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

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`\n🏥 Hospital Queue Server running on port ${PORT}`);
  console.log(`Socket.io is listening for client connections`);
});

export { app, io, Patient, getSortedQueue, calculateWaitTimes };
