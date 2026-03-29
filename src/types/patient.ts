export interface IPatient {
  _id?: string;
  name: string;
  phone: string;
  age?: number;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  email?: string;
  tokenNumber: number;
  type: 'BOOKED' | 'WALK_IN';
  status: 'WAITING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED' | 'ON_HOLD' | 'SENT_FOR_TEST';
  guardianName?: string;
  relation?: 'Father' | 'Mother' | 'Guardian' | 'Spouse';
  address?: string;
  doctorId?: string;
  department?: string;
  createdAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  position?: number;
  estimatedWaitTime?: number;
}

export interface IQueueItem extends IPatient {
  position: number;
  estimatedWaitTime: number;
}
