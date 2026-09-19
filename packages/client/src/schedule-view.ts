/**
 * Which schedules belong in a list of things that are going to happen.
 *
 * Reported as "I just tried to start a daily scheduled task with repeat on, but it doesn't
 * even show in the list of tasks". Nothing was broken underneath — the heartbeat was created,
 * armed, fired on time and re-armed. It was invisible: schedules were listed only in a
 * per-project modal and in the per-template popover that created them, and neither is the
 * list you are looking at after you click Run.
 *
 * Shared for the same reason as queue-view and confer-view: the rule is needed wherever
 * upcoming work is shown, and a copy per surface is how one of them stays wrong.
 */

export interface ArmableSchedule {
  active: boolean;
  nextRunAt: string;
}

/** Epoch ms for sorting. An unparseable date sorts LAST rather than disappearing. */
function nextRunMs(s: ArmableSchedule): number {
  const t = Date.parse(s.nextRunAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * The schedules that will still fire, soonest first.
 *
 * INACTIVE ONES ARE DROPPED, and that is what makes the list readable: a "Schedule this run"
 * with Repeat unticked is stored as cadence `once` and deactivated the moment it fires, so
 * keeping it would fill the list with things that already happened. Recent RUNS are the record
 * of those; this list answers "what is still coming".
 *
 * A schedule whose `nextRunAt` will not parse is KEPT, sorted last. Hiding it would make a
 * real, armed schedule invisible, which is the bug this exists to fix — better an odd-looking
 * row than a silent one.
 */
export function armedSchedules<T extends ArmableSchedule>(schedules: readonly T[]): T[] {
  return schedules
    .filter((s) => s.active)
    .slice()
    .sort((a, b) => nextRunMs(a) - nextRunMs(b));
}

/** How long until it fires, as short text. Empty when the date is unusable. */
export function untilNextRun(schedule: ArmableSchedule, now: number = Date.now()): string {
  const t = Date.parse(schedule.nextRunAt);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((t - now) / 60000);
  if (mins < 0) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
