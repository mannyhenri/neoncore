import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import type { Goal } from '../types.js';
import { agentIdsForRepo } from '../lib/resolve-agent.js';
import { totalCostUsd, type UsageRow } from '../lib/pricing.js';

const router = Router();

function estimateTokens(inputChars: number, outputChars: number): number {
  return Math.round((inputChars + outputChars) / 4);
}

/** Real USD spent across every cartridge (repo) belonging to this goal's projects. */
function goalCostUsd(goalId: string): number {
  const repos = db
    .prepare("SELECT primary_repo FROM projects WHERE goal_id = ? AND primary_repo != ''")
    .all(goalId) as { primary_repo: string }[];
  const agentIds = [...new Set(repos.flatMap((r) => agentIdsForRepo(r.primary_repo)))];
  if (!agentIds.length) return 0;
  const placeholders = agentIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model
         FROM session_usage WHERE agent_id IN (${placeholders})`,
    )
    .all(...agentIds) as UsageRow[];
  return totalCostUsd(rows);
}

function normalizeGoal(row: Record<string, unknown>, extra?: { projectCount?: number; runCount?: number; tokensUsed?: number; costUsd?: number }): Goal {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    successMetric: (row.success_metric as string) || '',
    tokenBudget: row.token_budget != null ? (row.token_budget as number) : null,
    status: (row.status as Goal['status']) || 'active',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...extra,
  };
}

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all() as Record<string, unknown>[];

  const goals = rows.map((row) => {
    const goalId = row.id as string;

    const { projectCount } = db.prepare('SELECT COUNT(*) as projectCount FROM projects WHERE goal_id = ?').get(goalId) as { projectCount: number };

    const runRows = db.prepare(`
      SELECT ws.dispatched_prompt, ws.result
      FROM workflow_steps ws
      JOIN workflows w ON ws.workflow_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE p.goal_id = ?
    `).all(goalId) as { dispatched_prompt: string; result: string }[];

    const inputChars = runRows.reduce((s, r) => s + (r.dispatched_prompt?.length || 0), 0);
    const outputChars = runRows.reduce((s, r) => s + (r.result?.length || 0), 0);

    const { runCount } = db.prepare(`
      SELECT COUNT(DISTINCT w.id) as runCount
      FROM workflows w JOIN projects p ON w.project_id = p.id
      WHERE p.goal_id = ? AND w.template_id IS NOT NULL
    `).get(goalId) as { runCount: number };

    return normalizeGoal(row, { projectCount, runCount, tokensUsed: estimateTokens(inputChars, outputChars), costUsd: goalCostUsd(goalId) });
  });

  res.json(goals);
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Goal not found' });
  res.json(normalizeGoal(row));
});

router.post('/', (req, res) => {
  const { name, description, successMetric, tokenBudget, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO goals (id, name, description, success_metric, token_budget, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), description?.trim() || '', successMetric?.trim() || '', tokenBudget ?? null, status || 'active', now, now);

  const created = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(normalizeGoal(created));
});

router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Goal not found' });

  const { name, description, successMetric, tokenBudget, status } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE goals SET name = ?, description = ?, success_metric = ?, token_budget = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name?.trim() || row.name,
    description?.trim() ?? row.description,
    successMetric?.trim() ?? row.success_metric,
    tokenBudget !== undefined ? tokenBudget : row.token_budget,
    status || row.status,
    now,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeGoal(updated));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

export default router;
