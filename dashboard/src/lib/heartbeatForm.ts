import type { Heartbeat } from '@neoncore/client';

/**
 * Moving a schedule between the edit form and the wire, without losing what it was.
 *
 * Extracted from GoalsPage so it can be round-tripped in a test. The form there offered three
 * cadences — Hourly, Daily, Weekly — while the server has had six since `once`, `monthly` and
 * `quarterly` arrived. Opening a MONTHLY schedule therefore showed a `<select>` whose value
 * matched no option, so the browser displayed the first one (Hourly), and saving without
 * touching Frequency rewrote a quarterly schedule as hourly. It also never carried
 * `dayOfMonth`, so the day was dropped on the way through.
 *
 * Silent, and destructive: nothing errors, the schedule just starts firing every hour.
 *
 * THE RULE THESE TWO KEEP: load a schedule, save it untouched, get the same schedule back —
 * for every member of the cadence registry, not the three someone had in mind.
 */

export type Cadence = Heartbeat['schedule']['type'];

/** Every cadence the server accepts, in the order a person reads them. */
export const CADENCES: readonly Cadence[] = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'quarterly'];

export const CADENCE_LABEL: Record<Cadence, string> = {
  once: 'Once', hourly: 'Hourly', daily: 'Daily',
  weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly',
};

export interface ScheduleFormFields {
  scheduleType: Cadence;
  scheduleTime: string;
  scheduleDay: number;
  scheduleDayOfMonth: number;
}

/** Form fields for an existing schedule. Defaults only fill what the schedule does not say. */
export function formFieldsFromSchedule(schedule: Heartbeat['schedule']): ScheduleFormFields {
  return {
    scheduleType: schedule.type,
    scheduleTime: schedule.time || '09:00',
    scheduleDay: schedule.day ?? 1,
    scheduleDayOfMonth: schedule.dayOfMonth ?? 1,
  };
}

/**
 * The wire shape for what the form holds.
 *
 * Each cadence carries only the fields it uses, matching what the server stores — a `daily`
 * schedule with a stray `dayOfMonth` would read as a monthly one to anybody inspecting it.
 */
export function scheduleFromFormFields(f: ScheduleFormFields): Heartbeat['schedule'] {
  return {
    type: f.scheduleType,
    ...(f.scheduleType !== 'hourly' && f.scheduleType !== 'once' ? { time: f.scheduleTime } : {}),
    ...(f.scheduleType === 'weekly' ? { day: f.scheduleDay } : {}),
    ...(f.scheduleType === 'monthly' || f.scheduleType === 'quarterly'
      ? { dayOfMonth: f.scheduleDayOfMonth } : {}),
  };
}
