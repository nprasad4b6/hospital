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
  return queue.map((patient, index) => {
    const position =
      patient.status === 'IN_PROGRESS' ? 0 : index;
    const estimatedWaitTime = position * 15;
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
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);

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
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

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

    const lastPatient = await Patient.findOne().sort({ tokenNumber: -1 });
    const tokenNumber = (lastPatient?.tokenNumber || 0) + 1;

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
