import mongoose, { Schema, Document } from 'mongoose';
import { IDoctor } from '../types/doctor';

export type IDoctorDocument = IDoctor & Document;

const doctorSchema = new Schema<IDoctorDocument>(
  {
    doctorId: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
    },
    specialization: {
      type: String,
      required: true,
    },
    roomNumber: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IDoctorDocument>('Doctor', doctorSchema);
