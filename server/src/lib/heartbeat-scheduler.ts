import db from '../db.js';
import { goalCostUsd } from './goal-cost.js';
import { cartridgeExists } from './cartridge-exists.js';
import { DEFAULT_AUTONOMY } from './autonomy.js';
// One copy of template→run, shared with decomposition. Two would be two chances to diverge
// on the step dependency remap, which is the part that silently produces a run that never advances.
import { cloneTemplateAsRun } from './workflow-from-template.js';

/**
 * The cadences a workflow can repeat on.
 *
 * Was hourly/daily/weekly. Monthly and quarterly are the intervals a review, an audit or a
 * dependency sweep actually run on, and without them "put this on automation" meant "or run it
 * by hand every quarter", which is the thing being automated.
 */
/**
 * `once` is the unchecked "Repeat?" box: scheduled for a time, and then finished.
 *
 * Without it there is no way to store "run this at 6am tomorrow and stop", and the box would
 * have to be persisted as something that DOES repeat — the worst possible misreading of it.
 * A `once` heartbeat is deactivated the moment it fires.
 */
export const SCHEDULE_TYPES = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'quarterly'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export interface HeartbeatSchedule {
  type: ScheduleType;
  time?: string;        // "HH:MM" for everything but hourly
  day?: number;         // 0 = Sun … 6 = Sat, for weekly
  dayOfMonth?: number;  // 1–31, for monthly and quarterly. Clamped to the month's last day.
}

export function isScheduleType(v: unknown): v is ScheduleType {
  return typeof v === 'string' && (SCHEDULE_TYPES as readonly string[]).includes(v);
}

/**
 * Set the day of a month, CLAMPED to that month's length.
 *
 * `setDate(31)` in a 30-day month silently rolls into the next one, so a "1st of the month"
 * heartbeat asked for the 31st would fire on the 1st — the classic off-by-one that makes a
 * schedule look random.
 */
function setClampedDate(d: Date, dayOfMonth: number): void {
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(Math.max(1, dayOfMonth), lastDay));
}

export function computeNextRunAt(schedule: HeartbeatSchedule, from: Date = new Date()): string {
  const now = new Date(from);

  if (schedule.type === 'hourly') {
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  }

  const [h, m] = (schedule.time || '09:00').split(':').map(Number);

  if (schedule.type === 'daily') {
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (schedule.type === 'weekly') {
    const targetDay = schedule.day ?? 1;
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    const daysUntil = (targetDay - now.getDay() + 7) % 7;
    next.setDate(next.getDate() + (daysUntil === 0 && next <= now ? 7 : daysUntil));
    return next.toISOString();
  }

  if (schedule.type === 'monthly' || schedule.type === 'quarterly') {
    const step = schedule.type === 'quarterly' ? 3 : 1;
    const dayOfMonth = schedule.dayOfMonth ?? 1;
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    setClampedDate(next, dayOfMonth);
    // Already gone this period — advance whole months, re-clamping because the target month
    // may be shorter than this one.
    if (next <= now) {
      next.setDate(1);                                   // avoid rolling while we move months
      next.setMonth(next.getMonth() + step);
      setClampedDate(next, dayOfMonth);
    }
    return next.toISOString();
  }

  // A one-off has no NEXT run. Answering this question at all would turn it into a repeating
  // schedule, which is precisely what the unchecked Repeat box said not to do. The fire path
  // deactivates it instead of asking.
  if (schedule.type === 'once') {
    throw new Error('A once schedule does not repeat — it is deactivated after it fires');
  }

  // REFUSE rather than default. This used to return "an hour from now" for anything it did not
  // recognise, so a typo in a cadence became a job firing 24 times a day — and the only symptom
  // was a schedule that looked possessed.
  throw new Error(
    `Unknown schedule cadence "${String((schedule as { type?: unknown }).type)}" — expected one of ${SCHEDULE_TYPES.join(', ')}`,
  );
}

const ORDINAL = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export function formatScheduleLabel(schedule: HeartbeatSchedule): string {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const at = schedule.time || '09:00';
  if (schedule.type === 'once') return `Once at ${at}`;
  if (schedule.type === 'hourly') return 'Every hour';
  if (schedule.type === 'daily') return `Daily at ${at}`;
  if (schedule.type === 'weekly') return `Every ${DAYS[schedule.day ?? 1]} at ${at}`;
  if (schedule.type === 'monthly') return `Monthly on the ${ORDINAL(schedule.dayOfMonth ?? 1)} at ${at}`;
  if (schedule.type === 'quarterly') return `Every 3 months on the ${ORDINAL(schedule.dayOfMonth ?? 1)} at ${at}`;
  return 'Unknown schedule';
}



/**
 * Everything a fire needs, and whether it can happen at all — shared by BOTH fire paths.
 *
 * There are two ("fire now" and the 60s timer) and they had two copies of the firing logic, so
 * a fix to one was invisible from the other. This is the copy.
 *
 * IT REFUSES BEFORE CLONING. The manual launch path validates at the door and says why —
 * "validate while a human is watching". The scheduled path is the one where NOBODY is watching,
 * and it validated nothing: it cloned the template, marked the run `running`, and left it to die
 * on its first dispatch. Refusing early means a heartbeat pointed at a cartridge that has been
 * removed produces a visible skip instead of a corpse.
 */
/**
 * What happens to a schedule after it fires.
 *
 * A repeating one re-arms for its next occurrence. A `once` is FINISHED: it keeps its time for
 * the record and goes inactive, because the alternative — leaving it active with a past
 * next_run_at — makes it fire on every 60s tick forever.
 */
function reArm(schedule: HeartbeatSchedule): { nextRunAt: string; stillActive: boolean } {
  if (schedule.type === 'once') {
    return { nextRunAt: new Date().toISOString(), stillActive: false };
  }
  return { nextRunAt: computeNextRunAt(schedule), stillActive: true };
}

function prepareFire(hb: Record<string, unknown>):
  { ok: true; templateId: string; projectId: string | null; agentId: string; autonomy: string; schedule: HeartbeatSchedule; initialContext: string }
  | { ok: false; reason: string } {
  const templateId = hb.template_id as string;
  const projectId = (hb.project_id as string) || null;
  const agentId = ((hb.agent_id as string) || '').trim();
  const autonomy = ((hb.autonomy as string) || DEFAULT_AUTONOMY).trim() || DEFAULT_AUTONOMY;
  let schedule: HeartbeatSchedule;
  try { schedule = JSON.parse((hb.schedule as string) || '{}'); } catch { schedule = { type: 'daily' }; }

  if (!db.prepare('SELECT id FROM workflows WHERE id = ? AND template_id IS NULL').get(templateId)) {
    return { ok: false, reason: `template ${templateId} no longer exists` };
  }
  if (!agentId) {
    return { ok: false, reason: 'no cartridge is configured — a scheduled run has nobody to ask at 09:00' };
  }
  if (!cartridgeExists(agentId)) {
    return { ok: false, reason: `its cartridge no longer exists (${agentId.slice(0, 8)}) — it was restarted, or removed` };
  }
  const initialContext = ((hb.initial_context as string) || '').trim();
  return { ok: true, templateId, projectId, agentId, autonomy, schedule, initialContext };
}

/** Announce a skip. A heartbeat that silently never fires looks exactly like one that works. */
function announceSkip(hb: Record<string, unknown>, reason: string, nextRunAt: string): void {
  console.warn(`[heartbeat] SKIPPED ${hb.label || hb.id}: ${reason}`);
  import('../ws.js').then(({ getIO }) => {
    getIO().emit('heartbeat_fired', {
      heartbeatId: hb.id as string, runId: '',
      projectId: (hb.project_id as string) || null, templateId: hb.template_id as string,
      label: `⚠️ Skipped — ${reason}`,
      firedAt: new Date().toISOString(), nextRunAt,
    });
  }).catch((err) => console.error('[heartbeat] emit failed:', err));
}

export function fireHeartbeat(heartbeatId: string): { runId: string } | { error: string } {
  const hb = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(heartbeatId) as Record<string, unknown> | undefined;
  if (!hb) return { error: 'Heartbeat not found' };

  const prep = prepareFire(hb);
  if (!prep.ok) {
    // Refuse BEFORE cloning, and advance the schedule so a broken heartbeat does not re-refuse
    // on every 60s tick forever.
    const nextRunAt = reArm(JSON.parse((hb.schedule as string) || '{}')).nextRunAt;
    db.prepare('UPDATE heartbeats SET next_run_at = ? WHERE id = ?').run(nextRunAt, heartbeatId);
    announceSkip(hb, prep.reason, nextRunAt);
    return { error: `Heartbeat cannot fire — ${prep.reason}` };
  }
  const { templateId, projectId, agentId, autonomy, schedule, initialContext } = prep;

  const runId = cloneTemplateAsRun(templateId, projectId, initialContext, { agentId, autonomy });
  if (!runId) return { error: `Template ${templateId} not found` };

  const now = new Date().toISOString();
  const { nextRunAt, stillActive } = reArm(schedule);
  db.prepare('UPDATE heartbeats SET last_run_at = ?, next_run_at = ?, active = ? WHERE id = ?')
    .run(now, nextRunAt, stillActive ? 1 : 0, heartbeatId);

  import('../ws.js').then(({ getIO }) => {
    getIO().emit('heartbeat_fired', {
      heartbeatId, runId, projectId, templateId, label: hb.label, firedAt: now, nextRunAt,
    });
  }).catch((err) => console.error('[heartbeat] emit failed:', err));

  console.log(`[heartbeat] Manual fire: ${hb.label || heartbeatId} → run ${runId}`);
  return { runId };
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startHeartbeatScheduler(): void {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(checkDueHeartbeats, 60_000);
  console.log('[heartbeat] Scheduler started — polling every 60s');
}

export function stopHeartbeatScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

/**
 * What one sweep did. Returned rather than only logged, because "the scheduler skipped your
 * 09:00 heartbeat and told nobody" is the failure mode this whole file exists to prevent — and a
 * websocket emit is fire-and-forget, so it is not something a caller (or a test) can rely on.
 */
export interface SweepResult {
  fired: { heartbeatId: string; runId: string }[];
  skipped: { heartbeatId: string; reason: string }[];
}

export function checkDueHeartbeats(): SweepResult {
  const result: SweepResult = { fired: [], skipped: [] };
  const now = new Date().toISOString();
  const due = db.prepare(
    "SELECT * FROM heartbeats WHERE active = 1 AND next_run_at <= ?"
  ).all(now) as Record<string, unknown>[];

  for (const hb of due) {
    try {
      const prep = prepareFire(hb);
      if (!prep.ok) {
        const skipNext = reArm(JSON.parse((hb.schedule as string) || '{}')).nextRunAt;
        db.prepare('UPDATE heartbeats SET next_run_at = ? WHERE id = ?').run(skipNext, hb.id);
        announceSkip(hb, prep.reason, skipNext);
        result.skipped.push({ heartbeatId: hb.id as string, reason: prep.reason });
        continue;
      }
      const { templateId, projectId, agentId, autonomy, schedule, initialContext } = prep;

      // USD budget gate: skip if the project's goal has a dollar cap and the
      // goal's real spend (session_usage cost across its cartridges) has reached it.
      if (projectId) {
        const proj = db.prepare('SELECT goal_id FROM projects WHERE id = ?').get(projectId) as { goal_id: string | null } | undefined;
        if (proj?.goal_id) {
          const goal = db.prepare('SELECT budget_usd FROM goals WHERE id = ?').get(proj.goal_id) as { budget_usd: number | null } | undefined;
          if (goal?.budget_usd) {
            const spent = goalCostUsd(proj.goal_id);
            if (spent >= goal.budget_usd) {
              console.warn(`[heartbeat] Skipping ${hb.id}: goal ${proj.goal_id} over budget ($${spent.toFixed(2)} / $${goal.budget_usd})`);
              import('../ws.js').then(({ getIO }) => {
                getIO().emit('heartbeat_fired', {
                  heartbeatId: hb.id as string, runId: '', projectId, templateId,
                  label: `⚠️ Skipped — budget exceeded ($${spent.toFixed(2)} / $${goal.budget_usd!.toFixed(2)})`,
                  firedAt: new Date().toISOString(), nextRunAt: computeNextRunAt(schedule),
                });
              }).catch((err) => console.error('[heartbeat] emit failed:', err));
              db.prepare('UPDATE heartbeats SET next_run_at = ? WHERE id = ?')
                .run(computeNextRunAt(schedule), hb.id);
              result.skipped.push({ heartbeatId: hb.id as string, reason: `goal over budget ($${spent.toFixed(2)} / $${goal.budget_usd})` });
              continue;
            }
          }
        }
      }

      const runId = cloneTemplateAsRun(templateId, projectId, initialContext, { agentId, autonomy });
      if (!runId) {
        console.warn(`[heartbeat] Template ${templateId} not found for heartbeat ${hb.id}`);
        continue;
      }

      const { nextRunAt, stillActive } = reArm(schedule);
      db.prepare('UPDATE heartbeats SET last_run_at = ?, next_run_at = ?, active = ? WHERE id = ?')
        .run(now, nextRunAt, stillActive ? 1 : 0, hb.id);

      result.fired.push({ heartbeatId: hb.id as string, runId });
      console.log(`[heartbeat] Fired ${hb.label || hb.id} → run ${runId} (next: ${nextRunAt})`);

      import('../ws.js').then(({ getIO }) => {
        getIO().emit('heartbeat_fired', {
          heartbeatId: hb.id as string,
          runId,
          projectId,
          templateId,
          label: hb.label,
          firedAt: now,
          nextRunAt,
        });
      }).catch((err) => console.error('[heartbeat] emit failed:', err));

    } catch (err) {
      console.error(`[heartbeat] Error firing ${hb.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return result;
}
