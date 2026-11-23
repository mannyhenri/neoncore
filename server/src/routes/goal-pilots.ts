/**
 * /api/goal-pilots — a goal run as a managed pipeline. See docs/GOAL-PILOT.md and
 * lib/goal-pilot.ts for the state machine.
 *
 * Two audiences:
 *   · the dashboard — create, answer, accept, staff, start, steer;
 *   · the planner cartridge — POST /requests/:id/submit, through the MCP tool
 *     `neoncore_submit_goal_pilot` or its curl fallback. That route stores a PROPOSAL and never
 *     creates anything; its error messages are written for the planner, which receives them
 *     verbatim and may submit again.
 */
import { Router, type Response } from 'express';
import { addFeatureFiles, FeatureFileError } from '../lib/feature-files.js';
import { featureWorktreePaths, cleanupWorkspace } from '../lib/feature-workspace.js';
import { activeFeatures } from '../lib/active-features.js';
import db from '../db.js';
import { cartridgeExists } from '../lib/cartridge-exists.js';
import { normalizeRepoPath } from '../lib/resolve-agent.js';
import {
  INTAKE_QUESTIONS, INVOLVEMENT_LEVELS, WORK_TYPES, BRIEF_FIELDS, MAX_SCOPE_ROUNDS, MAX_STAGES, MAX_QUESTIONS_PER_ROUND,
  PilotError, normalizeIntake, involvementOf, getPilot, pilotsForGoal, activePilotForGoal, createPilotRow,
  getRequest, requestPrompt, submitPlannerResult, recordAnswers, acceptPlan, revisePlan, deletePilotRows,
} from '../lib/goal-pilot.js';
import {
  PILOT_ENGINES, dispatchPlannerRequest, retryPlannerRequest, startPilot, pausePilot, resumePilot, cancelPilot,
  retryStage, skipStage, pilotView, emitPilotUpdate, announcePilot, ACCEPTANCE_STAGE_KEY, REVIEW_STAGE_KEY, openPrsAndTell, mergeAndTell,
} from '../lib/goal-pilot-runner.js';
import { templateCatalogue } from '../lib/goal-pilot-prompts.js';
import { availableTemplates } from '../lib/goal-decomposition.js';
import { templateNeedsParticipants } from '../lib/workflow-launch.js';
import {
  applyPlannerSummary, generateGoalReport, storedGoalReport, renderGoalReportHtml, renderGoalReportMarkdown,
} from '../lib/goal-pilot-report.js';
import { VERIFY_METHODS, MAX_CRITERIA, defaultVerify, FEATURE_SIZES } from '../lib/acceptance-contract.js';
import {
  submitAcceptanceResult, runBaseline, approveTests, requestTestChanges, askAgainForTests, unlockCriterion,
  restoreTests, acceptTestChange, verifyAgain, confirmChecklist, retestAcceptance, addFixStage,
} from '../lib/acceptance-runner.js';
import { asyncRoute } from '../lib/async-route.js';
import { createFeature, deleteFeatureCascade } from './goals.js';
import { goalRepos } from '../lib/goal-scope.js';
import { docsChangedForGoal } from '../lib/project-docs.js';

const router = Router();

function fail(res: Response, err: unknown) {
  if (err instanceof PilotError) return res.status(err.status).json({ error: err.message });
  throw err;
}

function view(id: string) {
  const p = getPilot(id);
  return p ? pilotView(p) : null;
}

/** The registries the form renders. One source for the form, the validation and the planner prompt. */
router.get('/meta', (_req, res) => {
  res.json({
    intakeQuestions: INTAKE_QUESTIONS,
    involvementLevels: INVOLVEMENT_LEVELS.map(({ value, label, hint }) => ({ value, label, hint })),
    workTypes: WORK_TYPES,
    briefFields: BRIEF_FIELDS.map(({ key, label, guidance, goalColumn }) => ({ key, label, guidance, onGoal: !!goalColumn })),
    engines: [...PILOT_ENGINES],
    limits: { maxScopeRounds: MAX_SCOPE_ROUNDS, maxQuestionsPerRound: MAX_QUESTIONS_PER_ROUND, maxStages: MAX_STAGES, maxCriteria: MAX_CRITERIA },
    verifyMethods: VERIFY_METHODS,
    featureSizes: FEATURE_SIZES,
    defaultVerify: Object.fromEntries(WORK_TYPES.map((w) => [w.value, defaultVerify(w.value)])),
    contractStageKeys: { acceptance: ACCEPTANCE_STAGE_KEY, review: REVIEW_STAGE_KEY },
    templates: templateCatalogue(),
    // Workflows worked by SEVERAL cartridges together (a confer with no roster of its own): at
    // staffing, such a stage is given two or more repos instead of one.
    teamTemplates: availableTemplates().filter((t) => templateNeedsParticipants(t.id)).map((t) => t.name),
  });
});

/**
 * Repos a pipeline can run in, with the engines known there and whether each is live. Built from
 * the cartridges NeonCore has seen plus the repos this goal's projects already own — a repo with
 * no cartridge yet is still a valid choice: its stage waits until one is launched.
 */
router.get('/candidates', (req, res) => {
  const goalId = typeof req.query.goalId === 'string' ? req.query.goalId : '';
  const agents = db.prepare(
    `SELECT id, name, repo_path, repo_name, agent_type, status, machine FROM agents
      WHERE repo_path != '' AND dismissed_at IS NULL ORDER BY last_seen DESC`,
  ).all() as { id: string; name: string; repo_path: string; repo_name: string; agent_type: string; status: string; machine: string }[];
  const byRepo = new Map<string, {
    repoPath: string; repoName: string; machine: string; owned: boolean;
    engines: { agentType: string; agentId: string; status: string; name: string }[];
  }>();
  const entry = (repoPath: string, repoName: string, machine: string) => {
    const key = normalizeRepoPath(repoPath);
    if (!byRepo.has(key)) byRepo.set(key, { repoPath, repoName: repoName || repoPath.split(/[\\/]/).pop() || repoPath, machine, owned: false, engines: [] });
    return byRepo.get(key)!;
  };
  // A feature's worktree is where THAT feature works, not a repo to build the next one in.
  const worktrees = featureWorktreePaths();
  for (const a of agents) {
    if (worktrees.has(normalizeRepoPath(a.repo_path))) continue;
    const e = entry(a.repo_path, a.repo_name, a.machine);
    if (e.engines.some((x) => x.agentType === a.agent_type)) continue;   // newest per engine wins (ORDER BY last_seen)
    e.engines.push({ agentType: a.agent_type, agentId: a.id, status: a.status, name: a.name });
  }
  // "Owned" = the feature's project's repos (and, for an old-style goal, its projects' repos) —
  // goal-scope.ts is the one answer to that, so this list and the feature's reach cannot disagree.
  if (goalId) {
    for (const repo of goalRepos(goalId)) entry(repo, '', '').owned = true;
  }
  res.json([...byRepo.values()].sort((a, b) =>
    Number(b.owned) - Number(a.owned)
    || Number(b.engines.some((e) => e.status !== 'offline')) - Number(a.engines.some((e) => e.status !== 'offline'))
    || a.repoName.localeCompare(b.repoName)));
});

/** Every running or paused feature, as the world map draws it (lib/active-features.ts). */
router.get('/active', (_req, res) => {
  res.json(activeFeatures());
});

router.get('/', (req, res) => {
  const goalId = typeof req.query.goalId === 'string' ? req.query.goalId : '';
  const rows = goalId
    ? pilotsForGoal(goalId)
    : (db.prepare('SELECT id FROM goal_pilots ORDER BY created_at DESC LIMIT 100').all() as { id: string }[])
      .map((r) => getPilot(r.id)!).filter(Boolean);
  res.json(rows.map(pilotView));
});

/** What the planner was asked, verbatim — for the person who wants to see the prompt. */
router.get('/requests/:requestId', (req, res) => {
  const r = getRequest(req.params.requestId);
  if (!r) return res.status(404).json({ error: 'request not found' });
  res.json({ ...r, prompt: requestPrompt(r.id) });
});

/** Where the planner submits. Stores a proposal; creates nothing. */
router.post('/requests/:requestId/submit', asyncRoute(async (req, res) => {
  const body = (req.body ?? {}) as { result?: unknown };
  const raw = body.result !== undefined ? body.result : body;
  // The test writer and the checklist reviewer answer here too. Tests are async: NeonCore reads
  // and hashes the files the submission names before accepting it.
  const kind = getRequest(req.params.requestId)?.kind;
  if (kind === 'tests' || kind === 'review') {
    try {
      const out = await submitAcceptanceResult(req.params.requestId, raw);
      res.json({ ok: true, phase: getPilot(out.pilotId)?.phase, notes: out.notes, request: out.request });
    } catch (err) {
      if (err instanceof PilotError) return res.status(err.status).json({ error: err.message });
      console.error('[goal-pilot] acceptance submission failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  try {
    const out = submitPlannerResult(req.params.requestId, raw);
    // The scope is settled: ask for the pipeline straight away, on the same planner.
    if (out.needsPipeline) dispatchPlannerRequest(out.pilot.id, 'pipeline');
    // The narrative for a finished goal's report.
    if (out.summary) applyPlannerSummary(out.pilot.id, out.summary);
    emitPilotUpdate(out.pilot.id);
    const pilot = getPilot(out.pilot.id)!;
    // The moment the person is needed again: questions to answer, or a plan to review.
    if (pilot.phase === 'clarifying') {
      const round = pilot.rounds[pilot.rounds.length - 1];
      const n = round?.questions.length ?? 0;
      announcePilot(pilot.id, 'questions', `${n} question${n === 1 ? '' : 's'} to answer`,
        round?.message || 'The planner needs a few answers before anyone builds anything.', 'action');
    } else if (pilot.phase === 'proposed') {
      const n = pilot.proposal?.stages.length ?? 0;
      announcePilot(pilot.id, 'plan', 'plan ready to review',
        `The scope brief and ${n} proposed workflow${n === 1 ? '' : 's'} are waiting for you to accept.`, 'action');
    }
    res.json({ ok: true, phase: pilot.phase, notes: out.request.notes, request: out.request });
  } catch (err) { fail(res, err); }
}));

// ── the goal report ──────────────────────────────────────────────────────────

router.get('/:id/report', (req, res) => {
  const r = storedGoalReport(req.params.id);
  if (!r) return res.status(404).json({ error: 'no report yet — it is built when the last stage finishes' });
  res.json(r);
});

router.get('/:id/report/html', (req, res) => {
  const r = storedGoalReport(req.params.id);
  if (!r) return res.status(404).type('text/plain').send('No report yet — it is built when the last stage finishes.');
  res.type('text/html').send(renderGoalReportHtml(r));
});

router.get('/:id/report/markdown', (req, res) => {
  const r = storedGoalReport(req.params.id);
  if (!r) return res.status(404).type('text/plain').send('No report yet.');
  const name = `goal-report-${(r.goal.name || 'goal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.md`;
  res.type('text/markdown').set('Content-Disposition', `attachment; filename="${name}"`).send(renderGoalReportMarkdown(r));
});

/**
 * Build (or rebuild) the report now — for a pipeline that was cancelled or stopped part-way, whose
 * stages that DID run deserve an account too. Asks the planner for the summary again.
 */
router.post('/:id/report', (req, res) => {
  const pilot = getPilot(req.params.id);
  if (!pilot) return res.status(404).json({ error: 'pilot not found' });
  const ran = db.prepare(`SELECT COUNT(*) AS n FROM goal_pilot_stages WHERE pilot_id = ? AND run_id != ''`).get(pilot.id) as { n: number };
  if (ran.n === 0) return res.status(409).json({ error: 'nothing has run yet — there is nothing to report' });
  const report = generateGoalReport(pilot.id);
  try { dispatchPlannerRequest(pilot.id, 'report'); } catch { /* the compiled report stands on its own */ }
  emitPilotUpdate(pilot.id);
  res.json(report);
});

router.get('/:id', (req, res) => {
  const v = view(req.params.id);
  if (!v) return res.status(404).json({ error: 'pilot not found' });
  res.json(v);
});

/**
 * Start piloting a goal: from a NEW goal (the intake creates it) or an existing one (`goalId`).
 * Dispatches the first scoping request to the planner cartridge.
 */
router.post('/', (req, res) => {
  const { intake: rawIntake, goalId, projectId, plannerAgentId, replace, files, repos: rawRepos } = (req.body ?? {}) as {
    intake?: unknown; goalId?: string; projectId?: string; plannerAgentId?: string; replace?: boolean;
    /** The project's repos this feature involves ([] or absent = all of them). */
    repos?: unknown;
    /** Files for the feature (lib/feature-files.ts) — stored before the first scoping request, so it carries them. */
    files?: unknown;
  };
  const { intake, missing } = normalizeIntake(rawIntake);
  if (missing.length) return res.status(400).json({ error: `please answer: ${missing.join('; ')}` });
  if (!plannerAgentId) return res.status(400).json({ error: 'pick the cartridge that does the planning' });
  if (!cartridgeExists(plannerAgentId)) return res.status(400).json({ error: 'that planner cartridge no longer exists' });

  let gid = (goalId || '').trim();
  try {
    if (gid) {
      if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(gid)) return res.status(404).json({ error: 'feature not found' });
      const active = activePilotForGoal(gid);
      if (active) {
        if (!replace) return res.status(409).json({ error: 'this feature already has a pilot in progress — cancel it or start over', pilotId: active.id });
        cancelPilot(active.id);
      }
      // What the intake says about the feature is written onto it, so piloting a backlog feature
      // that was only a title leaves it with its description, "done when", date and budget.
      const budget = intake.budgetUsd ? Number(intake.budgetUsd) : null;
      db.prepare(`UPDATE goals SET name = ?, description = ?, success_metric = ?, budget_usd = COALESCE(?, budget_usd),
                         target_date = CASE WHEN ? != '' THEN ? ELSE target_date END, autonomy = ?, updated_at = ? WHERE id = ?`)
        .run(intake.goal.slice(0, 200), intake.context ?? '', intake.done ?? '', budget && budget > 0 ? budget : null,
          intake.deadline ?? '', intake.deadline ?? '', involvementOf(intake.involvement).goalAutonomy, new Date().toISOString(), gid);
    } else {
      // A new feature. Inside a project when one is named — the normal path — else an unfiled one.
      if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
        return res.status(404).json({ error: 'project not found' });
      }
      const budget = intake.budgetUsd ? Number(intake.budgetUsd) : null;
      gid = createFeature({
        projectId: projectId || '', name: intake.goal, description: intake.context ?? '', successMetric: intake.done ?? '',
        budgetUsd: budget && budget > 0 ? budget : null, targetDate: intake.deadline ?? '',
        autonomy: involvementOf(intake.involvement).goalAutonomy,
      });
    }

    if (Array.isArray(files) && files.length) {
      try { addFeatureFiles(gid, files); }
      catch (err) {
        // A feature created by this request and left without its files is not what was asked for.
        if (!goalId) deleteFeatureCascade(gid);
        return res.status(err instanceof FeatureFileError ? err.status : 500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    const featureRepos = Array.isArray(rawRepos) ? [...new Set(rawRepos.map((r) => String(r ?? '').trim()).filter(Boolean))] : [];
    const pilot = createPilotRow({ goalId: gid, plannerAgentId, intake, featureRepos });
    const out = dispatchPlannerRequest(pilot.id, 'scope');
    res.status(201).json({ pilot: view(pilot.id), goalId: gid, queued: out.queued, error: out.error ?? null });
  } catch (err) { fail(res, err); }
});

router.post('/:id/answers', (req, res) => {
  try {
    const pilot = recordAnswers(req.params.id, (req.body ?? {}).answers);
    const out = dispatchPlannerRequest(pilot.id, 'scope');
    res.json({ pilot: view(pilot.id), queued: out.queued, error: out.error ?? null });
  } catch (err) { fail(res, err); }
});

router.post('/:id/retry', (req, res) => {
  try {
    const agentId = (req.body ?? {}).agentId as string | undefined;
    if (agentId && !cartridgeExists(agentId)) return res.status(400).json({ error: 'that cartridge no longer exists' });
    const out = retryPlannerRequest(req.params.id, agentId);
    res.json({ pilot: view(req.params.id), queued: out.queued, error: out.error ?? null });
  } catch (err) { fail(res, err); }
});

router.post('/:id/accept-plan', (req, res) => {
  try {
    const { brief, stages, criteria } = (req.body ?? {}) as { brief?: Record<string, unknown>; stages?: unknown; criteria?: unknown };
    const pilot = acceptPlan(req.params.id, { brief, stages, criteria });
    emitPilotUpdate(pilot.id);
    docsChangedForGoal(pilot.goalId);   // the feature now has its intent and criteria
    res.json(view(pilot.id));
  } catch (err) { fail(res, err); }
});

router.post('/:id/revise', (req, res) => {
  try {
    const pilot = revisePlan(req.params.id);
    emitPilotUpdate(pilot.id);
    res.json(view(pilot.id));
  } catch (err) { fail(res, err); }
});

router.post('/:id/start', (req, res) => {
  try {
    const { repos, assignments, isolate } = (req.body ?? {}) as { repos?: unknown; assignments?: unknown; isolate?: unknown };
    const pilot = startPilot(req.params.id, { repos, assignments, isolate });
    res.json(view(pilot.id));
  } catch (err) { fail(res, err); }
});

/** Push the feature's branches and open its PRs now (they open by themselves when the pipeline ends). */
router.post('/:id/workspace/prs', asyncRoute(async (req, res) => {
  if (!getPilot(req.params.id)?.workspace) return res.status(404).json({ error: 'this feature does not run on its own branch' });
  await openPrsAndTell(req.params.id);
  res.json(view(req.params.id));
}));

/** The person says merge: every PR of the feature (all or none), then the worktrees, branches and cartridges go. */
router.post('/:id/workspace/merge', asyncRoute(async (req, res) => {
  if (!getPilot(req.params.id)?.workspace) return res.status(404).json({ error: 'this feature does not run on its own branch' });
  await mergeAndTell(req.params.id);
  res.json(view(req.params.id));
}));

/** After a merge: end the worktrees' cartridges and remove the worktrees (`force` = even unmerged). */
router.post('/:id/workspace/cleanup', asyncRoute(async (req, res) => {
  if (!getPilot(req.params.id)?.workspace) return res.status(404).json({ error: 'this feature does not run on its own branch' });
  await cleanupWorkspace(req.params.id, { force: req.body?.force === true });
  res.json(view(req.params.id));
}));

router.post('/:id/pause', (req, res) => {
  try { res.json(view(pausePilot(req.params.id).id)); } catch (err) { fail(res, err); }
});

router.post('/:id/resume', (req, res) => {
  try { res.json(view(resumePilot(req.params.id).id)); } catch (err) { fail(res, err); }
});

router.post('/:id/cancel', (req, res) => {
  try { res.json(view(cancelPilot(req.params.id).id)); } catch (err) { fail(res, err); }
});

router.post('/:id/stages/:stageId/retry', (req, res) => {
  try { res.json(view(retryStage(req.params.id, req.params.stageId).id)); } catch (err) { fail(res, err); }
});

router.post('/:id/stages/:stageId/skip', (req, res) => {
  try { res.json(view(skipStage(req.params.id, req.params.stageId).id)); } catch (err) { fail(res, err); }
});

// ── the acceptance contract (lib/acceptance-runner.ts) ─────────────────────────
//
// Every decision here is the PERSON's: approve & lock, ask for changes, unlock, restore, accept a
// change, confirm a verdict. None of these is reachable from an agent's tool.

const acceptanceRoute = (fn: (id: string, body: Record<string, unknown>) => unknown | Promise<unknown>, status = 200) =>
  asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    try {
      await fn(id, (req.body ?? {}) as Record<string, unknown>);
      res.status(status).json(view(id));
    } catch (err) { fail(res, err); }
  });

/** Run the tests under review now (before any work they should FAIL). Answers at once; results follow by socket. */
router.post('/:id/acceptance/run', acceptanceRoute((id) => { void runBaseline(id).catch((e) => console.warn('[acceptance] baseline:', e)); }, 202));

/** Approve & lock — locks once a fresh run shows every test red (or `confirmPassing`). */
router.post('/:id/acceptance/approve', acceptanceRoute((id, b) => approveTests(id, { confirmPassing: b.confirmPassing === true })));

router.post('/:id/acceptance/changes', acceptanceRoute((id, b) => requestTestChanges(id, String(b.feedback ?? ''))));

router.post('/:id/acceptance/request', acceptanceRoute((id) => askAgainForTests(id)));

router.post('/:id/acceptance/criteria/:criterionId/unlock', asyncRoute(async (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    unlockCriterion(req.params.id, req.params.criterionId, { reason: b.reason, text: b.text, expect: b.expect });
    res.json(view(req.params.id));
  } catch (err) { fail(res, err); }
}));

router.post('/:id/acceptance/restore', acceptanceRoute((id) => restoreTests(id)));

router.post('/:id/acceptance/accept-change', acceptanceRoute((id, b) => acceptTestChange(id, b.reason)));

router.post('/:id/acceptance/checklist', acceptanceRoute((id, b) => confirmChecklist(id, b.confirmations)));

/** A delivered feature, checked again: the locked tests now, then a fresh checklist review. Answers at once; results follow by socket. */
router.post('/:id/acceptance/retest', acceptanceRoute((id) => { void retestAcceptance(id).catch((e) => console.warn('[acceptance] retest:', e)); }, 202));
/** After a retest that still shows gaps: one workflow stage for exactly those criteria, then the checks again. */
router.post('/:id/acceptance/fix', acceptanceRoute((id) => { addFixStage(id); }));

router.post('/:id/stages/:stageId/verify', asyncRoute(async (req, res) => {
  try { verifyAgain(req.params.id, req.params.stageId); res.json(view(req.params.id)); } catch (err) { fail(res, err); }
}));

/** Delete the pilot record. A live pipeline is cancelled first; its runs and projects stay as history. */
router.delete('/:id', (req, res) => {
  const pilot = getPilot(req.params.id);
  if (!pilot) return res.status(404).json({ error: 'pilot not found' });
  if (pilot.phase !== 'completed' && pilot.phase !== 'cancelled') cancelPilot(pilot.id);
  deletePilotRows(pilot.id);
  emitPilotUpdate(pilot.id);
  res.status(204).send();
});

export default router;
