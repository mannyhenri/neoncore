import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { setProjectCartridges, getProjectCartridges } from '../lib/resolve-agent.js';
import type { Project } from '../types.js';
import { projectCostUsd } from '../lib/goal-cost.js';
import { deleteProjectCascade } from '../lib/project-delete.js';

const router = Router();

function estimateTokens(inputChars: number, outputChars: number): number {
  return Math.round((inputChars + outputChars) / 4);
}

function normalizeProject(row: Record<string, unknown>, extra?: { cartridges?: string[]; goalName?: string; runCount?: number; tokensUsed?: number; costUsd?: number; lastRunStatus?: string | null; lastRunAt?: string | null; activeRunCount?: number }): Project {
  return {
    cartridges: extra?.cartridges ?? [],
    id: row.id as string,
    goalId: (row.goal_id as string) || null,
    name: row.name as string,
    description: (row.description as string) || '',
    primaryRepo: (row.primary_repo as string) || '',
    color: (row.color as string) || '#a855f7',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...extra,
  };
}

function withComputedFields(row: Record<string, unknown>): Project {
  const projectId = row.id as string;
  // The cartridges a project owns, and the live cartridge rows behind them. Surfaced on every
  // read so a client never has to make a second call to know what a project is made of — and
  // so no UI is tempted to re-derive it from primary_repo, which is now only a seed.
  const cartridges = getProjectCartridges(projectId);

  const goalRow = row.goal_id
    ? (db.prepare('SELECT name FROM goals WHERE id = ?').get(row.goal_id) as { name: string } | undefined)
    : undefined;

  const stepRows = db.prepare(`
    SELECT ws.dispatched_prompt, ws.result
    FROM workflow_steps ws
    JOIN workflows w ON ws.workflow_id = w.id
    WHERE w.project_id = ?
  `).all(projectId) as { dispatched_prompt: string; result: string }[];

  const inputChars = stepRows.reduce((s, r) => s + (r.dispatched_prompt?.length || 0), 0);
  const outputChars = stepRows.reduce((s, r) => s + (r.result?.length || 0), 0);

  const { runCount } = db.prepare(`
    SELECT COUNT(*) as runCount FROM workflows WHERE project_id = ? AND template_id IS NOT NULL
  `).get(projectId) as { runCount: number };

  const lastRun = db.prepare(`
    SELECT status, started_at FROM workflows WHERE project_id = ? AND template_id IS NOT NULL ORDER BY created_at DESC LIMIT 1
  `).get(projectId) as { status: string; started_at: string } | undefined;

  const { activeRunCount } = db.prepare(`
    SELECT COUNT(*) as activeRunCount FROM workflows WHERE project_id = ? AND status = 'running' AND template_id IS NOT NULL
  `).get(projectId) as { activeRunCount: number };

  return normalizeProject(row, {
    cartridges,
    goalName: goalRow?.name,
    runCount,
    tokensUsed: estimateTokens(inputChars, outputChars),
    costUsd: projectCostUsd((row.primary_repo as string) || ''),
    lastRunStatus: lastRun?.status || null,
    lastRunAt: lastRun?.started_at || null,
    activeRunCount,
  });
}

router.get('/', (req, res) => {
  const goalId = req.query.goalId as string | undefined;
  const rows = goalId
    ? db.prepare('SELECT * FROM projects WHERE goal_id = ? ORDER BY created_at DESC').all(goalId) as Record<string, unknown>[]
    : db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[];

  res.json(rows.map(withComputedFields));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Project not found' });

  const workflows = db.prepare(`
    SELECT id, name, status, started_at, completed_at, run_number
    FROM workflows WHERE project_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(req.params.id) as Record<string, unknown>[];

  res.json({ project: withComputedFields(row), workflows });
});

router.post('/', (req, res) => {
  const { name, description, goalId, primaryRepo, color, cartridges } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, goalId || null, name.trim(), description?.trim() || '', primaryRepo?.trim() || '', color || '#a855f7', now, now);

  // Tie the cartridges at CREATION. A project without them is a name with no work attached,
  // and asking the user to come back and link them later is how they stay unlinked. The
  // primaryRepo field still seeds the set so older clients keep working unchanged.
  const initial = Array.isArray(cartridges) && cartridges.length
    ? (cartridges as string[])
    : (primaryRepo?.trim() ? [primaryRepo.trim()] : []);
  if (initial.length) setProjectCartridges(id, initial);

  const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(withComputedFields(created));
});

router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Project not found' });

  const { name, description, goalId, primaryRepo, color, cartridges } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE projects SET name = ?, description = ?, goal_id = ?, primary_repo = ?, color = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name?.trim() || row.name,
    description?.trim() ?? row.description,
    goalId !== undefined ? goalId || null : row.goal_id,
    primaryRepo?.trim() ?? row.primary_repo,
    color || row.color,
    now,
    req.params.id,
  );

  // Only when the caller SENDS cartridges — an absent field means "leave them alone", while an
  // empty array means "this project owns none". Collapsing those would silently unlink every
  // project edited by a client that does not know about cartridges yet.
  if (Array.isArray(cartridges)) setProjectCartridges(req.params.id, cartridges as string[]);

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(withComputedFields(updated));
});

router.delete('/:id', (req, res) => {
  // Cascade through lib so the cartridge mappings go too — deleting the project row alone left
  // them orphaned, invisibly, because every read joins through `projects`.
  deleteProjectCascade(req.params.id);
  res.status(204).send();
});

router.get('/:id/learnings', (req, res) => {
  const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Project not found' });

  const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
  const learnings = db.prepare(
    `SELECT id, project_id, workflow_id, workflow_name, content, tags, created_at
     FROM project_learnings WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(req.params.id, limit) as Record<string, unknown>[];

  res.json(learnings.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    content: r.content,
    tags: JSON.parse((r.tags as string) || '[]'),
    createdAt: r.created_at,
  })));
});

export default router;
