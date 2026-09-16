import dayjs from 'dayjs';
import { ActivityCategory, ACTIVITY_CATEGORY_LABELS } from '../constants/activity';
import { GoalStatus, GOAL_STATUS_LABELS } from '../constants/goal';
import { RecurrenceFrequency, RECURRENCE_FREQUENCY_LABELS } from '../constants/recurrence';

export function formatDate(value?: string) {
  return value ? dayjs(value).format('YYYY-MM-DD') : '-';
}

export function formatMoney(value: number) {
  return `¥${value.toFixed(2)}`;
}

export function formatCarbon(value: number | string | undefined) {
  return `${Number(value || 0).toFixed(2)} kg CO2e`;
}

export function formatGoalStatus(status: GoalStatus) {
  return GOAL_STATUS_LABELS[status] || status;
}

export function formatActivityCategory(category: ActivityCategory) {
  return ACTIVITY_CATEGORY_LABELS[category] || category;
}

export function formatFrequency(frequency: RecurrenceFrequency) {
  return RECURRENCE_FREQUENCY_LABELS[frequency] || frequency;
}

export function formatTemplateState(enabled: boolean, pausedAt?: string | null) {
  if (!enabled) return '未启用';
  return pausedAt ? '已暂停' : '进行中';
}

export function formatDateRange(start: string, end?: string | null) {
  return `${formatDate(start)} ~ ${end ? formatDate(end) : '长期'}`;
}

