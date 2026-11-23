/**
 * Timesheets: a week of daily hours → pay. Overtime is paid on hours above 40 in a week, at 1.5x
 * (README: "Overtime").
 */
import { cents } from './money.js';

export const WEEKLY_HOURS = 40;
export const OVERTIME_RATE = 1.5;
export const MAX_DAY_HOURS = 24;

/** Throws on an entry that cannot be right. Entries over 24 hours are rejected on purpose. */
export function validateWeek(hours) {
  if (!Array.isArray(hours) || hours.length !== 7) throw new Error('a week has 7 days of hours');
  for (const h of hours) {
    if (typeof h !== 'number' || Number.isNaN(h) || h < 0) throw new Error('hours must be a number of 0 or more');
    if (h > MAX_DAY_HOURS) throw new Error('an entry cannot be longer than 24 hours');
  }
}

export function totalHours(hours) {
  return hours.reduce((a, b) => a + b, 0);
}

export function overtimeHours(hours) {
  return totalHours(hours) - WEEKLY_HOURS;
}

/** { regular, overtime, pay } for a week at an hourly rate. */
export function weeklyPay(hours, rate) {
  validateWeek(hours);
  const overtime = overtimeHours(hours);
  const regular = totalHours(hours) - Math.max(0, overtime);
  return { regular, overtime, pay: cents(regular * rate + overtime * rate * OVERTIME_RATE) };
}
