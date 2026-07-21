import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import { resolveAgentId, projectIdsForAgent, agentIdsForProject } from '../lib/resolve-agent.js';
import { sendCommandToAgent } from '../lib/send-command.js';
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

/**
 * Pick a connected agent to push a task's prompt into. Prefers an idle agent
 * serving the task's project, falling back to any non-offline one. Returns
 * undefined for unpinned tasks (no unambiguous terminal) or when none is online.
 */
function autoDispatchTarget(projectId: string | null): string | undefined {
  if (!projectId) return undefined;
  const candidates = agentIdsForProject(projectId)
    .map((id) => {
      const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status?: string } | undefined;
      return { id, status: row?.status };
    })
    .filter((a) => a.status && a.status !== 'offline');
  return (candidates.find((a) => a.status === 'idle') ?? candidates[0])?.id;
}

/**
 * Push a task's prompt straight into an agent's terminal (reusing the command
 * dispatch path → relay/extension/terminal) and mark the task in-progress for it.
 * Returns the updated task, or null if the agent could not be reached.
 */
function dispatchTaskToAgent(task: Task, agentId: string): Task | null {
  // Report-back instruction: task completion is inferred from the normal stop hook,
  // and dashboard buttons remain available for manual completion.
  const reportBack =
    `When you finish, summarize the result clearly. If you could not complete it, say why.`;
  const instructions = task.prompt && task.prompt.trim() ? task.prompt.trim() : task.title;
  const body = `[NeonCore task ${task.id}: ${task.title}]\n\n${instructions}\n\n${reportBack}`;
  const cmd = sendCommandToAgent(agentId, body, true);
  if (!cmd) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, claimed_at = COALESCE(claimed_at, ?)
     WHERE id = ?
  `).run(agentId, now, task.id);
  const updated = getTask(task.id)!;
  getIO().emit('task_updated', updated);
  return updated;
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

  // Auto-dispatch: if the task is pinned to a project that has a connected agent,
  // push the prompt straight into that terminal instead of waiting to be pulled.
  const target = autoDispatchTarget(task.projectId);
  const dispatched = target ? dispatchTaskToAgent(task, target) : null;
  res.status(201).json(dispatched ?? task);
});

// Edit a queued task (dashboard). Only queued tasks are editable — once claimed
// an agent already holds the instructions, so changing them silently would drift.
router.patch('/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'queued') {
    return res.status(409).json({ error: 'Only queued tasks can be edited' });
  }
  const { title, prompt, projectId, priority } = req.body || {};
  const newTitle = typeof title === 'string' && title.trim() ? title.trim() : task.title;
  const newPrompt = typeof prompt === 'string' ? prompt : task.prompt;
  const newProjectId = projectId === undefined ? task.projectId : (projectId || null);
  const newPriority = priority === undefined ? task.priority : (Number(priority) || 0);
  db.prepare('UPDATE tasks SET title = ?, prompt = ?, project_id = ?, priority = ? WHERE id = ?')
    .run(newTitle, newPrompt, newProjectId, newPriority, req.params.id);
  const updated = getTask(req.params.id)!;
  getIO().emit('task_updated', updated);
  res.json(updated);
});

// Dispatch a task to a terminal now (dashboard "Send to agent"). Pushes the
// prompt into the chosen agent (or an auto-picked one) and marks it in-progress.
router.post('/:id/dispatch', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === 'done' || task.status === 'cancelled') {
    return res.status(409).json({ error: 'Task is already finished' });
  }
  const agentId = (req.body?.agentId as string) || autoDispatchTarget(task.projectId);
  if (!agentId) return res.status(404).json({ error: 'No connected agent to dispatch to' });
  // Respect the hard-pin: a project-scoped task may only go to an agent serving it.
  if (task.projectId && !projectIdsForAgent(agentId).includes(task.projectId)) {
    return res.status(403).json({ error: "Agent does not serve this task's project/cartridge" });
  }
  const updated = dispatchTaskToAgent(task, agentId);
  if (!updated) return res.status(404).json({ error: 'Agent not found' });
  res.json(updated);
});

// List tasks (filterable)
router.get('/', (req, res) => {
  const { status, agentId, projectId, goalId } = req.query as Record<string, string | undefined>;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (agentId) { clauses.push('assigned_agent_id = ?'); params.push(agentId); }
  if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
  if (goalId) {
    clauses.push('project_id IN (SELECT id FROM projects WHERE goal_id = ?)');
    params.push(goalId);
  }
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
  // Hard-pin: an unassigned task with a project_id is only claimable by an agent
  // whose repo matches that project's primary_repo. Unscoped tasks (project_id
  // NULL) remain claimable by anyone.
  const projectIds = projectIdsForAgent(agentId);
  const placeholders = projectIds.map(() => '?').join(',');
  const pinClause = projectIds.length
    ? `(project_id IS NULL OR project_id IN (${placeholders}))`
    : 'project_id IS NULL';
  const rows = db.prepare(`
    SELECT * FROM tasks
     WHERE (status = 'queued' AND assigned_agent_id IS NULL AND ${pinClause})
        OR (assigned_agent_id = ? AND status IN ('queued','claimed','in_progress'))
     ORDER BY priority DESC, created_at ASC LIMIT 100
  `).all(...projectIds, agentId) as Record<string, unknown>[];
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

  // Hard-pin: a project-scoped task may only be claimed by an agent serving that
  // project's cartridge. (Race-safe claim still enforced by the UPDATE below.)
  if (existing.projectId && !projectIdsForAgent(agentId).includes(existing.projectId)) {
    return res.status(403).json({ error: 'Task is pinned to a different project/cartridge' });
  }

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

// Mark a task done/failed from the dashboard (no owner check — the human is
// closing the loop manually, e.g. after a dispatched task that didn't self-report).
router.post('/:id/done', (req, res) => {
  const { status, result, error } = req.body || {};
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const finalStatus: TaskStatus = status === 'failed' ? 'failed' : 'done';
  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?')
    .run(finalStatus, result || task.result || '', error || task.error || '', now, req.params.id);
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
