import dayjs, { Dayjs } from 'dayjs';
import { RecurrenceFrequency } from '../constants/recurrence';

export const DATE_FORMAT = 'YYYY-MM-DD';
const MAX_STEPS = 366 * 12; // safety ceiling (~12 years of daily rows)

export interface OccurrenceWindow {
  frequency: RecurrenceFrequency;
  anchor: string; // phase origin 'YYYY-MM-DD'
  low: string; // inclusive lower bound
  high: string; // inclusive upper bound
}

function toDay(value: string): Dayjs {
  return dayjs(value, DATE_FORMAT).startOf('day');
}

/**
 * Enumerate occurrence dates in [low, high] for the cadence anchored at `anchor`.
 * - daily: every calendar day
 * - weekly: anchor + 7k (preserves the weekday phase)
 * - monthly: month k is always derived from the ORIGINAL anchor day-of-month,
 *   clamped to that month's length, so a 31st falls on the 28/30 of a short
 *   month and returns to 31 the next month. A clamped day is never fed back
 *   into the next iteration.
 * Strings only on the way in and out to stay timezone/Date-column independent.
 */
export function enumerateOccurrences({ frequency, anchor, low, high }: OccurrenceWindow): string[] {
  const anchorDay = toDay(anchor);
  const lowDay = toDay(low);
  const highDay = toDay(high);
  if (!anchorDay.isValid() || !lowDay.isValid() || !highDay.isValid()) return [];
  if (highDay.isBefore(lowDay)) return [];

  const dates: string[] = [];

  if (frequency === RecurrenceFrequency.DAILY) {
    let d = anchorDay.isBefore(lowDay) ? lowDay : anchorDay;
    for (let i = 0; i < MAX_STEPS && !d.isAfter(highDay); i += 1) {
      dates.push(d.format(DATE_FORMAT));
      d = d.add(1, 'day');
    }
    return dates;
  }

  if (frequency === RecurrenceFrequency.WEEKLY) {
    let d = anchorDay;
    if (d.isBefore(lowDay)) {
      const k = Math.floor(lowDay.diff(anchorDay, 'day') / 7);
      d = anchorDay.add(k * 7, 'day');
      while (d.isBefore(lowDay)) d = d.add(7, 'day');
    }
    for (let i = 0; i < MAX_STEPS && !d.isAfter(highDay); i += 1) {
      dates.push(d.format(DATE_FORMAT));
      d = d.add(7, 'day');
    }
    return dates;
  }

  // monthly: rebuild every month from the anchor, clamp day-of-month independently.
  const anchorDate = anchorDay.date();
  const firstMonthIndex =
    (lowDay.year() - anchorDay.year()) * 12 + (lowDay.month() - anchorDay.month());
  for (let m = Math.max(0, firstMonthIndex); m < MAX_STEPS; m += 1) {
    const monthBase = anchorDay.startOf('month').add(m, 'month');
    if (monthBase.isAfter(highDay)) break;
    const occurrence = monthBase.date(Math.min(anchorDate, monthBase.daysInMonth()));
    if (!occurrence.isBefore(lowDay) && !occurrence.isAfter(highDay)) {
      dates.push(occurrence.format(DATE_FORMAT));
    }
  }
  return dates;
}

export function formatDate(value: Dayjs | string): string {
  return dayjs(value).format(DATE_FORMAT);
}

/**
 * Strict 'YYYY-MM-DD' calendar validation. dayjs (and native Date) silently roll
 * an impossible date such as 2026-02-30 over to 2026-03-02, so existence must be
 * checked against the month's real length instead of relying on parse validity.
 */
export function isValidCalendarDate(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  // new Date(year, month, 0) is the last day of the 1-based `month`.
  return day <= new Date(year, month, 0).getDate();
}
