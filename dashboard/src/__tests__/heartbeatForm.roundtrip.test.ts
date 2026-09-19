import { describe, it, expect } from 'vitest';
import type { Heartbeat } from '@neoncore/client';
import { CADENCES, CADENCE_LABEL, formFieldsFromSchedule, scheduleFromFormFields } from '../lib/heartbeatForm';

/**
 * EDITING A SCHEDULE MUST NOT CHANGE WHAT IT IS.
 *
 * The Projects edit form offered Hourly / Daily / Weekly while the server has six cadences.
 * A monthly schedule opened there showed a `<select>` whose value matched no option, so the
 * browser rendered the first one — Hourly — and saving without touching Frequency rewrote it.
 * `dayOfMonth` was never carried either. Nothing errors; the schedule just starts firing every
 * hour, which is the worst kind of bug to notice.
 *
 * SET-BASED OVER THE CADENCE REGISTRY. A round-trip test written for `daily` passes on a form
 * that destroys `quarterly`, which is exactly how this survived.
 */
describe('a schedule survives a trip through the edit form untouched', () => {
  const SCHEDULES: Record<string, Heartbeat['schedule']> = {
    once: { type: 'once' },
    hourly: { type: 'hourly' },
    daily: { type: 'daily', time: '09:10' },
    weekly: { type: 'weekly', time: '07:30', day: 4 },
    monthly: { type: 'monthly', time: '06:00', dayOfMonth: 12 },
    quarterly: { type: 'quarterly', time: '23:45', dayOfMonth: 28 },
  };

  it('covers every cadence the registry defines', () => {
    expect(Object.keys(SCHEDULES).sort()).toEqual([...CADENCES].sort());
    for (const c of CADENCES) expect(CADENCE_LABEL[c], `no label for ${c}`).toBeTruthy();
  });

  for (const cadence of CADENCES) {
    it(`${cadence} round-trips unchanged`, () => {
      const original = SCHEDULES[cadence];
      const back = scheduleFromFormFields(formFieldsFromSchedule(original));
      expect(back).toEqual(original);
    });
  }

  it('does not smuggle fields a cadence has no use for', () => {
    // A daily schedule carrying dayOfMonth reads as monthly to anyone inspecting the row.
    const daily = scheduleFromFormFields({
      scheduleType: 'daily', scheduleTime: '09:00', scheduleDay: 3, scheduleDayOfMonth: 17,
    });
    expect(daily).toEqual({ type: 'daily', time: '09:00' });
  });
});
