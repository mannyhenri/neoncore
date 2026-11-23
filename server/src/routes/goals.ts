import { Router } from 'express';
import { randomUUID } from 'crypto';
import { addFeatureFiles, listFeatureFiles, readFeatureFile, removeFeatureFile, deleteFeatureFiles, FeatureFileError } from '../lib/feature-files.js';
import db from '../db.js';
import type { Command, Goal } from '../types.js';
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
import { sendCommandToAgent, noChannel, inboxPending, whenInboxSettles } from '../lib/send-command.js';
import { releaseReadyTasks } from './tasks.js';
import { pilotsForGoal, deletePilotsForGoal } from '../lib/goal-pilot.js';
import { cancelPilot } from '../lib/goal-pilot-runner.js';
import { entryForDoneFeature, retractEntryForReopenedFeature } from '../lib/project-changelog.js';
import { docsChanged } from '../lib/project-docs.js';


/**
 * A request handed to the cartridge's inbox is in flight, so the route answers 202 like any
 * other delivery. If the inbox then turns it down, fail the request here, as the no-channel path
 * does, so it does not sit "pending" forever. Only while it is still pending: an answer that
 * arrived in the meantime wins.
 */
function failIfInboxRefuses(cmd: Command, table: 'goal_drafts' | 'goal_decompositions', id: string): void {
  if (!inboxPending(cmd)) return;
  void whenInboxSettles(cmd.id)?.then((out) => {
    if (out.ok) return;
    db.prepare(`UPDATE ${table} SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'pending'`)
      .run(`the cartridge's inbox refused the request (${out.detail}) — is it connected?`, new Date().toISOString(), id);
  });
}

const router = Router();

function estimateTokens(inputChars: number, outputChars: number): number {
  return Math.round((inputChars + outputChars) / 4);
}

/**
 * Where a feature's pipeline stands, in one line the feature list can show without loading the
 * whole pilot: the latest pilot's phase, what (if anything) it needs from the person, and how far
 * its stages got. Null when the feature has never been piloted — it is still in the backlog.
 */
export function pilotSummary(goalId: string): Goal['pilot'] {
  const p = db.prepare(
    `SELECT id, phase, attention, current_request_id FROM goal_pilots WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(goalId) as { id: string; phase: string; attention: string; current_request_id: string } | undefined;
  if (!p) return null;
  const st = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('completed','skipped') THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status IN ('review') THEN 1 ELSE 0 END) AS review
       FROM goal_pilot_stages WHERE pilot_id = ?`,
  ).get(p.id) as { total: number; done: number | null; review: number | null };
  const req = p.current_request_id
    ? db.prepare('SELECT status FROM goal_pilot_requests WHERE id = ?').get(p.current_request_id) as { status?: string } | undefined
    : undefined;
  return {
    id: p.id,
    phase: p.phase as NonNullable<Goal['pilot']>['phase'],
    attention: p.attention || '',
    stagesDone: st.done ?? 0,
    stagesTotal: st.total ?? 0,
    awaitingReview: (st.review ?? 0) > 0,
    plannerFailed: req?.status === 'failed',
  };
}

/** The next position at the end of a project's feature list. */
function nextPosition(projectId: string): number {
  if (!projectId) return 0;
  return ((db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM goals WHERE project_id = ?').get(projectId) as { n: number }).n);
}

export interface NewFeature {
  projectId: string;
  name: string;
  description?: string;
  successMetric?: string;
  budgetUsd?: number | null;
  targetDate?: string;
  autonomy?: string;
  status?: string;
}

/**
 * Create a feature — a goals row filed under a project, at the end of its list. The one insert
 * every path uses (the feature list's quick add, a pasted list, the guided intake), so a feature is
 * the same row whichever way it was made.
 */
export function createFeature(f: NewFeature): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO goals (id, name, description, success_metric, token_budget, budget_usd, status, created_at, updated_at,
                       acceptance_criteria, no_gos, rabbit_holes, invariants, key_results,
                       target_date, owner, investment_category, autonomy, project_id, position)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, '', '', '', '', '[]', ?, '', '', ?, ?, ?)
  `).run(id, f.name.trim().slice(0, 200), (f.description || '').trim(), (f.successMetric || '').trim(), f.budgetUsd ?? null,
    f.status === 'paused' || f.status === 'achieved' ? f.status : 'active', now, now,
    String(f.targetDate || '').trim().slice(0, 10), normalizeAutonomy(f.autonomy), f.projectId || '', nextPosition(f.projectId));
  return id;
}

function normalizeGoal(row: Record<string, unknown>, extra?: Partial<Goal>): Goal {
  return {
    id: row.id as string,
    projectId: (row.project_id as string) || null,
    position: (row.position as number) ?? 0,
    origin: row.origin === 'imported' ? 'imported' : '',
    doneAt: (row.done_at as string) || '',
    roadmapLane: (['now', 'next', 'later'].includes(row.roadmap_lane as string) ? row.roadmap_lane : '') as Goal['roadmapLane'],
    area: (row.area as string) || '',
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
    documentedScope: (() => { try { return JSON.parse((row.documented_scope as string) || '{}'); } catch { return {}; } })(),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...extra,
  };
}

router.get('/', (req, res) => {
  // `?projectId=` — one project's features, in the order they are to be built.
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const rows = (projectId
    ? db.prepare('SELECT * FROM goals WHERE project_id = ? ORDER BY position, created_at').all(projectId)
    : db.prepare('SELECT * FROM goals ORDER BY position, created_at DESC').all()) as Record<string, unknown>[];

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
      pilot: pilotSummary(goalId),
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
  res.json(normalizeGoal(row, { pilot: pilotSummary(row.id as string) }));
});

router.post('/', (req, res) => {
  const { name, description, successMetric, tokenBudget, budgetUsd, status,
          acceptanceCriteria, noGos, rabbitHoles, invariants, keyResults,
          targetDate, owner, investmentCategory, autonomy, projectId } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const pid = typeof projectId === 'string' ? projectId.trim() : '';
  if (pid && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) return res.status(404).json({ error: 'project not found' });

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO goals (id, name, description, success_metric, token_budget, budget_usd, status, created_at, updated_at,
                       acceptance_criteria, no_gos, rabbit_holes, invariants, key_results,
                       target_date, owner, investment_category, autonomy, project_id, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), description?.trim() || '', successMetric?.trim() || '', tokenBudget ?? null, budgetUsd ?? null, status || 'active', now, now,
         acceptanceCriteria?.trim() || '', noGos?.trim() || '', rabbitHoles?.trim() || '', invariants?.trim() || '',
         JSON.stringify(Array.isArray(keyResults) ? keyResults : []),
         // Normalized at the boundary: an unknown category or posture becomes '' (unset)
         // rather than being stored and silently ignored everywhere downstream.
         String(targetDate || '').trim().slice(0, 10), String(owner || '').trim(),
         normalizeCategory(investmentCategory), normalizeAutonomy(autonomy), pid, nextPosition(pid));

  const created = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown>;
  docsChanged(pid);
  res.status(201).json(normalizeGoal(created));
});

router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Goal not found' });

  const { name, description, successMetric, tokenBudget, budgetUsd, status,
          acceptanceCriteria, noGos, rabbitHoles, invariants, keyResults,
          targetDate, owner, investmentCategory, autonomy, projectId, roadmapLane, area } = req.body;
  const now = new Date().toISOString();
  if (status !== undefined && status !== '' && !['active', 'achieved', 'paused'].includes(String(status))) {
    return res.status(400).json({ error: 'status must be active, achieved or paused' });
  }

  // Placing it on the roadmap: 'now' | 'next' | 'later', or '' for automatic.
  if (roadmapLane !== undefined) {
    const lane = ['now', 'next', 'later'].includes(String(roadmapLane)) ? String(roadmapLane) : '';
    db.prepare('UPDATE goals SET roadmap_lane = ? WHERE id = ?').run(lane, req.params.id);
  }

  // Its capability group on the spec: '<group> · <sub-area>', '<group>', or '' (unsorted).
  if (area !== undefined) {
    db.prepare('UPDATE goals SET area = ? WHERE id = ?').run(String(area ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), req.params.id);
  }

  // Moving a feature to another project (or filing an unfiled one): it goes to the end of that list.
  if (projectId !== undefined && String(projectId || '') !== String(row.project_id || '')) {
    const pid = String(projectId || '').trim();
    if (pid && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) return res.status(404).json({ error: 'project not found' });
    db.prepare('UPDATE goals SET project_id = ?, position = ? WHERE id = ?').run(pid, nextPosition(pid), req.params.id);
  }

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

  // Marked done: when (a date later edits do not move), and the changelog entry written from the
  // feature's own records (lib/project-changelog.ts). Reopened: the date clears, and the entry comes out
  // unless it was released or edited by a person.
  if (status === 'achieved' && row.status !== 'achieved') {
    db.prepare('UPDATE goals SET done_at = ? WHERE id = ?').run(now, req.params.id);
    try { entryForDoneFeature(req.params.id); } catch (err) { console.warn('[changelog] entry for a done feature failed:', err); }
  } else if (status && status !== 'achieved' && row.status === 'achieved') {
    // An existing (imported) feature reopened is work to do again: it joins the list as planned.
    db.prepare("UPDATE goals SET done_at = '', origin = '' WHERE id = ?").run(req.params.id);
    retractEntryForReopenedFeature(req.params.id);
  }
  docsChanged(row.project_id as string);
  if (projectId !== undefined && projectId !== row.project_id) docsChanged(String(projectId || ''));

  const updated = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeGoal(updated, { pilot: pilotSummary(req.params.id) }));
});

/**
 * Delete a feature (goal) and its pilots. A live pipeline is stopped first, so its current run does
 * not carry on working for a feature that no longer exists. The cascade would remove the rows, but
 * not stop the run the pipeline had in flight — that is what cancelPilot is for. Runs stay as
 * history.
 */
export function deleteFeatureCascade(goalId: string): void {
  for (const p of pilotsForGoal(goalId)) {
    if (p.phase !== 'completed' && p.phase !== 'cancelled') cancelPilot(p.id);
  }
  deletePilotsForGoal(goalId);
  deleteFeatureFiles(goalId);
  db.prepare('DELETE FROM goals WHERE id = ?').run(goalId);
}

// ── the feature's files (lib/feature-files.ts) ────────────────────────────────

router.get('/:id/files', (req, res) => {
  res.json(listFeatureFiles(req.params.id));
});

router.post('/:id/files', (req, res) => {
  try { res.json(addFeatureFiles(req.params.id, req.body?.files)); }
  catch (err) {
    const status = err instanceof FeatureFileError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/:id/files/:fileId', (req, res) => {
  const hit = readFeatureFile(req.params.id, req.params.fileId);
  if (!hit) return res.status(404).json({ error: 'file not found' });
  res.type(hit.file.mimeType).setHeader('Content-Disposition', `attachment; filename="${hit.file.name.replace(/"/g, '')}"`);
  res.send(hit.data);
});

router.delete('/:id/files/:fileId', (req, res) => {
  if (!removeFeatureFile(req.params.id, req.params.fileId)) return res.status(404).json({ error: 'file not found' });
  res.status(204).send();
});

router.delete('/:id', (req, res) => {
  const pid = (db.prepare('SELECT project_id FROM goals WHERE id = ?').get(req.params.id) as { project_id?: string } | undefined)?.project_id;
  deleteFeatureCascade(req.params.id);
  docsChanged(pid);
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
  if (noChannel(cmd)) {
    // Queued into the void: nothing was listening. Failing the draft here is what stops it
    // sitting "pending" forever with no cartridge ever having seen it.
    failDraft(draft.id, 'the cartridge did not receive the request — is it connected?');
    return res.status(502).json({ error: 'the cartridge did not receive the request', draft: getDraft(draft.id) });
  }
  failIfInboxRefuses(cmd!, 'goal_drafts', draft.id);
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
  if (noChannel(cmd)) {
    failDecomposition(dec.id, 'the cartridge did not receive the request — is it connected?');
    return res.status(502).json({ error: 'the cartridge did not receive the request', decomposition: getDecomposition(dec.id) });
  }
  failIfInboxRefuses(cmd!, 'goal_decompositions', dec.id);
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
