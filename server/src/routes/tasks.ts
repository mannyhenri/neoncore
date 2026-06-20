import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import { resolveAgentId } from '../lib/resolve-agent.js';
import type { Task, TaskStatus } from '../types.js';

const router = Router();

function normalizeTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    prompt: (row.prompt as string) ?? '',
    projectId: (row.project_id as string) ?? null,
    status: (row.status as TaskStatus) ?? 'queued',
    assignedAgentId: (row.assigned_agent_id as string) ?? null,
    priority: (row.priority as number) ?? 0,
    result: (row.result as string) ?? '',
    error: (row.error as string) ?? '',
    createdAt: row.created_at as string,
    claimedAt: (row.claimed_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}

function getTask(id: string): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? normalizeTask(row) : undefined;
}

/** Resolve the calling agent from body/query (sessionId or agentId or machine+repoPath). */
function callerAgentId(src: Record<string, unknown>): string | undefined {
  return resolveAgentId({
    agentId: src.agentId as string | undefined,
    sessionId: src.sessionId as string | undefined,
    machine: src.machine as string | undefined,
    repoPath: src.repoPath as string | undefined,
  });
}

// Create a task
router.post('/', (req, res) => {
  const { title, prompt, projectId, priority } = req.body || {};
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, title, prompt, project_id, status, priority, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `).run(id, title, prompt || '', projectId || null, Number(priority) || 0, now);

  const task = getTask(id)!;
  getIO().emit('task_created', task);
  res.status(201).json(task);
});

// List tasks (filterable)
router.get('/', (req, res) => {
  const { status, agentId, projectId } = req.query as Record<string, string | undefined>;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (agentId) { clauses.push('assigned_agent_id = ?'); params.push(agentId); }
  if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at ASC LIMIT 200`)
    .all(...params) as Record<string, unknown>[];
  res.json(rows.map(normalizeTask));
});

// Claimable queue for an agent: unassigned queued tasks + tasks already mine.
// (Defined before '/:id' so "queue" isn't captured as an id.)
router.get('/queue', (req, res) => {
  const agentId = callerAgentId(req.query as Record<string, unknown>);
  if (!agentId) return res.status(404).json({ error: 'Agent not found' });
  const rows = db.prepare(`
    SELECT * FROM tasks
     WHERE (status = 'queued' AND assigned_agent_id IS NULL)
        OR (assigned_agent_id = ? AND status IN ('queued','claimed','in_progress'))
     ORDER BY priority DESC, created_at ASC LIMIT 100
  `).all(agentId) as Record<string, unknown>[];
  res.json(rows.map(normalizeTask));
});

// Get one task
router.get('/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Atomically claim a queued task. Conditional UPDATE guarantees only one agent wins.
router.post('/:id/claim', (req, res) => {
  const agentId = callerAgentId(req.body || {});
  if (!agentId) return res.status(404).json({ error: 'Agent not found' });
  const existing = getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const now = new Date().toISOString();
  const info = db.prepare(`
    UPDATE tasks SET status = 'claimed', assigned_agent_id = ?, claimed_at = ?
     WHERE id = ? AND status = 'queued' AND assigned_agent_id IS NULL
  `).run(agentId, now, req.params.id);

  if (info.changes === 0) {
    const current = getTask(req.params.id);
    return res.status(409).json({ error: 'Task already claimed', task: current });
  }

  const task = getTask(req.params.id)!;
  getIO().emit('task_updated', task);
  res.json(task);
});

// Mark a claimed task as in_progress (owner only).
router.post('/:id/start', (req, res) => {
  const agentId = callerAgentId(req.body || {});
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!agentId || task.assignedAgentId !== agentId) {
    return res.status(403).json({ error: 'Not the owner of this task' });
  }
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(req.params.id);
  const updated = getTask(req.params.id)!;
  getIO().emit('task_updated', updated);
  res.json(updated);
});

// Complete a task (owner only). status defaults to 'done'.
router.post('/:id/complete', (req, res) => {
  const { result, status, error } = req.body || {};
  const agentId = callerAgentId(req.body || {});
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!agentId || task.assignedAgentId !== agentId) {
    return res.status(403).json({ error: 'Not the owner of this task' });
  }
  const finalStatus: TaskStatus = status === 'failed' ? 'failed' : 'done';
  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?')
    .run(finalStatus, result || '', error || '', now, req.params.id);
  const updated = getTask(req.params.id)!;
  getIO().emit('task_updated', updated);
  res.json(updated);
});

// Cancel a task (dashboard action — no owner check).
router.post('/:id/cancel', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), req.params.id);
  const updated = getTask(req.params.id)!;
  getIO().emit('task_updated', updated);
  res.json(updated);
});

export default router;
