import { ActivityCategory } from '../constants/activity';
import { GoalStatus } from '../constants/goal';
import { RecurrenceFrequency } from '../constants/recurrence';

export interface User {
  id: number;
  username: string;
  email: string;
  avatar?: string | null;
  region: string;
  createdAt?: string;
  roles?: string[];
}

export interface CarbonFactor {
  id: number;
  category: ActivityCategory;
  subType: string;
  factorValue: string;
  unit: string;
  region: string;
  updatedAt: string;
}

export interface Activity {
  id: number;
  userId: number;
  factorId?: number | null;
  category: ActivityCategory;
  subType: string;
  amount: string;
  unit: string;
  carbonValue: string;
  recordDate: string;
  note?: string | null;
  factor?: CarbonFactor | null;
  templateId?: number | null;
  isGenerated?: boolean;
  manuallyAdjusted?: boolean;
}

export interface ActivityTemplate {
  id: number;
  userId: number;
  name: string;
  category: ActivityCategory;
  subType: string;
  amount: string;
  unit: string;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate?: string | null;
  anchorDate: string;
  effectiveDate: string;
  enabled: boolean;
  pausedAt?: string | null;
  lastSyncedDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  generatedCount?: number;
}

export interface Goal {
  id: number;
  userId: number;
  title: string;
  targetValue: string;
  periodType: string;
  startDate: string;
  endDate: string;
  status: GoalStatus;
  currentValue?: number;
  progress?: number;
}

export interface AuditLog {
  id: number;
  userId?: number | null;
  action: string;
  entity: string;
  entityId?: number | null;
  detail: string;
  ip?: string | null;
  createdAt: string;
}

export interface RankingItem {
  rank: number;
  userId: number;
  username: string;
  region: string;
  avatar?: string | null;
  totalCarbon: number;
}

