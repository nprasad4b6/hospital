import mongoose, { Schema, Document } from 'mongoose';
import { IPatient } from '../types/patient';

export type IPatientDocument = IPatient & Document;

const patientSchema = new Schema<IPatientDocument>({
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  email: {
    type: String,
  },
  tokenNumber: {
    type: Number,
    required: true,
  },
  type: {
    type: String,
    enum: ['BOOKED', 'WALK_IN'],
    default: 'WALK_IN',
    required: true,
  },
  status: {
    type: String,
    enum: ['WAITING', 'IN_PROGRESS', 'DONE'],
    default: 'WAITING',
    required: true,
  },
  department: {
    type: String,
    default: 'General',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  startedAt: Date,
  completedAt: Date,
});

// Compound unique index: tokenNumber is unique per day (by createdAt)
patientSchema.index({ tokenNumber: 1, createdAt: 1 }, { unique: true });

export default mongoose.model<IPatientDocument>('Patient', patientSchema);
