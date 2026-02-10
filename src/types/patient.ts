export interface IPatient {
  _id?: string;
  name: string;
  phone: string;
  email?: string;
  tokenNumber: number;
  type: 'BOOKED' | 'WALK_IN';
  status: 'WAITING' | 'IN_PROGRESS' | 'DONE';
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
