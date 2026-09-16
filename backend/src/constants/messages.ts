export const Messages = {
  USER_CREATED: 'User created and demo CarbonTrack session opened',
  USER_LOGIN_OK: 'User login accepted',
  USER_PROFILE_UPDATED: 'User profile saved',
  ACTIVITY_CREATED: 'Activity carbon value calculated and stored',
  ACTIVITY_UPDATED: 'Activity carbon record updated',
  ACTIVITY_DELETED: 'Activity removed from carbon ledger',
  GOAL_CREATED: 'Goal created and progress linked to activities',
  GOAL_UPDATED: 'Goal status updated',
  TEMPLATE_CREATED: 'Recurring activity template stored',
  TEMPLATE_UPDATED: 'Recurring activity template updated and ledger reconciled',
  TEMPLATE_ENABLED: 'Recurring template enabled and backfilled through today',
  TEMPLATE_PAUSED: 'Recurring template frozen at the pause boundary',
  TEMPLATE_RESUMED: 'Recurring template resumed and re-anchored at resume day',
  TEMPLATE_DELETED: 'Recurring template removed, generated activities kept as manual records',
  FACTOR_CREATED: 'Carbon factor stored for region matching',
  AUDIT_LOGGED: 'Audit log captured',
  BACKEND_SHARED: 'Shared backend/frontend copy used by coupled message constants'
} as const;
