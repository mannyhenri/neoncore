import db from '../db.js';
import { goalCostUsd } from './goal-cost.js';
// One copy of template→run, shared with decomposition. Two would be two chances to diverge
// on the step dependency remap, which is the part that silently produces a run that never advances.
import { cloneTemplateAsRun } from './workflow-from-template.js';

export interface HeartbeatSchedule {
  type: 'hourly' | 'daily' | 'weekly';
  time?: string;   // "HH:MM" for daily/weekly
  day?: number;    // 0 = Sun … 6 = Sat, for weekly
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

  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}

export function formatScheduleLabel(schedule: HeartbeatSchedule): string {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (schedule.type === 'hourly') return 'Every hour';
  if (schedule.type === 'daily') return `Daily at ${schedule.time || '09:00'}`;
  if (schedule.type === 'weekly') return `Every ${DAYS[schedule.day ?? 1]} at ${schedule.time || '09:00'}`;
  return 'Unknown schedule';
}


export function fireHeartbeat(heartbeatId: string): { runId: string } | { error: string } {
  const hb = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(heartbeatId) as Record<string, unknown> | undefined;
  if (!hb) return { error: 'Heartbeat not found' };

  const projectId = (hb.project_id as string) || null;
  const templateId = hb.template_id as string;
  const schedule: HeartbeatSchedule = JSON.parse((hb.schedule as string) || '{}');

  const runId = cloneTemplateAsRun(templateId, projectId);
  if (!runId) return { error: `Template ${templateId} not found` };

  const now = new Date().toISOString();
  const nextRunAt = computeNextRunAt(schedule);
  db.prepare('UPDATE heartbeats SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, nextRunAt, heartbeatId);

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

function checkDueHeartbeats(): void {
  const now = new Date().toISOString();
  const due = db.prepare(
    "SELECT * FROM heartbeats WHERE active = 1 AND next_run_at <= ?"
  ).all(now) as Record<string, unknown>[];

  for (const hb of due) {
    try {
      const projectId = (hb.project_id as string) || null;
      const templateId = hb.template_id as string;
      const schedule: HeartbeatSchedule = JSON.parse((hb.schedule as string) || '{}');

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
              continue;
            }
          }
        }
      }

      const runId = cloneTemplateAsRun(templateId, projectId);
      if (!runId) {
        console.warn(`[heartbeat] Template ${templateId} not found for heartbeat ${hb.id}`);
        continue;
      }

      const nextRunAt = computeNextRunAt(schedule);
      db.prepare('UPDATE heartbeats SET last_run_at = ?, next_run_at = ? WHERE id = ?')
        .run(now, nextRunAt, hb.id);

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
}
