/**
 * "Schedule this run" and "Repeat?" — the two options that sit beside the Run button.
 *
 * Scheduling belongs IN the launch form, not on the template row. The form is where the
 * cartridge, the context, the prompt answers and the attachments are chosen; a control outside
 * it can only schedule a bare template, which is a different and much weaker thing. Ticking
 * "Schedule this run" turns the green button from *run now* into *run then*, and nothing else
 * about the form changes.
 *
 * FOUR STATES, all reachable, each meaning something distinct:
 *   neither            run now
 *   schedule only      run ONCE at the chosen time, then finished
 *   schedule + repeat  first run at the chosen time, then on the cadence
 *   repeat only        start now and keep repeating
 *
 * ONE COMPONENT, used by both launch forms. Every other pair of launch controls in this
 * codebase drifted apart — the confer gate lived twice and was fixed once, twice — so this is
 * shared rather than mirrored.
 */
import { useState } from 'react';

export type RepeatCadence = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export interface LaunchScheduleValue {
  /** Ticked "Schedule this run" — the green button now schedules instead of starting. */
  scheduled: boolean;
  /** Ticked "Repeat?" — without it a scheduled run fires once and is done. */
  repeating: boolean;
  cadence: RepeatCadence;
  /** Local datetime-local string for the FIRST run. Empty when not scheduled. */
  firstRunAt: string;
  weekday: number;
  dayOfMonth: number;
}

export const emptySchedule = (): LaunchScheduleValue => ({
  scheduled: false,
  repeating: false,
  cadence: 'daily',
  firstRunAt: '',
  weekday: 1,
  dayOfMonth: 1,
});

/** Does this configuration mean "do not run now"? */
export const isScheduledLaunch = (v: LaunchScheduleValue): boolean => v.scheduled || v.repeating;

/**
 * The payload for POST /heartbeats. `once` is the unchecked Repeat box — without it the
 * server would have to store a non-repeating schedule as something that repeats.
 */
export type ScheduleKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'quarterly';

export function scheduleRequest(v: LaunchScheduleValue): {
  schedule: { type: ScheduleKind; time?: string; day?: number; dayOfMonth?: number };
  firstRunAt?: string;
} {
  const first = v.scheduled && v.firstRunAt ? new Date(v.firstRunAt) : null;
  // The cadence's time-of-day comes from the chosen first run, so "repeat daily" after a
  // 06:30 first run means 06:30 daily — not the 09:00 default, which nobody asked for.
  const hh = first ? String(first.getHours()).padStart(2, '0') : '09';
  const mm = first ? String(first.getMinutes()).padStart(2, '0') : '00';
  const time = `${hh}:${mm}`;

  if (!v.repeating) {
    return { schedule: { type: 'once' }, ...(first ? { firstRunAt: first.toISOString() } : {}) };
  }
  return {
    schedule: {
      type: v.cadence,
      time,
      ...(v.cadence === 'weekly' ? { day: v.weekday } : {}),
      ...(v.cadence === 'monthly' || v.cadence === 'quarterly' ? { dayOfMonth: v.dayOfMonth } : {}),
    },
    ...(first ? { firstRunAt: first.toISOString() } : {}),
  };
}

/** What the button should say, so the control and the action never disagree. */
export function launchButtonLabel(v: LaunchScheduleValue, busy: boolean): string {
  if (busy) return 'Saving…';
  if (!isScheduledLaunch(v)) return 'Run Workflow';
  if (v.repeating && v.scheduled) return 'Schedule & Repeat';
  if (v.repeating) return 'Start & Repeat';
  return 'Schedule Run';
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function LaunchSchedule({ value, onChange }: {
  value: LaunchScheduleValue;
  onChange: (v: LaunchScheduleValue) => void;
}) {
  const [id] = useState(() => Math.random().toString(36).slice(2, 8));
  const set = (patch: Partial<LaunchScheduleValue>) => onChange({ ...value, ...patch });
  const sel = 'text-xs glass-input text-gray-300 rounded px-2 py-1 focus:outline-none';

  return (
    <div className="space-y-2 pt-1">
      {/* ── Schedule this run ── */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[13px] text-gray-400 cursor-pointer">
          <input
            id={`sched-${id}`}
            type="checkbox"
            checked={value.scheduled}
            onChange={(e) => set({
              scheduled: e.target.checked,
              // Default to an hour from now, rounded to the next half hour — a datetime field
              // that opens empty makes you type a date to discover what format it wants.
              firstRunAt: e.target.checked && !value.firstRunAt ? defaultFirstRun() : value.firstRunAt,
            })}
            className="accent-emerald-500"
          />
          Schedule this run
        </label>
        {value.scheduled && (
          <input
            type="datetime-local"
            value={value.firstRunAt}
            onChange={(e) => set({ firstRunAt: e.target.value })}
            aria-label="First run"
            className={sel}
          />
        )}
      </div>

      {/* ── Repeat? ── */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[13px] text-gray-400 cursor-pointer">
          <input
            id={`rep-${id}`}
            type="checkbox"
            checked={value.repeating}
            onChange={(e) => set({ repeating: e.target.checked })}
            className="accent-emerald-500"
          />
          Repeat?
        </label>
        {value.repeating && (
          <>
            <select value={value.cadence} onChange={(e) => set({ cadence: e.target.value as RepeatCadence })} className={sel}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
            </select>
            {value.cadence === 'weekly' && (
              <select value={value.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} className={sel}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            {(value.cadence === 'monthly' || value.cadence === 'quarterly') && (
              <select value={value.dayOfMonth} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })} className={sel}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>day {d}</option>)}
              </select>
            )}
          </>
        )}
      </div>

      {/* Say what the button is about to do. The four states are easy to mix up, and a green
          button that does something other than what you expected is the whole complaint. */}
      {isScheduledLaunch(value) && (
        <p className="text-[11px] text-gray-500">{describe(value)}</p>
      )}
    </div>
  );
}

/** One hour from now, rounded up to the next half hour, as a datetime-local string. */
function defaultFirstRun(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describe(v: LaunchScheduleValue): string {
  const when = v.scheduled && v.firstRunAt
    ? new Date(v.firstRunAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'now';
  if (!v.repeating) return `Runs once, at ${when}. Nothing repeats.`;
  const every = v.cadence === 'weekly' ? `every ${DAYS[v.weekday]}`
    : v.cadence === 'monthly' ? `on day ${v.dayOfMonth} of each month`
    : v.cadence === 'quarterly' ? `on day ${v.dayOfMonth}, every 3 months`
    : 'every day';
  return `First run ${when}, then ${every}.`;
}
