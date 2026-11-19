/**
 * GOAL PILOT — the parts that DO things: asking the planner, and running the accepted pipeline.
 *
 * lib/goal-pilot.ts owns the records and the transitions a person or a planner causes. This file
 * owns the side effects: dispatching planner prompts to a cartridge, creating projects and runs,
 * and moving from one stage to the next.
 *
 * ── HOW A PIPELINE ADVANCES ────────────────────────────────────────────────────────────
 * Stages run strictly in order. `advancePilot` looks at the first stage that is not finished and
 * does the one thing that stage needs: launch it, wait for it, or record how its run ended. It is
 * called from three places and is idempotent, so calling it too often is harmless:
 *   · the run-finished event (lib/run-events.ts) — the next stage starts the moment a run ends;
 *   · a 10-second sweep — the backstop, and what picks up a stage that was WAITING for a
 *     cartridge to come online or stop being busy;
 *   · every route that changes a pilot (start, resume, retry, skip).
 *
 * ── WHY A STAGE NAMES A REPO, NOT A CARTRIDGE ──────────────────────────────────────────
 * A cartridge's id changes every time it restarts (lib/cartridge-exists.ts). A pipeline that runs
 * for a day would be pinned to ids that no longer exist by its third stage. So the person picks
 * repo + engine, and the live cartridge is resolved when each stage starts. None live → the stage
 * WAITS, says why, and starts by itself when one connects. A busy cartridge is waited for too —
 * the same rule as every other launch (lib/queue-if-busy.ts): never start work on top of work.
 *
 * ── WHAT A STAGE KNOWS ─────────────────────────────────────────────────────────────────
 * The accepted brief's goal fields were written onto the goal, so they reach every step through
 * the goal brief (the run's project belongs to this goal — see the `goalId` option of
 * sendCommandToAgent). Everything else — the slug, what is in scope, every decision made while
 * scoping, this stage's focus, and what the earlier stages produced — is the run's launch
 * context, which the workflow's first step receives (lib/workflow-context.ts).
 */
import path from 'path';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { getIO } from '../ws.js';
import { guardBusy } from './queue-if-busy.js';
import { isCartridgeBusy } from './queue-runner.js';
import { sendCommandToAgent, noChannel, inboxPending, whenInboxSettles } from './send-command.js';
import { featureFilesBlock } from './feature-files.js';
import { cartridgeExists } from './cartridge-exists.js';
import { agentIdForRepoAndType, normalizeRepoPath, setProjectCartridges, getProjectCartridges } from './resolve-agent.js';
import { cloneTemplateAsRun } from './workflow-from-template.js';
import { templateNeedsParticipants } from './workflow-launch.js';
import { isReportStep } from './workflow-report.js';
import { workflowNeedsAttention, type Attention } from './workflow-attention.js';
import { goalCostUsd } from './goal-cost.js';
import { onRunFinished } from './run-events.js';
import { notifyAll } from './channels.js';
import { pauseRun, resumeRun, cancelRun } from '../routes/workflows.js';
import {
  type GoalPilot, type PilotStage, type PilotRequest, type Staffing, type StageStatus,
  PilotError, BRIEF_FIELDS, getPilot, getStage, getRequest, requestPrompt, stagesOf, requestsOf, pilotsInPhase,
  createRequestRow, setRequestPrompt, failRequest, setPhase, setAttention, updateStage,
  involvementOf, templateIdForName, answerText, PLANNER_KINDS,
} from './goal-pilot.js';
import { buildScopePrompt, buildPipelinePrompt, buildReportPrompt, buildTestsPrompt, buildReviewPrompt } from './goal-pilot-prompts.js';
import { getContract, createContract, testCriteria, checklistCriteria, contractBlocksWork } from './acceptance-contract.js';
import {
  driveContract, verifyStage, advanceReviewStage, waiveTests, resetTestsRequest, contractView, type ContractView,
} from './acceptance-runner.js';
import { generateGoalReport } from './goal-pilot-report.js';
import { docsChangedForGoal } from './project-docs.js';

/** The engines that can carry a stage — the three NeonCore supports (see the engine-removal test). */
export const PILOT_ENGINES = ['claude', 'codex', 'gridlight'] as const;
const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', gridlight: 'Gridlight',
};

export const SWEEP_INTERVAL_MS = 10_000;
const STAGE_SUMMARY_MAX = 1500;
const CONTEXT_EARLIER_MAX = 700;

const nowIso = () => new Date().toISOString();

export function emitPilotUpdate(pilotId: string): void {
  try { getIO().emit('goal_pilot_updated', { id: pilotId }); } catch { /* no socket server (tests, scripts) */ }
}

/**
 * Tell the person — on every channel (desktop, phone) and in the dashboard's bell.
 *
 * Called on TRANSITIONS only (questions arrived, a plan arrived, the pipeline stopped, a stage is
 * waiting for a cartridge that is not running, it finished), never from a sweep that repeats —
 * the same reason the attention notifier keys on transitions. A stage that needs a decision is
 * announced by the attention notifier itself: the stage is a normal run.
 */
export function announcePilot(pilotId: string, event: string, headline: string, body: string, urgency: 'action' | 'info', runId = ''): void {
  const pilot = getPilot(pilotId);
  if (!pilot) return;
  const goalName = (db.prepare('SELECT name FROM goals WHERE id = ?').get(pilot.goalId) as { name?: string } | undefined)?.name ?? 'Feature';
  const title = `${goalName} — ${headline}`;
  try {
    getIO().emit('workflow_notification', {
      id: randomUUID(), workflowId: runId, workflowName: `Feature · ${goalName}`,
      title, body, projects: [], timestamp: nowIso(),
    });
  } catch { /* no socket server */ }
  notifyAll({
    title, body, urgency,
    data: { type: urgency === 'action' ? 'goal_pilot_action' : 'goal_pilot_info', event, pilotId, goalId: pilot.goalId, ...(runId ? { workflowId: runId } : {}) },
  }).catch(() => {});
}

/** A planner request failed: the pilot cannot move until the person asks again. */
function announcePlannerFailed(pilotId: string, error: string): void {
  announcePilot(pilotId, 'planner-failed', 'the planner did not answer', `${error} Ask again from the feature's page.`, 'action');
}

// ── asking the planner ─────────────────────────────────────────────────────────

export interface DispatchOutcome {
  request: PilotRequest;
  queued: boolean;
  /** Set when the request could not be delivered at all. The request row is marked failed. */
  error?: string;
}

/**
 * Put the next question to the planner cartridge. `kind` follows from the phase: scoping asks
 * for questions-or-brief, planning asks for the pipeline.
 *
 * A busy planner gets the request through the queue, as its own `goal-pilot` kind (see
 * queue-kinds.ts): it lines up behind the cartridge's running work instead of landing on top of
 * it, and the lane moves on when the planner SUBMITS — not on a work-standard report, which a
 * planning turn never files. Delivery failures mark the request failed rather than leaving it
 * pending forever with nothing listening.
 */
export function dispatchPlannerRequest(pilotId: string, kind: PilotRequest['kind'], agentOverride?: string): DispatchOutcome {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  const planner = PLANNER_KINDS.has(kind);
  const agentId = (agentOverride || (planner ? pilot.plannerAgentId : '') || '').trim();
  const request = createRequestRow(pilot, kind, agentId);
  // A report request is asked of a FINISHED pilot: it stays finished while the summary is written.
  // Tests and review requests belong to a running pipeline's stages: the phase stays `running`.
  if (kind === 'scope' || kind === 'pipeline') setPhase(pilot.id, kind === 'scope' ? 'scoping' : 'planning');

  const fail = (error: string): DispatchOutcome => {
    failRequest(request.id, error);
    emitPilotUpdate(pilot.id);
    // A report already exists with a compiled summary: a planner that cannot add the narrative
    // leaves nothing blocked, so nobody is called for it. A stage's request failing stops its
    // stage (advancePilot), which announces itself.
    if (kind === 'scope' || kind === 'pipeline') announcePlannerFailed(pilot.id, error);
    return { request: getRequest(request.id)!, queued: false, error };
  };

  if (!cartridgeExists(agentId)) return fail(planner ? 'the planner cartridge no longer exists — pick another one and retry' : 'that cartridge no longer exists');

  const fresh = getPilot(pilot.id)!;
  const contract = kind === 'tests' || kind === 'review' ? getContract(pilot.id) : null;
  if ((kind === 'tests' || kind === 'review') && !contract) return fail('this pilot has no acceptance contract');
  const prompt = kind === 'scope' ? buildScopePrompt(fresh, request.id)
    : kind === 'pipeline' ? buildPipelinePrompt(fresh, request.id)
    : kind === 'tests' ? buildTestsPrompt(fresh, contract!, request.id)
    : kind === 'review' ? buildReviewPrompt(fresh, contract!, request.id, workDone(pilot.id))
    : buildReportPrompt(fresh, request.id, fresh.report ?? {});

  const guard = guardBusy({ kind: 'goal-pilot', targets: [agentId], payload: { requestId: request.id, agentId } });
  if ('error' in guard) return fail(guard.error);
  setRequestPrompt(request.id, prompt, guard.queued);
  if (guard.queued) {
    emitPilotUpdate(pilot.id);
    return { request: getRequest(request.id)!, queued: true };
  }
  const sent = deliverPlannerRequest(request.id, agentId, { failIfNoChannel: true });
  if (!sent.ok) return { request: getRequest(request.id)!, queued: false, error: sent.error };
  return { request: getRequest(request.id)!, queued: false };
}

/**
 * Send a stored planner request to a cartridge. THE one delivery path — immediate dispatch and
 * the queue's `goal-pilot` kind both call it, so they cannot differ in what the planner sees.
 *
 * `standard: false`: a planning conversation, not work on the repo — no work-standard offer and
 * no goal brief (the prompt carries the goal in full). A request that is no longer pending
 * (answered, or superseded by a retry while it waited in the queue) is not sent at all.
 *
 * `failIfNoChannel`: the immediate path fails a request nothing is listening for. The queue path
 * does not — a persisted command is drained by the relay on reconnect, and the queue has its own
 * liveness budget for an unreachable target.
 */
export function deliverPlannerRequest(
  requestId: string, agentId: string, opts: { failIfNoChannel?: boolean } = {},
): { ok: boolean; error?: string } {
  const req = getRequest(requestId);
  if (!req || req.status !== 'pending') return { ok: false, error: 'the request is no longer waiting to be sent' };
  const planner = PLANNER_KINDS.has(req.kind);
  const who = planner ? 'the planner cartridge' : 'the cartridge';
  // Only a scoping/planning failure blocks the person with nothing else to show for it; a stage's
  // failed request stops its stage, which announces itself.
  const announce = req.kind === 'scope' || req.kind === 'pipeline';
  if (agentId && agentId !== req.agentId) {
    // The queue moved a relaunched cartridge's old id to its live row: follow it.
    db.prepare('UPDATE goal_pilot_requests SET agent_id = ? WHERE id = ?').run(agentId, req.id);
    if (planner) db.prepare('UPDATE goal_pilots SET planner_agent_id = ? WHERE id = ?').run(agentId, req.pilotId);
  }
  // The feature's files, copied into this cartridge's repo — whatever the request is for.
  const goalId = (db.prepare('SELECT goal_id FROM goal_pilots WHERE id = ?').get(req.pilotId) as { goal_id?: string } | undefined)?.goal_id ?? '';
  const repo = (db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(agentId) as { repo_path?: string } | undefined)?.repo_path ?? '';
  const cmd = sendCommandToAgent(agentId, requestPrompt(req.id) + (goalId ? featureFilesBlock(goalId, [repo]) : ''), false, undefined, { standard: false });
  if (!cmd) {
    const error = `${who} no longer exists — pick another one and retry`;
    failRequest(req.id, error);
    emitPilotUpdate(req.pilotId);
    if (announce) announcePlannerFailed(req.pilotId, error);
    if (opts.failIfNoChannel) return { ok: false, error };
    throw new Error(error);
  }
  if (noChannel(cmd) && opts.failIfNoChannel) {
    const error = `${who} did not receive the request — is it connected?`;
    failRequest(req.id, error);
    emitPilotUpdate(req.pilotId);
    if (announce) announcePlannerFailed(req.pilotId, error);
    return { ok: false, error };
  }
  db.prepare('UPDATE goal_pilot_requests SET dispatched_at = ? WHERE id = ?').run(nowIso(), req.id);
  if (inboxPending(cmd)) {
    void whenInboxSettles(cmd!.id)?.then((out) => {
      if (out.ok) return;
      failRequest(req.id, `the cartridge's inbox refused the request (${out.detail}) — is it connected?`);
      emitPilotUpdate(req.pilotId);
      if (announce) announcePlannerFailed(req.pilotId, 'The planner cartridge could not be reached.');
    });
  }
  emitPilotUpdate(req.pilotId);
  return { ok: true };
}

/**
 * How long a planner may sit idle, after the request reached it, without submitting — before the
 * request is called unanswered. A real planner that stops without calling the tool (it answered in
 * chat instead, or gave up) would otherwise leave the pilot "thinking…" forever.
 */
export const PLANNER_SILENT_MS = 3 * 60_000;

/**
 * Has this delivered request's cartridge gone quiet without submitting? Idle (not working, not
 * waiting on a person) and no activity for PLANNER_SILENT_MS since it was delivered.
 */
export function requestWentSilent(requestId: string, now = Date.now()): boolean {
  const row = db.prepare('SELECT status, agent_id, dispatched_at FROM goal_pilot_requests WHERE id = ?')
    .get(requestId) as { status?: string; agent_id?: string; dispatched_at?: string | null } | undefined;
  if (!row || row.status !== 'pending' || !row.dispatched_at) return false;
  if (now - Date.parse(row.dispatched_at) < PLANNER_SILENT_MS) return false;
  const agent = db.prepare('SELECT status FROM agents WHERE id = ?').get(row.agent_id) as { status?: string } | undefined;
  if (agent?.status === 'working' || agent?.status === 'waiting') return false;   // still at it, or asking something
  const last = (db.prepare('SELECT MAX(timestamp) AS t FROM activity WHERE agent_id = ?').get(row.agent_id) as { t?: string | null }).t;
  if (last && now - Date.parse(last) < PLANNER_SILENT_MS) return false;
  return true;
}

/** Fail a delivered request whose planner has gone quiet without answering. */
export function checkSilentPlanner(pilotId: string, now = Date.now()): boolean {
  const pilot = getPilot(pilotId);
  if (!pilot || (pilot.phase !== 'scoping' && pilot.phase !== 'planning')) return false;
  if (!requestWentSilent(pilot.currentRequestId, now)) return false;
  failRequest(pilot.currentRequestId, 'the planner finished without submitting an answer — ask again, or pick another planner');
  emitPilotUpdate(pilot.id);
  announcePlannerFailed(pilot.id, 'The planner finished without submitting an answer.');
  return true;
}

/** What the workflow stages say they did — for the checklist reviewer, as claims to check. */
export function workDone(pilotId: string): { title: string; summary: string }[] {
  return stagesOf(pilotId).filter((s) => s.kind === 'workflow' && s.status === 'completed')
    .map((s) => ({ title: s.title, summary: s.resultSummary || '(no summary recorded)' }));
}

/** Ask again — after a failure, a cartridge that went away, or a planner that never answered. */
export function retryPlannerRequest(pilotId: string, agentId?: string): DispatchOutcome {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase === 'scoping') return dispatchPlannerRequest(pilot.id, 'scope', agentId);
  if (pilot.phase === 'planning') return dispatchPlannerRequest(pilot.id, 'pipeline', agentId);
  if (pilot.report) return dispatchPlannerRequest(pilot.id, 'report', agentId);
  throw new PilotError(`the pilot is ${pilot.phase} — nothing is waiting on the planner`);
}

// ── starting the pipeline ─────────────────────────────────────────────────────

/** The stage keys of the contract's two stages — assignable to a repo like any workflow stage. */
export const ACCEPTANCE_STAGE_KEY = 'acceptance';
export const REVIEW_STAGE_KEY = 'review';

export interface StartInput {
  repos?: unknown;
  /**
   * stage key → repo path, or → a LIST of repo paths for a stage worked by several cartridges
   * together (a Confer stage). A stage not named runs in the first repo; a Confer stage not named
   * runs on every chosen repo.
   */
  assignments?: unknown;
}

/**
 * The project under this goal that owns `repo`, creating one if none does. Reusing matters: a
 * goal that already has a project for the repo must not grow a duplicate each time it is piloted.
 */
function projectForRepo(goalId: string, goalName: string, repo: string): string {
  const want = normalizeRepoPath(repo);
  const existing = db.prepare('SELECT id, primary_repo FROM projects WHERE goal_id = ? ORDER BY created_at').all(goalId) as
    { id: string; primary_repo: string }[];
  for (const p of existing) {
    const repos = [p.primary_repo, ...getProjectCartridges(p.id)].filter(Boolean);
    if (repos.some((r) => normalizeRepoPath(r) === want)) return p.id;
  }
  const id = randomUUID();
  const t = nowIso();
  db.prepare(
    `INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, goalId, `${goalName} · ${path.basename(repo)}`, 'Created by Goal Pilot to run this goal\'s pipeline in this repo.',
    repo, '#8b5cf6', t, t);
  setProjectCartridges(id, [repo]);
  return id;
}

/**
 * THE ONLY PATH from an accepted plan to projects and runs. Validates the staffing, attaches a
 * project per repo to the goal (which is what makes the goal's cost, reach and brief see the
 * work), writes the stage rows, and launches the first stage.
 */
export function startPilot(pilotId: string, input: StartInput): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase !== 'staffing') throw new PilotError(`the pilot is ${pilot.phase} — accept a plan before starting it`);
  if (!pilot.plan) throw new PilotError('there is no accepted plan');

  const repos: Staffing['repos'] = [];
  for (const r of Array.isArray(input.repos) ? input.repos : []) {
    if (!r || typeof r !== 'object') continue;
    const repoPath = String((r as Record<string, unknown>).repoPath ?? '').trim();
    const agentType = String((r as Record<string, unknown>).agentType ?? 'claude').trim();
    if (!repoPath) continue;
    if (!(PILOT_ENGINES as readonly string[]).includes(agentType)) throw new PilotError(`unknown engine "${agentType}"`, 400);
    if (repos.some((x) => normalizeRepoPath(x.repoPath) === normalizeRepoPath(repoPath))) continue;
    repos.push({ repoPath, agentType });
  }
  if (repos.length === 0) throw new PilotError('choose at least one repo to run the pipeline in', 400);

  const assignments = input.assignments && typeof input.assignments === 'object' ? input.assignments as Record<string, unknown> : {};
  const chosen = (key: string, want: string) => {
    const hit = repos.find((r) => normalizeRepoPath(r.repoPath) === normalizeRepoPath(want));
    if (!hit) throw new PilotError(`stage "${key}" is assigned to ${want}, which is not one of the chosen repos`, 400);
    return hit;
  };
  const repoFor = (key: string) => {
    const raw = assignments[key];
    const want = String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim();
    if (!want) return repos[0];
    return chosen(key, want);
  };
  /**
   * The participants of a stage worked by several cartridges together. A Confer stage (its
   * template has a confer step with no roster of its own) NEEDS two or more: the list it was
   * assigned, or every chosen repo. Any stage may be given a list of two or more, which runs
   * it as a confer (the Run button's "Run on" with several cartridges). Empty = one cartridge.
   */
  const participantsFor = (key: string, title: string, templateId: string) => {
    const raw = assignments[key];
    const listed = Array.isArray(raw)
      ? [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))].map((w) => chosen(key, w))
      : [];
    if (listed.length >= 2) return listed;
    if (templateId && templateNeedsParticipants(templateId)) {
      if (listed.length === 0 && repos.length >= 2) return repos;
      throw new PilotError(
        `stage "${title}" is a confer and needs two or more repos working together — choose at least two repos and assign them to it`, 400);
    }
    return [];
  };

  const goal = db.prepare('SELECT name, project_id FROM goals WHERE id = ?').get(pilot.goalId) as { name: string; project_id: string } | undefined;
  if (!goal) throw new PilotError('the feature no longer exists', 404);
  const involvement = involvementOf(pilot.involvement);
  // A feature of a project runs in that project: every stage's run is attached to it, and a repo
  // picked here that the project did not list yet is added to it — the project stays the one place
  // that says which repos its work happens in. Only an old-style goal (no project) still gets a
  // project per repo created under it.
  const featureProject = goal.project_id && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(goal.project_id)
    ? goal.project_id : '';

  // The acceptance contract (lib/acceptance-contract.ts): test criteria get a stage 0 that writes
  // their tests before anything is built; checklist criteria get an independent review at the end.
  const criteria = pilot.plan.criteria ?? [];
  const tested = testCriteria({ criteria });
  const checklist = checklistCriteria({ criteria });
  const testsRepo = repoFor(ACCEPTANCE_STAGE_KEY);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM goal_pilot_stages WHERE pilot_id = ?').run(pilot.id);
    const projectByRepo = new Map<string, string>();
    const projectOf = (repoPath: string) => {
      if (featureProject) return featureProject;
      const norm = normalizeRepoPath(repoPath);
      if (!projectByRepo.has(norm)) projectByRepo.set(norm, projectForRepo(pilot.goalId, goal.name, repoPath));
      return projectByRepo.get(norm)!;
    };
    if (featureProject) {
      const owned = getProjectCartridges(featureProject);
      const missing = repos.map((r) => r.repoPath).filter((p) => !owned.some((o) => normalizeRepoPath(o) === normalizeRepoPath(p)));
      if (missing.length) setProjectCartridges(featureProject, [...owned, ...missing]);
    }
    const insert = db.prepare(
      `INSERT INTO goal_pilot_stages (id, pilot_id, position, kind, stage_key, template_id, template_name, title, why, focus,
         repo_path, agent_type, project_id, status, participants)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    let position = 0;
    if (tested.length) {
      insert.run(randomUUID(), pilot.id, position++, 'acceptance', ACCEPTANCE_STAGE_KEY, '', '', 'Write the acceptance tests',
        `One failing test per criterion (${tested.map((c) => c.id).join(', ')}), written before anything is built. You approve them; then they are locked and NeonCore runs them after every stage.`,
        '', testsRepo.repoPath, testsRepo.agentType, projectOf(testsRepo.repoPath), '[]');
    }
    pilot.plan!.stages.forEach((s) => {
      const templateId = templateIdForName(s.template) ?? '';
      const team = participantsFor(s.key, s.title, templateId);
      const staff = team[0] ?? repoFor(s.key);
      insert.run(randomUUID(), pilot.id, position++, 'workflow', s.key, templateId, s.template, s.title, s.why, s.focus,
        staff.repoPath, staff.agentType, projectOf(staff.repoPath), JSON.stringify(team));
    });
    if (checklist.length) {
      insert.run(randomUUID(), pilot.id, position++, 'review', REVIEW_STAGE_KEY, '', '', 'Independent review of the checklist',
        `A cartridge that did not do the work judges ${checklist.map((c) => c.id).join(', ')} against what exists; you confirm each verdict.`,
        '', testsRepo.repoPath, testsRepo.agentType, projectOf(testsRepo.repoPath), '[]');
    }
    if (criteria.length) {
      createContract({ pilotId: pilot.id, goalId: pilot.goalId, criteria, repoPath: testsRepo.repoPath, agentType: testsRepo.agentType });
    }
    // The posture the person chose reaches every prompt as the goal's autonomy line.
    db.prepare('UPDATE goals SET autonomy = ?, updated_at = ? WHERE id = ?').run(involvement.goalAutonomy, nowIso(), pilot.goalId);
    db.prepare(`UPDATE goal_pilots SET staffing = ?, phase = 'running', started_at = ?, attention = '', updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ repos } satisfies Staffing), nowIso(), nowIso(), pilot.id);
  });
  tx();

  advancePilot(pilot.id);
  emitPilotUpdate(pilot.id);
  return getPilot(pilot.id)!;
}

// ── the stage's launch context ────────────────────────────────────────────────

/** What kind of stage it is, in a word — the workflow's name, or what the contract's stages do. */
export function stageKindLabel(s: Pick<PilotStage, 'kind' | 'template'>): string {
  return s.kind === 'acceptance' ? 'acceptance tests' : s.kind === 'review' ? 'independent review' : s.template;
}

function clipText(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Everything a stage's first step needs that does not already arrive in the goal brief. */
export function buildStageContext(pilot: GoalPilot, stage: PilotStage, stages: PilotStage[]): string {
  const brief = pilot.plan?.brief;
  const goalName = (db.prepare('SELECT name FROM goals WHERE id = ?').get(pilot.goalId) as { name?: string } | undefined)?.name ?? '';
  const idx = stages.findIndex((s) => s.id === stage.id);
  const earlier = stages.slice(0, idx).filter((s) => s.status === 'completed' || s.status === 'skipped');
  const next = stages[idx + 1];
  const decided = pilot.rounds.flatMap((r) => r.questions.map((q) => `- ${q.text} → ${answerText(q, r.answers[q.id])}`));
  const inGoalBrief = BRIEF_FIELDS.filter((f) => f.goalColumn && brief?.[f.key]).map((f) => f.label.toLowerCase());

  const project = db.prepare('SELECT p.name, p.docs_published_at, p.primary_repo FROM projects p JOIN goals g ON g.project_id = p.id WHERE g.id = ?')
    .get(pilot.goalId) as { name?: string; docs_published_at?: string; primary_repo?: string } | undefined;
  const parts: string[] = [
    `# Feature pipeline — stage ${idx + 1} of ${stages.length}: ${stage.title}`,
    `This run is one stage of a pipeline planned for the feature "${goalName}"${project?.name ? ` of the project "${project.name}"` : ''}. The person settled the scope `
      + 'before any work started: treat everything below as decided and do not ask it again. If something is '
      + 'still genuinely open, go with what is most consistent with these decisions and state the assumption '
      + 'in your report.',
  ];
  if (brief) {
    parts.push(`Feature slug: ${brief.slug} — use it wherever this workflow asks for [slug] (e.g. docs/${brief.slug}/).`);
    parts.push(`## Scope\n${brief.summary}`);
    if (brief.inScope) parts.push(`## In scope\n${brief.inScope}`);
    if (brief.assumptions) parts.push(`## Assumptions already made\n${brief.assumptions}`);
    if (inGoalBrief.length) parts.push(`(The feature's ${inGoalBrief.join(', ')} arrive with the goal brief on every step.)`);
  }
  if (decided.length) parts.push(`## Decisions made while scoping\n${decided.join('\n')}`);
  // The project's living spec, when it has been published into the repo (lib/project-docs.ts).
  if (project?.docs_published_at) {
    parts.push(`## The project's spec\ndocs/product/ in ${project.primary_repo || 'the main repo'} holds every feature of the project (README.md), `
      + 'each one\'s intent and criteria (features/<slug>.md) and how the product is built (ARCHITECTURE.md). Read what touches this '
      + 'stage; do not edit those files — NeonCore regenerates them.');
  }
  const contract = getContract(pilot.id);
  if (contract && contract.tests.length && contract.status !== 'waived') {
    parts.push(`## Acceptance contract\n${contract.tests.length} acceptance test${contract.tests.length === 1 ? '' : 's'} were written before any work and LOCKED by the person — `
      + 'they are listed in the [NeonCore acceptance contract] block. They define "done": make them pass by changing the product code, never the tests. '
      + 'NeonCore checks the files are unchanged and runs every one of them when this stage finishes.');
  }
  parts.push(`## This stage — ${stage.template}\n${stage.focus || stage.why || 'Run this workflow for the scope above.'}`);
  if (earlier.length) {
    parts.push(`## Earlier stages\n${earlier.map((s) => {
      const n = stages.indexOf(s) + 1;
      return s.status === 'skipped'
        ? `${n}. ${s.title} (${stageKindLabel(s)}) — skipped by the person.`
        : `${n}. ${s.title} (${stageKindLabel(s)}) — completed:\n${clipText(s.resultSummary || '(no summary recorded)', CONTEXT_EARLIER_MAX)}`;
    }).join('\n\n')}`);
  }
  if (next) parts.push(`## After this stage\nNext: ${next.title} (${stageKindLabel(next)}). Leave what it needs where it can find it, and say where in your report.`);
  // The feature's files, in every repo this stage works in.
  const files = featureFilesBlock(pilot.goalId, [stage.repoPath, ...stage.participants.map((p) => p.repoPath)]).trim();
  if (files) parts.push(`## Files attached to the feature\n${files}`);
  return parts.join('\n\n');
}

// ── running ───────────────────────────────────────────────────────────────────

/** The completion report if the run wrote one, else its last completed result. */
export function runSummary(runId: string): string {
  const steps = db.prepare(
    `SELECT name, result, executor_config FROM workflow_steps
      WHERE workflow_id = ? AND status = 'completed' AND result != '' ORDER BY completed_at`,
  ).all(runId) as { name: string; result: string; executor_config: string }[];
  if (steps.length === 0) return '';
  const report = steps.find((s) => {
    try { return isReportStep(JSON.parse(s.executor_config || '{}')); } catch { return false; }
  });
  const pick = report ?? steps[steps.length - 1];
  return clipText(pick.result, STAGE_SUMMARY_MAX);
}

/** A live cartridge of this engine in this repo, or null. Offline rows do not count. */
export function liveCartridge(repoPath: string, agentType: string): string | null {
  const id = agentIdForRepoAndType(repoPath, agentType);
  if (!id) return null;
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status?: string } | undefined;
  return row && row.status !== 'offline' ? id : null;
}

function setWaiting(stage: PilotStage, reason: string): void {
  if (stage.status === 'waiting' && stage.waitReason === reason) return;   // no event storm from the sweep
  updateStage(stage.id, { status: 'waiting', wait_reason: reason });
  emitPilotUpdate(stageOwner(stage.id));
}

function stageOwner(stageId: string): string {
  return (db.prepare('SELECT pilot_id FROM goal_pilot_stages WHERE id = ?').get(stageId) as { pilot_id?: string } | undefined)?.pilot_id ?? '';
}

export function stopPilot(pilotId: string, attention: string, announce = true): void {
  setPhase(pilotId, 'paused', { attention });
  emitPilotUpdate(pilotId);
  if (announce) announcePilot(pilotId, 'paused', 'the pipeline stopped and needs you', attention, 'action');
  console.warn(`[goal-pilot] ${pilotId.slice(0, 8)} paused: ${attention}`);
}

/**
 * The live cartridges of a stage worked by several cartridges, or why it must wait. Every
 * participant must be running and free: a confer never starts on top of live work.
 */
function stageTeam(stage: PilotStage): { ids: string[] } | { wait: string; needsCartridge: boolean } {
  const ids: string[] = [];
  for (const p of stage.participants) {
    const id = liveCartridge(p.repoPath, p.agentType);
    const engine = ENGINE_LABEL[p.agentType] ?? p.agentType;
    if (!id) {
      return { wait: `No ${engine} cartridge is running in ${path.basename(p.repoPath)} — this stage is worked by `
        + `${stage.participants.length} cartridges together. Launch one (Agents → + Launch) and it starts by itself.`, needsCartridge: true };
    }
    if (isCartridgeBusy(id)) {
      return { wait: `The ${engine} cartridge in ${path.basename(p.repoPath)} is busy with other work — this stage starts when all `
        + `${stage.participants.length} of its cartridges are free.`, needsCartridge: false };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length < 2) return { wait: 'This stage is worked by several cartridges together, but its participants resolve to one cartridge. Assign different repos or engines.', needsCartridge: true };
  return { ids };
}

function launchStage(pilot: GoalPilot, stage: PilotStage, stages: PilotStage[]): void {
  const repoName = path.basename(stage.repoPath);
  const engine = ENGINE_LABEL[stage.agentType] ?? stage.agentType;

  // A stage worked by several cartridges together: all of them, or it waits.
  let team: string[] | null = null;
  if (stage.participants.length >= 2) {
    const t = stageTeam(stage);
    if ('wait' in t) {
      if (t.needsCartridge && stage.waitReason !== t.wait) {
        announcePilot(pilot.id, 'stage-needs-cartridge', `stage ${stage.position + 1} needs its cartridges`, t.wait, 'action');
      }
      setWaiting(stage, t.wait);
      return;
    }
    team = t.ids;
  }

  const agentId = team ? team[0] : liveCartridge(stage.repoPath, stage.agentType);
  if (!agentId) {
    const reason = `No ${engine} cartridge is running in ${repoName}. Launch one (Agents → + Launch) and this stage starts by itself.`;
    // Announced once, when the stage starts waiting for this — waiting on a BUSY cartridge is not
    // announced: it resolves itself, and nobody needs to act.
    if (stage.waitReason !== reason) {
      announcePilot(pilot.id, 'stage-needs-cartridge', `stage ${stage.position + 1} needs a ${engine} cartridge`, reason, 'action');
    }
    setWaiting(stage, reason);
    return;
  }
  if (isCartridgeBusy(agentId)) {
    setWaiting(stage, `The ${engine} cartridge in ${repoName} is busy with other work — this stage starts when it is free.`);
    return;
  }

  // Budget: the same gate the heartbeat scheduler applies, for the same reason — a pipeline that
  // runs unattended must not spend past the ceiling the person set.
  const goal = db.prepare('SELECT budget_usd FROM goals WHERE id = ?').get(pilot.goalId) as { budget_usd: number | null } | undefined;
  if (goal?.budget_usd) {
    const spent = goalCostUsd(pilot.goalId);
    if (spent >= goal.budget_usd) {
      setWaiting(stage, `Budget reached ($${spent.toFixed(2)} of $${goal.budget_usd.toFixed(2)}).`);
      stopPilot(pilot.id, `The goal's budget is spent ($${spent.toFixed(2)} of $${goal.budget_usd.toFixed(2)}). Raise it on the goal, then resume.`);
      return;
    }
  }

  const templateId = (stage.templateId && db.prepare('SELECT 1 FROM workflows WHERE id = ? AND template_id IS NULL').get(stage.templateId))
    ? stage.templateId
    : templateIdForName(stage.template);
  if (!templateId) {
    updateStage(stage.id, { status: 'failed', wait_reason: '', completed_at: nowIso(), result_summary: `The "${stage.template}" workflow no longer exists.` });
    stopPilot(pilot.id, `Stage ${stage.position + 1} (${stage.title}) cannot run: the "${stage.template}" workflow was renamed or deleted. Skip it or cancel the pipeline.`);
    return;
  }

  const context = buildStageContext(pilot, stage, stages);
  const runId = cloneTemplateAsRun(templateId, stage.projectId || null, context, {
    agentId, autonomy: involvementOf(pilot.involvement).runAutonomy, goalId: pilot.goalId,
    ...(team ? { confer: { agentIds: team, mode: 'divide', isolation: 'shared' } } : {}),
  });
  if (!runId) {
    updateStage(stage.id, { status: 'failed', wait_reason: '', completed_at: nowIso(), result_summary: 'The workflow could not be cloned into a run.' });
    stopPilot(pilot.id, `Stage ${stage.position + 1} (${stage.title}) could not be launched.`);
    return;
  }
  updateStage(stage.id, {
    status: 'running', wait_reason: '', run_id: runId, agent_id: agentId, started_at: nowIso(),
    completed_at: null, result_summary: '', attempts: stage.attempts + 1,
  });
  console.log(`[goal-pilot] ${pilot.id.slice(0, 8)} stage ${stage.position + 1}/${stages.length} "${stage.title}" → run ${runId.slice(0, 8)} on ${agentId.slice(0, 8)}`);
  emitPilotUpdate(pilot.id);
}

const advancing = new Set<string>();

/**
 * Do whatever the pipeline's current stage needs. Idempotent and re-entrancy-safe: the run-
 * finished event, the sweep and the routes may all call it for the same pilot.
 */
export function advancePilot(pilotId: string): void {
  if (advancing.has(pilotId)) return;
  advancing.add(pilotId);
  try {
    // Bounded: each pass either returns or moves past a finished stage.
    for (let guard = 0; guard < 64; guard++) {
      let pilot = getPilot(pilotId);
      if (!pilot || pilot.phase !== 'running') return;
      if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(pilot.goalId)) {
        setPhase(pilot.id, 'cancelled', { attention: 'The feature was deleted.' });
        return;
      }
      // The acceptance contract first: it may have a tests request to send, a failed one to turn
      // into a stopped stage 0, and it decides whether workflow stages may start at all.
      const gate = driveContract(pilot);
      pilot = getPilot(pilotId);
      if (!pilot || pilot.phase !== 'running') return;
      const stages = stagesOf(pilot.id);
      const stage = stages.find((s) => s.status !== 'completed' && s.status !== 'skipped');
      if (!stage) {
        db.prepare(`UPDATE goal_pilots SET phase = 'completed', completed_at = ?, attention = '', updated_at = ? WHERE id = ?`)
          .run(nowIso(), nowIso(), pilot.id);
        console.log(`[goal-pilot] ${pilot.id.slice(0, 8)} completed all ${stages.length} stage(s)`);
        finishWithReport(pilot.id);
        return;
      }

      if (stage.status === 'failed' || stage.status === 'cancelled') {
        stopPilot(pilot.id, `Stage ${stage.position + 1} (${stage.title}) did not finish. Retry or skip it to continue.`);
        return;
      }

      // Stage 0: moved by driveContract (request out → review) and by the person (approve → locked).
      if (stage.kind === 'acceptance') {
        const c = getContract(pilot.id);
        if (!c || c.status === 'locked' || c.status === 'waived') {
          updateStage(stage.id, { status: 'completed', completed_at: stage.completedAt ?? nowIso(), wait_reason: '' });
          emitPilotUpdate(pilot.id);
          continue;
        }
        return;
      }

      if (stage.kind === 'review') {
        // An amendment in progress: the reviewer would judge against tests that are being rewritten.
        if ((stage.status === 'pending' || stage.status === 'waiting') && gate === 'blocked' && contractBlocksWork(getContract(pilot.id))) {
          setWaiting(stage, 'Waiting for the amended acceptance tests to be approved.');
          return;
        }
        if (advanceReviewStage(pilot, stage)) { emitPilotUpdate(pilot.id); continue; }
        return;
      }

      // A workflow stage whose run is done, being checked against the locked tests.
      if (stage.status === 'verifying') {
        if (stage.verifyState === 'tampered' || stage.verifyState === 'error') {
          stopPilot(pilot.id, stage.verifyState === 'tampered'
            ? `Stage ${stage.position + 1} (${stage.title}) changed locked acceptance tests. Restore the approved version, or accept the change.`
            : `Stage ${stage.position + 1} (${stage.title}) could not be checked against the acceptance tests. Check again to continue.`, false);
          return;
        }
        verifyStage(pilot.id, stage.id);
        return;
      }

      if (stage.status === 'running') {
        const run = db.prepare('SELECT status, error FROM workflows WHERE id = ?').get(stage.runId) as { status: string; error: string } | undefined;
        if (!run) {
          updateStage(stage.id, { status: 'failed', completed_at: nowIso(), result_summary: 'Its run was deleted.' });
          stopPilot(pilot.id, `Stage ${stage.position + 1} (${stage.title}): its run was deleted. Retry or skip the stage.`);
          return;
        }
        if (run.status === 'completed') {
          // NeonCore checks the work itself before the pipeline moves on: locked files unchanged,
          // then every criterion's test run (lib/acceptance-runner.ts).
          const c = getContract(pilot.id);
          if (c && c.tests.length && c.status !== 'waived') {
            updateStage(stage.id, { status: 'verifying', verify_state: 'pending', result_summary: runSummary(stage.runId) });
            emitPilotUpdate(pilot.id);
            verifyStage(pilot.id, stage.id);
            return;
          }
          updateStage(stage.id, { status: 'completed', completed_at: nowIso(), result_summary: runSummary(stage.runId) });
          emitPilotUpdate(pilot.id);
          continue;
        }
        if (run.status === 'failed' || run.status === 'cancelled') {
          const status: StageStatus = run.status === 'failed' ? 'failed' : 'cancelled';
          updateStage(stage.id, { status, completed_at: nowIso(), result_summary: runSummary(stage.runId) || run.error || '' });
          stopPilot(pilot.id, `Stage ${stage.position + 1} (${stage.title}) ${run.status === 'failed' ? 'failed' : 'was cancelled'}. Open its run to see why, then retry or skip it.`);
          return;
        }
        return;   // still running, or paused from its own card
      }

      // Nothing is built against tests that are still being written or reviewed.
      if (gate === 'blocked' && contractBlocksWork(getContract(pilot.id))) {
        setWaiting(stage, 'Waiting for the acceptance tests to be written and approved.');
        return;
      }

      launchStage(pilot, stage, stages);
      return;
    }
  } finally {
    advancing.delete(pilotId);
  }
}

/**
 * The pipeline is done: compile the goal report now (it never waits on a model), tell the person,
 * and ask the planner for the narrative summary on top.
 */
export function finishWithReport(pilotId: string): void {
  const report = generateGoalReport(pilotId);
  const finished = getPilot(pilotId);
  if (finished) docsChangedForGoal(finished.goalId);   // delivered: the spec's evidence just changed
  emitPilotUpdate(pilotId);
  const stages = stagesOf(pilotId).filter((s) => s.kind === 'workflow').length;
  const a = report?.acceptance;
  const criteria = a && a.total ? ` ${a.passing} of ${a.total} acceptance criteria pass on NeonCore's own check.` : '';
  announcePilot(pilotId, 'completed', `feature report ready${report ? ` — ${report.status}` : ''}`,
    `All ${stages} workflow${stages === 1 ? '' : 's'} finished.${criteria} The feature report is ready: read it, then mark the feature done.`,
    'action');
  if (report) {
    try { dispatchPlannerRequest(pilotId, 'report'); } catch (err) { console.warn('[goal-pilot] report summary request failed:', err); }
  }
}

export function sweepPilots(): void {
  for (const p of pilotsInPhase('running')) {
    try { advancePilot(p.id); } catch (err) { console.error(`[goal-pilot] advance ${p.id.slice(0, 8)} threw:`, err); }
  }
  for (const p of pilotsInPhase('scoping', 'planning')) {
    try { checkSilentPlanner(p.id); } catch (err) { console.error(`[goal-pilot] silence check ${p.id.slice(0, 8)} threw:`, err); }
  }
}

// ── person-driven controls ─────────────────────────────────────────────────────

function currentStage(pilotId: string): PilotStage | undefined {
  return stagesOf(pilotId).find((s) => s.status !== 'completed' && s.status !== 'skipped');
}

function runStatus(runId: string): string {
  return (db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status?: string } | undefined)?.status ?? '';
}

export function pausePilot(pilotId: string): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase !== 'running') throw new PilotError(`the pilot is ${pilot.phase}, not running`);
  const stage = currentStage(pilot.id);
  // Pausing the pipeline pauses its work: a "paused" pipeline whose run carries on is a lie.
  if (stage?.status === 'running' && runStatus(stage.runId) === 'running') pauseRun(stage.runId);
  stopPilot(pilot.id, 'Paused by you.', false);
  return getPilot(pilot.id)!;
}

export function resumePilot(pilotId: string): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase !== 'paused') throw new PilotError(`the pilot is ${pilot.phase}, not paused`);
  const stage = currentStage(pilot.id);
  if (stage && (stage.status === 'failed' || stage.status === 'cancelled')) {
    throw new PilotError(`stage ${stage.position + 1} (${stage.title}) did not finish — retry or skip it`);
  }
  if (stage?.status === 'verifying' && stage.verifyState === 'tampered') {
    throw new PilotError(`stage ${stage.position + 1} (${stage.title}) changed locked acceptance tests — restore them or accept the change first`);
  }
  // A check that could not run is simply tried again.
  if (stage?.status === 'verifying' && stage.verifyState === 'error') updateStage(stage.id, { verify_state: 'pending', wait_reason: '' });
  if (stage?.status === 'running' && stage.runId && runStatus(stage.runId) === 'paused') resumeRun(stage.runId);
  setPhase(pilot.id, 'running');
  advancePilot(pilot.id);
  emitPilotUpdate(pilot.id);
  return getPilot(pilot.id)!;
}

export function cancelPilot(pilotId: string): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  if (pilot.phase === 'completed' || pilot.phase === 'cancelled') throw new PilotError(`the pilot is already ${pilot.phase}`);
  const stages = stagesOf(pilot.id);
  const t = nowIso();
  for (const s of stages) {
    if (s.status === 'running' && s.runId && ['running', 'paused'].includes(runStatus(s.runId))) cancelRun(s.runId);
    if (['pending', 'waiting', 'running', 'review', 'verifying'].includes(s.status)) updateStage(s.id, { status: 'cancelled', wait_reason: '', completed_at: t });
  }
  db.prepare(`UPDATE goal_pilot_requests SET status = 'superseded', completed_at = ? WHERE pilot_id = ? AND status = 'pending'`).run(t, pilot.id);
  db.prepare(`UPDATE goal_pilots SET phase = 'cancelled', attention = '', completed_at = ?, updated_at = ? WHERE id = ?`).run(t, t, pilot.id);
  emitPilotUpdate(pilot.id);
  return getPilot(pilot.id)!;
}

function stageOf(pilotId: string, stageId: string): { pilot: GoalPilot; stage: PilotStage } {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  const stage = getStage(stageId);
  if (!stage || stageOwner(stageId) !== pilot.id) throw new PilotError('stage not found', 404);
  if (pilot.phase !== 'running' && pilot.phase !== 'paused') throw new PilotError(`the pilot is ${pilot.phase}`);
  return { pilot, stage };
}

/** Run a stage again from the start — after a failure, a cancel, or a stage that is stuck waiting. */
export function retryStage(pilotId: string, stageId: string): GoalPilot {
  const { pilot, stage } = stageOf(pilotId, stageId);
  if (!['failed', 'cancelled', 'waiting'].includes(stage.status)) throw new PilotError(`stage is ${stage.status} — only a failed, cancelled or waiting stage can be retried`);
  // Stage 0 asks for the tests afresh; the review stage asks a reviewer afresh.
  if (stage.kind === 'acceptance') resetTestsRequest(pilot.id);
  updateStage(stage.id, { status: 'pending', wait_reason: '', completed_at: null, request_id: '' });
  setPhase(pilot.id, 'running');
  advancePilot(pilot.id);
  emitPilotUpdate(pilot.id);
  return getPilot(pilot.id)!;
}

/** Move past a stage. A stage with a live run has that run cancelled — skipping is not "keep going in the background". */
export function skipStage(pilotId: string, stageId: string): GoalPilot {
  const { pilot, stage } = stageOf(pilotId, stageId);
  if (stage.status === 'completed' || stage.status === 'skipped') throw new PilotError(`stage is already ${stage.status}`);
  if (stage.status === 'verifying') {
    throw new PilotError('this stage\'s work is being checked against the acceptance tests — resolve the check (restore, accept, or check again) rather than skipping it');
  }
  // Skipping stage 0 runs the pipeline WITHOUT acceptance tests; the report says so.
  if (stage.kind === 'acceptance') waiveTests(pilot.id);
  // A skipped review's request is withdrawn, so a late verdict cannot land on a stage nobody runs.
  if (stage.kind === 'review' && stage.requestId) {
    db.prepare(`UPDATE goal_pilot_requests SET status = 'superseded', completed_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), stage.requestId);
  }
  if (stage.status === 'running' && stage.runId && ['running', 'paused'].includes(runStatus(stage.runId))) cancelRun(stage.runId);
  updateStage(stage.id, { status: 'skipped', wait_reason: '', completed_at: nowIso() });
  setPhase(pilot.id, 'running');
  advancePilot(pilot.id);
  emitPilotUpdate(pilot.id);
  return getPilot(pilot.id)!;
}

// ── the view the dashboard reads ──────────────────────────────────────────────

export interface StageView extends PilotStage {
  runStatus: string;
  progress: { completed: number; total: number } | null;
  attention: Attention | null;
  agentName: string;
}

export interface PilotView extends GoalPilot {
  goalName: string;
  /** The project the feature belongs to ('' for an old-style goal). */
  projectId: string;
  projectName: string;
  plannerName: string;
  stages: StageView[];
  /** The acceptance contract with every criterion's evidence (lib/acceptance-runner.ts contractView). */
  acceptance: ContractView | null;
  currentRequest: PilotRequest | null;
  requests: PilotRequest[];
}

function agentName(id: string): string {
  if (!id) return '';
  const a = db.prepare('SELECT name, repo_name, agent_type FROM agents WHERE id = ?').get(id) as
    { name?: string; repo_name?: string; agent_type?: string } | undefined;
  if (!a) return '';
  return `${ENGINE_LABEL[a.agent_type ?? ''] ?? a.agent_type ?? ''} · ${a.repo_name || a.name || id.slice(0, 8)}`;
}

export function pilotView(pilot: GoalPilot): PilotView {
  const stages = stagesOf(pilot.id).map((s): StageView => {
    const runStatus = s.runId ? ((db.prepare('SELECT status FROM workflows WHERE id = ?').get(s.runId) as { status?: string } | undefined)?.status ?? 'deleted') : '';
    let progress: StageView['progress'] = null;
    if (s.runId) {
      const c = db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('completed','skipped') THEN 1 ELSE 0 END) AS done
           FROM workflow_steps WHERE workflow_id = ?`,
      ).get(s.runId) as { total: number; done: number | null };
      progress = { completed: c.done ?? 0, total: c.total };
    }
    return {
      ...s, runStatus, progress,
      attention: s.status === 'running' && s.runId ? workflowNeedsAttention(s.runId) : null,
      agentName: agentName(s.agentId),
    };
  });
  const g = db.prepare('SELECT g.name, g.project_id, p.name AS project_name FROM goals g LEFT JOIN projects p ON p.id = g.project_id WHERE g.id = ?')
    .get(pilot.goalId) as { name?: string; project_id?: string; project_name?: string | null } | undefined;
  return {
    ...pilot,
    goalName: g?.name ?? '',
    projectId: g?.project_id ?? '',
    projectName: g?.project_name ?? '',
    plannerName: agentName(pilot.plannerAgentId),
    stages,
    acceptance: contractView(getContract(pilot.id)),
    currentRequest: pilot.currentRequestId ? getRequest(pilot.currentRequestId) : null,
    requests: requestsOf(pilot.id).slice(0, 12),
  };
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/** Pilots that own a stage running this run. */
function pilotsForRun(runId: string): string[] {
  return (db.prepare(`SELECT DISTINCT pilot_id FROM goal_pilot_stages WHERE run_id = ?`).all(runId) as { pilot_id: string }[])
    .map((r) => r.pilot_id);
}

/** React to finished runs immediately; sweep as the backstop. */
export function startGoalPilotRunner(): void {
  if (!unsubscribe) {
    unsubscribe = onRunFinished((runId) => {
      // Deferred: the executor is mid-tick when it emits, and launching the next stage clones a
      // run — better done once that tick has unwound.
      setImmediate(() => {
        for (const id of pilotsForRun(runId)) {
          try { advancePilot(id); } catch (err) { console.error('[goal-pilot] advance after run finished threw:', err); }
        }
      });
    });
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepPilots, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
    console.log(`[goal-pilot] Runner started — sweeping every ${SWEEP_INTERVAL_MS / 1000}s`);
  }
}

export function stopGoalPilotRunner(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}

export { setAttention };
