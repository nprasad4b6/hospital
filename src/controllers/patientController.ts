import { Request, Response } from 'express';
import Patient from '../models/Patient';

export const callPatient = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { patientId } = req.body;

    if (!patientId) {
      return res.status(400).json({ message: 'patientId is required in req.body' });
    }

    await Patient.findOneAndUpdate(
      { status: 'IN_PROGRESS' },
      {
        status: 'COMPLETED',
        completedAt: new Date(),
      }
    );

    const updatedPatient = await Patient.findByIdAndUpdate(
      patientId,
      {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
      },
      { new: true }
    );

    if (!updatedPatient) {
      return res.status(404).json({ message: 'Patient not found' });
    }

    return res.status(200).json(updatedPatient);
  } catch (error) {
    return res.status(500).json({
      message: 'Failed to call patient',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
