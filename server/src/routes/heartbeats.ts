import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import {
  computeNextRunAt,
  formatScheduleLabel,
  fireHeartbeat,
  type HeartbeatSchedule,
} from '../lib/heartbeat-scheduler.js';
import { DEFAULT_AUTONOMY, isAutonomyLevel } from '../lib/autonomy.js';

const router = Router();

function normalizeHeartbeat(row: Record<string, unknown>) {
  const schedule: HeartbeatSchedule = JSON.parse((row.schedule as string) || '{}');
  const templateRow = db.prepare('SELECT name FROM workflows WHERE id = ? AND template_id IS NULL')
    .get(row.template_id as string) as { name: string } | undefined;
  const agentRow = row.agent_id
    ? db.prepare('SELECT name, repo_name FROM agents WHERE id = ?')
        .get(row.agent_id as string) as { name: string; repo_name: string } | undefined
    : undefined;

  return {
    id: row.id,
    projectId: row.project_id || null,
    templateId: row.template_id,
    templateName: templateRow?.name || null,
    agentId: row.agent_id || '',
    // The posture a scheduled run starts in. Defaults to DEFAULT_AUTONOMY — a schedule is a
    // launch you are not present for, not a weaker one.
    autonomy: (row.autonomy as string) || 'full',
    agentName: agentRow ? (agentRow.repo_name || agentRow.name) : null,
    schedule,
    scheduleLabel: formatScheduleLabel(schedule),
    label: row.label || '',
    active: Boolean(row.active),
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
}

router.get('/', (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const rows = projectId
    ? db.prepare('SELECT * FROM heartbeats WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[]
    : db.prepare('SELECT * FROM heartbeats ORDER BY created_at DESC').all() as Record<string, unknown>[];
  res.json(rows.map(normalizeHeartbeat));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Heartbeat not found' });
  res.json(normalizeHeartbeat(row));
});


/**
 * When this schedule first fires.
 *
 * `firstRunAt` comes from the launch form's "Schedule this run" control and wins outright. It
 * is only recomputed from the cadence when the form did not name a time — i.e. "Repeat" was
 * ticked on its own, which means "start now and keep going".
 */
function firstRunAtOrCadence(firstRunAt: unknown, schedule: HeartbeatSchedule): string {
  if (typeof firstRunAt === 'string' && firstRunAt.trim()) {
    const t = Date.parse(firstRunAt);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  // No time given. A one-off with no time is immediate; a cadence computes its next slot.
  if (schedule.type === 'once') return new Date().toISOString();
  return computeNextRunAt(schedule);
}

router.post('/', (req, res) => {
  const { projectId, templateId, agentId, schedule, label, active, autonomy, initialContext, firstRunAt } = req.body;
  if (!templateId?.trim()) return res.status(400).json({ error: 'templateId required' });

  const parsedSchedule: HeartbeatSchedule = schedule || { type: 'daily', time: '09:00' };
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO heartbeats (id, project_id, template_id, agent_id, schedule, label, active, autonomy, initial_context, last_run_at, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    projectId || null,
    templateId.trim(),
    agentId || '',
    JSON.stringify(parsedSchedule),
    label?.trim() || '',
    active !== false ? 1 : 0,
    isAutonomyLevel(String(autonomy || '')) ? autonomy : DEFAULT_AUTONOMY,
    typeof initialContext === 'string' ? initialContext : '',
    // The FIRST run is whatever the form picked, used verbatim. Recomputing it from the cadence
    // would quietly move a 6am one-off to the cadence's own slot — "Schedule this run" names a
    // time, and honouring a different one is the same as ignoring the control.
    firstRunAtOrCadence(firstRunAt, parsedSchedule),
    now,
  );

  const created = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(normalizeHeartbeat(created));
});

router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Heartbeat not found' });

  const { templateId, agentId, schedule, label, active, autonomy } = req.body;
  const newSchedule: HeartbeatSchedule = schedule || JSON.parse((row.schedule as string) || '{}');

  db.prepare(`
    UPDATE heartbeats SET template_id = ?, agent_id = ?, schedule = ?, label = ?, active = ?, autonomy = ?, next_run_at = ? WHERE id = ?
  `).run(
    templateId?.trim() ?? row.template_id,
    agentId ?? row.agent_id,
    JSON.stringify(newSchedule),
    label?.trim() ?? row.label,
    active !== undefined ? (active ? 1 : 0) : row.active,
    // An unrecognised level keeps whatever the heartbeat already had, rather than silently
    // resetting a deliberately lowered posture to the default.
    isAutonomyLevel(String(autonomy || '')) ? autonomy : row.autonomy,
    computeNextRunAt(newSchedule),
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeHeartbeat(updated));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM heartbeats WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

router.post('/:id/fire', (req, res) => {
  const result = fireHeartbeat(req.params.id);
  if ('error' in result) return res.status(400).json(result);
  res.json(result);
});

export default router;
