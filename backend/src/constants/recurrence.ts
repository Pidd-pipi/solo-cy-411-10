export enum RecurrenceFrequency {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly'
}

export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  [RecurrenceFrequency.DAILY]: 'Daily',
  [RecurrenceFrequency.WEEKLY]: 'Weekly',
  [RecurrenceFrequency.MONTHLY]: 'Monthly'
};

export enum GenerationStatus {
  GENERATED = 'generated',
  ADJUSTED = 'adjusted',
  DETACHED = 'detached',
  DELETED = 'deleted'
}

export enum RecomputeMode {
  FUTURE = 'future',
  REBUILD = 'rebuild'
}

export const ACTIVITY_TEMPLATE_ERROR_FIELDS = {
  FREQUENCY: 'ActivityTemplate.frequency',
  DATE_RANGE: 'ActivityTemplate.start_date',
  CATEGORY: 'ActivityTemplate.category',
  SUB_TYPE: 'ActivityTemplate.sub_type'
};
