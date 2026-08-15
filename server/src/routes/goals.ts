import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import type { Goal } from '../types.js';
import { goalCostUsd } from '../lib/goal-cost.js';
import { goalReach } from '../lib/goal-reach.js';
import { goalProgress } from '../lib/goal-progress.js';
import { goalHealth } from '../lib/goal-health.js';
import { goalRunIds } from '../lib/goal-scope.js';
import {
  INVESTMENT_CATEGORIES, AUTONOMY_LEVELS, normalizeCategory, normalizeAutonomy,
  goalSchedule, shouldShowPortfolio, portfolioSummary,
} from '../lib/goal-pm.js';
import {
  DRAFTABLE_FIELDS, createDraft, getDraft, draftsForGoal, submitDraft, applyDraft, failDraft,
  buildDraftPrompt, DraftApplyError,
} from '../lib/goal-draft.js';
import {
  createDecomposition, getDecomposition, decompositionsForGoal, submitDecomposition,
  failDecomposition, acceptDecomposition, revertDecomposition, buildDecompositionPrompt,
  DecompositionError,
} from '../lib/goal-decomposition.js';
import { guardBusy } from '../lib/queue-if-busy.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import { releaseReadyTasks } from './tasks.js';

const router = Router();

function estimateTokens(inputChars: number, outputChars: number): number {
  return Math.round((inputChars + outputChars) / 4);
}

function normalizeGoal(row: Record<string, unknown>, extra?: Partial<Goal>): Goal {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    successMetric: (row.success_metric as string) || '',
    acceptanceCriteria: (row.acceptance_criteria as string) || '',
    noGos: (row.no_gos as string) || '',
    rabbitHoles: (row.rabbit_holes as string) || '',
    invariants: (row.invariants as string) || '',
    keyResults: (() => { try { return JSON.parse((row.key_results as string) || '[]'); } catch { return []; } })(),
    tokenBudget: row.token_budget != null ? (row.token_budget as number) : null,
    budgetUsd: row.budget_usd != null ? (row.budget_usd as number) : null,
    status: (row.status as Goal['status']) || 'active',
    // '' means unset in every case — normalized on write, so a bad value can never be stored.
    targetDate: (row.target_date as string) || '',
    owner: (row.owner as string) || '',
    investmentCategory: (row.investment_category as string) || '',
    autonomy: (row.autonomy as string) || '',
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

    // Through the shared scope, not a fifth hand-written join. The inline version here read
    // `template_id IS NOT NULL` while goal-scope also requires it to be non-empty, so the two
    // could report different run counts for the same goal.
    const runCount = goalRunIds(goalId).length;

    // reach is what makes cost and the brief legible: 0 means neither will ever fire.
    // progress and health are the other two questions a PM asks of a goal — how far along,
    // and does anything need me — all four derived from one resolution path (goal-scope.ts).
    return normalizeGoal(row, {
      projectCount,
      runCount,
      tokensUsed: estimateTokens(inputChars, outputChars),
      costUsd: goalCostUsd(goalId),
      reach: goalReach(goalId),
      progress: goalProgress(goalId),
      health: goalHealth(goalId),
      // "Late" is only computable once progress exists (Phase 3), which is why this arrives
      // now and not with the other PM fields.
      schedule: goalSchedule(goalId),
    });
  });

  res.json(goals);
});

/**
 * The cross-goal strip, plus the registries the form needs.
 *
 * `show` is computed here rather than left to the client: the rule that a portfolio of one does
 * not warrant a portfolio view is a product decision, and duplicating it in the UI is how it
 * drifts. Declared BEFORE `/:id` so "portfolio" is not read as a goal id.
 */
router.get('/portfolio', (_req, res) => {
  const summary = portfolioSummary();
  res.json({
    show: shouldShowPortfolio(summary.goalCount),
    summary,
    categories: INVESTMENT_CATEGORIES,
    autonomyLevels: AUTONOMY_LEVELS.map(({ key, label, hint }) => ({ key, label, hint })),
  });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Goal not found' });
  res.json(normalizeGoal(row));
});

router.post('/', (req, res) => {
  const { name, description, successMetric, tokenBudget, budgetUsd, status,
          acceptanceCriteria, noGos, rabbitHoles, invariants, keyResults,
          targetDate, owner, investmentCategory, autonomy } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO goals (id, name, description, success_metric, token_budget, budget_usd, status, created_at, updated_at,
                       acceptance_criteria, no_gos, rabbit_holes, invariants, key_results,
                       target_date, owner, investment_category, autonomy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), description?.trim() || '', successMetric?.trim() || '', tokenBudget ?? null, budgetUsd ?? null, status || 'active', now, now,
         acceptanceCriteria?.trim() || '', noGos?.trim() || '', rabbitHoles?.trim() || '', invariants?.trim() || '',
         JSON.stringify(Array.isArray(keyResults) ? keyResults : []),
         // Normalized at the boundary: an unknown category or posture becomes '' (unset)
         // rather than being stored and silently ignored everywhere downstream.
         String(targetDate || '').trim().slice(0, 10), String(owner || '').trim(),
         normalizeCategory(investmentCategory), normalizeAutonomy(autonomy));

  const created = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(normalizeGoal(created));
});

router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Goal not found' });

  const { name, description, successMetric, tokenBudget, budgetUsd, status,
          acceptanceCriteria, noGos, rabbitHoles, invariants, keyResults,
          targetDate, owner, investmentCategory, autonomy } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE goals SET name = ?, description = ?, success_metric = ?, token_budget = ?, budget_usd = ?, status = ?, updated_at = ?,
                     acceptance_criteria = ?, no_gos = ?, rabbit_holes = ?, invariants = ?, key_results = ?,
                     target_date = ?, owner = ?, investment_category = ?, autonomy = ?
    WHERE id = ?
  `).run(
    name?.trim() || row.name,
    description?.trim() ?? row.description,
    successMetric?.trim() ?? row.success_metric,
    tokenBudget !== undefined ? tokenBudget : row.token_budget,
    budgetUsd !== undefined ? budgetUsd : row.budget_usd,
    status || row.status,
    now,
    acceptanceCriteria !== undefined ? String(acceptanceCriteria).trim() : row.acceptance_criteria,
    noGos !== undefined ? String(noGos).trim() : row.no_gos,
    rabbitHoles !== undefined ? String(rabbitHoles).trim() : row.rabbit_holes,
    invariants !== undefined ? String(invariants).trim() : row.invariants,
    keyResults !== undefined ? JSON.stringify(Array.isArray(keyResults) ? keyResults : []) : row.key_results,
    targetDate !== undefined ? String(targetDate || '').trim().slice(0, 10) : row.target_date,
    owner !== undefined ? String(owner || '').trim() : row.owner,
    investmentCategory !== undefined ? normalizeCategory(investmentCategory) : row.investment_category,
    autonomy !== undefined ? normalizeAutonomy(autonomy) : row.autonomy,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeGoal(updated));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// ── assisted authoring ────────────────────────────────────────────────────────
//
// A draft is a PROPOSAL. Nothing here writes to `goals` except POST /drafts/:id/apply, and
// that only writes the fields the request explicitly names. See lib/goal-draft.ts.

/** Drafts for a goal, newest first. `?goalId=` omitted means drafts for a not-yet-created goal. */
router.get('/drafts/list', (req, res) => {
  const goalId = typeof req.query.goalId === 'string' && req.query.goalId ? req.query.goalId : null;
  res.json(draftsForGoal(goalId));
});

router.get('/drafts/:draftId', (req, res) => {
  const draft = getDraft(req.params.draftId);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  res.json(draft);
});

/**
 * Ask a cartridge to draft goal intent.
 *
 * Dispatch, not generation: NeonCore has no LLM client, and adding one would spend money that
 * `goalCostUsd` (built on session_usage) could not attribute to the goal it was spent on.
 */
router.post('/drafts', (req, res) => {
  const { goalId, seed, agentId } = req.body as { goalId?: string; seed?: string; agentId?: string };
  if (!agentId) return res.status(400).json({ error: 'agentId is required — a cartridge does the drafting' });

  const goal = goalId
    ? db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined
    : undefined;
  if (goalId && !goal) return res.status(404).json({ error: 'goal not found' });

  const draft = createDraft({
    goalId: goalId ?? null,
    seed: (seed || '').trim(),
    agentId,
    source: 'goal-intent-draft',
  });
  const prompt = buildDraftPrompt(draft.id, draft.seed, goal);

  // Through the same busy guard every other dispatch uses, so asking for help never stomps a
  // cartridge mid-run — it queues behind the work instead.
  const guard = guardBusy({
    kind: 'prompt',
    targets: [agentId],
    payload: { agentId, text: prompt, includeMemory: false },
  });
  if ('error' in guard) {
    failDraft(draft.id, guard.error);
    return res.status(409).json({ error: guard.error });
  }
  if (guard.queued) return res.status(202).json({ draft: getDraft(draft.id), queued: true });

  const cmd = sendCommandToAgent(agentId, prompt, false);
  if (!cmd || cmd.delivered === false) {
    // Queued into the void: nothing was listening. Failing the draft here is what stops it
    // sitting "pending" forever with no cartridge ever having seen it.
    failDraft(draft.id, 'the cartridge did not receive the request — is it connected?');
    return res.status(502).json({ error: 'the cartridge did not receive the request', draft: getDraft(draft.id) });
  }
  res.status(202).json({ draft: getDraft(draft.id), queued: false });
});

/** Where the cartridge submits. Stores a proposal; touches no goal. */
router.post('/drafts/:draftId/submit', (req, res) => {
  const existing = getDraft(req.params.draftId);
  if (!existing) return res.status(404).json({ error: 'draft not found' });
  const updated = submitDraft(req.params.draftId, (req.body as { fields?: unknown })?.fields);
  if (updated?.status === 'failed') {
    return res.status(422).json({ error: updated.error, draft: updated });
  }
  res.json(updated);
});

/**
 * THE ONLY path from generated text to a goal, and it requires a person naming fields.
 *
 * Per-field because the intent fields reach working agents at dispatch — accepting a good
 * acceptance-criteria block must not smuggle in a no-gos section nobody read.
 */
router.post('/drafts/:draftId/apply', (req, res) => {
  const { fields } = req.body as { fields?: unknown };
  if (!Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ error: 'name the fields you are accepting — nothing is applied by default' });
  }
  try {
    const applied = applyDraft(req.params.draftId, fields.filter((f): f is string => typeof f === 'string'));
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(applied.goalId) as Record<string, unknown>;
    res.json({ draft: applied, goal: normalizeGoal(goal) });
  } catch (err) {
    if (err instanceof DraftApplyError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

/** The registry, so the UI labels fields the same way the prompt asks for them. */
router.get('/drafts/meta/fields', (_req, res) => {
  res.json(DRAFTABLE_FIELDS.map(({ key, label, guidance, kind }) => ({ key, label, guidance, kind })));
});

// ── decomposition ─────────────────────────────────────────────────────────────
//
// Same contract as drafts, higher stakes: accepting creates projects and tasks that get
// dispatched to cartridges. Nothing here creates a row except POST /:id/accept.

router.get('/:goalId/decompositions', (req, res) => {
  res.json(decompositionsForGoal(req.params.goalId));
});

router.get('/decompositions/:id', (req, res) => {
  const dec = getDecomposition(req.params.id);
  if (!dec) return res.status(404).json({ error: 'decomposition not found' });
  res.json(dec);
});

router.post('/:goalId/decompositions', (req, res) => {
  const { seed, agentId } = req.body as { seed?: string; agentId?: string };
  if (!agentId) return res.status(400).json({ error: 'agentId is required — a cartridge does the planning' });

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.goalId) as Record<string, unknown> | undefined;
  if (!goal) return res.status(404).json({ error: 'goal not found' });

  const dec = createDecomposition({ goalId: req.params.goalId, seed: (seed || '').trim(), agentId });
  const prompt = buildDecompositionPrompt(dec.id, dec.seed, goal);

  const guard = guardBusy({
    kind: 'prompt',
    targets: [agentId],
    payload: { agentId, text: prompt, includeMemory: false },
  });
  if ('error' in guard) {
    failDecomposition(dec.id, guard.error);
    return res.status(409).json({ error: guard.error });
  }
  if (guard.queued) return res.status(202).json({ decomposition: getDecomposition(dec.id), queued: true });

  const cmd = sendCommandToAgent(agentId, prompt, false);
  if (!cmd || cmd.delivered === false) {
    failDecomposition(dec.id, 'the cartridge did not receive the request — is it connected?');
    return res.status(502).json({ error: 'the cartridge did not receive the request', decomposition: getDecomposition(dec.id) });
  }
  res.status(202).json({ decomposition: getDecomposition(dec.id), queued: false });
});

/** Where the cartridge submits its plan. Stores a proposal; creates nothing. */
router.post('/decompositions/:id/submit', (req, res) => {
  if (!getDecomposition(req.params.id)) return res.status(404).json({ error: 'decomposition not found' });
  const updated = submitDecomposition(req.params.id, (req.body as { proposal?: unknown })?.proposal);
  if (updated?.status === 'failed') return res.status(422).json({ error: updated.error, decomposition: updated });
  res.json(updated);
});

/** THE ONLY path from a proposal to real projects and tasks. */
router.post('/decompositions/:id/accept', (req, res) => {
  const { projectKeys, taskKeys } = req.body as { projectKeys?: unknown; taskKeys?: unknown };
  if (!Array.isArray(projectKeys) || projectKeys.length === 0) {
    return res.status(400).json({ error: 'name the projects you are accepting — nothing is created by default' });
  }
  try {
    const result = acceptDecomposition(req.params.id, {
      projectKeys: projectKeys.filter((k): k is string => typeof k === 'string'),
      taskKeys: Array.isArray(taskKeys) ? taskKeys.filter((k): k is string => typeof k === 'string') : [],
    });
    // GOAL-050. Accepted work enters the EXISTING queue immediately — but only the tasks whose
    // prerequisites are already satisfied. The rest stay queued and are released as their
    // dependencies finish, which is what turns a decomposition into something that runs itself
    // rather than a list someone has to dispatch by hand.
    const released = releaseReadyTasks(result.decomposition.createdProjects);
    res.json({ ...result, released: released.length });
  } catch (err) {
    if (err instanceof DecompositionError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

/** Undo what a decomposition created, as far as is safe. Started work is never deleted. */
router.post('/decompositions/:id/revert', (req, res) => {
  try {
    res.json(revertDecomposition(req.params.id));
  } catch (err) {
    if (err instanceof DecompositionError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

export default router;
