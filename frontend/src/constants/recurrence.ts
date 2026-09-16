export enum RecurrenceFrequency {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly'
}

export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  [RecurrenceFrequency.DAILY]: '每天',
  [RecurrenceFrequency.WEEKLY]: '每周',
  [RecurrenceFrequency.MONTHLY]: '每月'
};

export enum RecomputeMode {
  FUTURE = 'future',
  REBUILD = 'rebuild'
}

export const RECOMPUTE_MODE_LABELS: Record<RecomputeMode, string> = {
  [RecomputeMode.FUTURE]: '只影响后续（保留已有记录）',
  [RecomputeMode.REBUILD]: '重算未手工调整的已生成记录'
};
