import db from '../db.js';
import { randomUUID } from 'crypto';

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

function cloneTemplateAsRun(templateId: string, projectId: string | null): string | null {
  const template = db.prepare('SELECT * FROM workflows WHERE id = ? AND template_id IS NULL')
    .get(templateId) as Record<string, unknown> | undefined;
  if (!template) return null;

  const runNum = (db.prepare(
    'SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM workflows WHERE template_id = ?'
  ).get(templateId) as { next: number }).next;

  const runId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO workflows (id, name, jira_task_id, description, players, phases, status,
      current_phase, iteration, max_iterations, shared_context, initial_context,
      created_at, started_at, completed_at, error, target_repos, template_id, run_number)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, '', ?, ?, NULL, '', ?, ?, ?)
  `).run(
    runId,
    template.name, template.jira_task_id, template.description,
    template.players, template.phases,
    template.current_phase, template.iteration, template.max_iterations, template.shared_context,
    now, now,
    template.target_repos, templateId, runNum,
  );

  // Set project_id and inject recent learnings as initial context
  if (projectId) {
    db.prepare('UPDATE workflows SET project_id = ? WHERE id = ?').run(projectId, runId);

    const learnings = db.prepare(
      `SELECT content, workflow_name FROM project_learnings WHERE project_id = ? ORDER BY created_at DESC LIMIT 3`
    ).all(projectId) as { content: string; workflow_name: string }[];

    if (learnings.length > 0) {
      const ctx = [
        '## Recent Project Learnings',
        ...learnings.map((l, i) => `### ${i + 1}. From "${l.workflow_name}"\n${l.content.slice(0, 600)}${l.content.length > 600 ? '...' : ''}`),
        '---',
      ].join('\n\n');
      db.prepare('UPDATE workflows SET initial_context = ? WHERE id = ?').run(ctx, runId);
    }
  }

  // Clone steps, remap depends_on IDs
  const templateSteps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?')
    .all(templateId) as Record<string, unknown>[];
  const oldToNew = new Map<string, string>();
  for (const s of templateSteps) oldToNew.set(s.id as string, randomUUID());

  const insertStep = db.prepare(`
    INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
      executor_type, executor_id, executor_config, auto_advance, depends_on, created_at,
      status, result, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', NULL, NULL)
  `);

  const STEP_SPACING = 230;
  const START_Y = 80;
  const FIXED_X = 300;

  for (let i = 0; i < templateSteps.length; i++) {
    const s = templateSteps[i];
    const newId = oldToNew.get(s.id as string)!;
    const oldDeps: string[] = JSON.parse((s.depends_on as string) || '[]');
    const newDeps = oldDeps.map((d) => oldToNew.get(d)).filter(Boolean);
    insertStep.run(
      newId, runId, s.name, s.description,
      FIXED_X, START_Y + i * STEP_SPACING,
      s.executor_type, s.executor_id, s.executor_config, s.auto_advance,
      JSON.stringify(newDeps), now,
    );
  }

  return runId;
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
  }).catch(() => {});

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

      // Budget gate: skip if project's goal has a cap and it's been reached
      if (projectId) {
        const proj = db.prepare('SELECT goal_id FROM projects WHERE id = ?').get(projectId) as { goal_id: string | null } | undefined;
        if (proj?.goal_id) {
          const goal = db.prepare('SELECT budget_usd FROM goals WHERE id = ?').get(proj.goal_id) as { budget_usd: number | null } | undefined;
          if (goal?.budget_usd) {
            const stepRows = db.prepare(`
              SELECT ws.dispatched_prompt, ws.result FROM workflow_steps ws
              JOIN workflows w ON ws.workflow_id = w.id WHERE w.project_id = ?
            `).all(projectId) as { dispatched_prompt: string; result: string }[];
            const spent = stepRows.reduce((s, r) =>
              s + (r.dispatched_prompt?.length || 0) / 4 / 1_000_000 * 3
                + (r.result?.length || 0) / 4 / 1_000_000 * 15, 0);
            if (spent >= goal.budget_usd) {
              console.warn(`[heartbeat] Skipping ${hb.id}: project ${projectId} over budget ($${spent.toFixed(3)} / $${goal.budget_usd})`);
              import('../ws.js').then(({ getIO }) => {
                getIO().emit('heartbeat_fired', {
                  heartbeatId: hb.id as string, runId: '', projectId, templateId,
                  label: `⚠️ Skipped — budget exceeded ($${spent.toFixed(2)} / $${goal.budget_usd})`,
                  firedAt: new Date().toISOString(), nextRunAt: computeNextRunAt(schedule),
                });
              }).catch(() => {});
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
      }).catch(() => {});

    } catch (err) {
      console.error(`[heartbeat] Error firing ${hb.id}:`, err instanceof Error ? err.message : err);
    }
  }
}
