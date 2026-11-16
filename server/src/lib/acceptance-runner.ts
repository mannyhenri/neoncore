/**
 * THE ACCEPTANCE CONTRACT — the parts that DO things (records and rules: lib/acceptance-contract.ts).
 *
 *   · asking a cartridge to write the tests (stage 0, "ask for changes", an amendment), taking its
 *     submission — reading and hashing the files it names — and putting it in front of the person;
 *   · running the tests: the BASELINE before any work (they should fail), and the CHECK after every
 *     workflow stage (hash every locked file, then run every criterion's command);
 *   · the person's decisions: approve & lock, ask for changes, unlock a criterion, restore changed
 *     tests or accept the change;
 *   · the independent CHECKLIST review at the end, and the person's confirmation of each verdict.
 *
 * Commands run through lib/repo-access.ts: on this machine directly, or through the runner of the
 * machine the repo is on. Checks are async and can take minutes; they never block a request — the
 * route starts them, the dashboard follows along through `goal_pilot_updated`.
 *
 * The pipeline itself (lib/goal-pilot-runner.ts) calls in here at three points: `driveContract` at
 * the top of every advance (is a tests request due? are workflow stages allowed to start?),
 * `verifyStage` when a workflow stage's run completes, and `advanceReviewStage` for the review stage.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { disarmOnReport } from './work-standard.js';
import { isCartridgeBusy } from './queue-runner.js';
import { normalizeRepoPath } from './resolve-agent.js';
import { repoAccessFor, checkTimeoutMs, RepoAccessError, type RepoAccess } from './repo-access.js';
import {
  type AcceptanceContract, type CheckResult, type CriterionTest, type Verification, type ChecklistVerdict, type Amendment,
  getContract, updateContract, criteriaToWrite, checklistCriteria, testCriteria, normalizeTestsSubmission, testsHash,
  lockedFiles, findTampering, verificationStatus, criteriaText, criteriaHash, criterionStates,
} from './acceptance-contract.js';
import {
  type GoalPilot, type PilotStage, PilotError, getPilot, getRequest, getStage, stagesOf, updateStage, setPhase,
} from './goal-pilot.js';
import {
  emitPilotUpdate, announcePilot, advancePilot, stopPilot, liveCartridge, dispatchPlannerRequest, requestWentSilent,
} from './goal-pilot-runner.js';

const nowIso = () => new Date().toISOString();
const MAX_VERIFICATIONS = 40;
const ENGINE_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gridlight: 'Gridlight' };

// ── what is in flight (memory only: a restart re-runs a pending check from the stage's state) ──

export interface ContractActivity { kind: 'baseline' | 'verify' | 'restore'; done: number; total: number; stageId: string }
const activity = new Map<string, ContractActivity>();
const baselines = new Map<string, Promise<void>>();
const verifying = new Set<string>();

export function contractActivity(contractId: string): ContractActivity | null {
  return activity.get(contractId) ?? null;
}

/** TEST ONLY — wait for every check in flight. */
export async function settleAcceptanceForTests(): Promise<void> {
  for (let i = 0; i < 50 && (baselines.size || verifying.size); i++) {
    await Promise.all([...baselines.values()]);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function acceptanceStage(pilotId: string): PilotStage | undefined {
  return stagesOf(pilotId).find((s) => s.kind === 'acceptance');
}

function pilotOrThrow(pilotId: string): GoalPilot {
  const pilot = getPilot(pilotId);
  if (!pilot) throw new PilotError('pilot not found', 404);
  return pilot;
}

function contractOrThrow(pilotId: string): AcceptanceContract {
  const c = getContract(pilotId);
  if (!c) throw new PilotError('this pilot has no acceptance contract', 404);
  return c;
}

function access(c: AcceptanceContract): RepoAccess {
  try { return repoAccessFor(c.repoPath); } catch (err) {
    throw new PilotError(err instanceof Error ? err.message : String(err), 503);
  }
}

async function runCheck(a: RepoAccess, t: CriterionTest): Promise<CheckResult> {
  const r = await a.run(t.command, checkTimeoutMs());
  return {
    criterionId: t.criterionId, command: t.command, exitCode: r.exitCode, passed: r.exitCode === 0 && !r.timedOut,
    timedOut: r.timedOut, output: r.output, durationMs: r.durationMs, at: nowIso(),
  };
}

// ── the tests request ───────────────────────────────────────────────────────────

/**
 * Keep the contract moving, and say whether workflow work may proceed.
 *
 *   'ready'    locked (or waived, or no contract) — stages may launch and be checked
 *   'blocked'  tests are being written or reviewed — stages wait
 *
 * While drafting, makes sure a tests request is out: dispatches one when none is (the first time,
 * after "ask for changes", after an unlock), waits when the repo's cartridge is offline or busy,
 * and turns a failed request into a failed stage 0 (or, for an amendment, a line on the contract).
 * Never re-dispatches a FAILED request by itself — the person asks again.
 */
export function driveContract(pilot: GoalPilot): 'ready' | 'blocked' {
  const c = getContract(pilot.id);
  if (!c || c.status === 'locked' || c.status === 'waived') return 'ready';
  const stage0 = acceptanceStage(pilot.id);
  const stageOpen = stage0 && stage0.status !== 'completed' && stage0.status !== 'skipped';

  if (c.status === 'review') {
    if (stageOpen && stage0!.status !== 'review') updateStage(stage0!.id, { status: 'review', wait_reason: '' });
    // The person asked to approve and the run that decides it is not going (a restart lost it):
    // run it again, or decide from the one already on record.
    if (c.approval && !c.approval.blocked && !baselines.has(c.id)) {
      if (baselineIsFresh(c) || c.baseline?.error) evaluateApproval(pilot.id);
      else void runBaseline(pilot.id).catch((err) => console.warn('[acceptance] baseline after restart failed:', err));
    }
    return 'blocked';
  }

  const req = c.requestId ? getRequest(c.requestId) : null;
  if (req?.status === 'pending') {
    if (requestWentSilent(req.id)) {
      db.prepare(`UPDATE goal_pilot_requests SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
        .run('the cartridge finished without submitting the tests', nowIso(), req.id);
    } else {
      return 'blocked';
    }
  }
  const after = req ? getRequest(req.id) : null;
  if (after?.status === 'failed') {
    const why = after.error || 'no detail';
    if (stageOpen) {
      if (stage0!.status !== 'failed') {
        updateStage(stage0!.id, { status: 'failed', completed_at: nowIso(), result_summary: `The acceptance tests were not written: ${why}` });
        if (pilot.phase === 'running') stopPilot(pilot.id, `Stage ${stage0!.position + 1} (${stage0!.title}) failed: ${why}. Retry it, or skip it to run without acceptance tests.`);
      }
    } else if (c.waitReason !== `The request failed: ${why}`) {
      updateContract(c.id, { waitReason: `The request failed: ${why}` });
      emitPilotUpdate(pilot.id);
    }
    return 'blocked';
  }
  if (stageOpen && (stage0!.status === 'failed' || stage0!.status === 'cancelled')) return 'blocked';
  if (pilot.phase !== 'running' && !c.amending) return 'blocked';

  // Due: send one.
  const repoName = path.basename(c.repoPath);
  const engine = ENGINE_LABEL[c.agentType] ?? c.agentType;
  const agentId = liveCartridge(c.repoPath, c.agentType);
  // Said once, when it starts waiting for this — the sweep re-checks every 10 s and must not storm.
  const waitFor = (reason: string, announce: boolean) => {
    let changed = false;
    if (c.waitReason !== reason) {
      updateContract(c.id, { waitReason: reason });
      if (announce) announcePilot(pilot.id, 'tests-need-cartridge', `the acceptance tests need a ${engine} cartridge`, reason, 'action');
      changed = true;
    }
    if (stageOpen && (stage0!.status !== 'waiting' || stage0!.waitReason !== reason)) {
      updateStage(stage0!.id, { status: 'waiting', wait_reason: reason });
      changed = true;
    }
    if (changed) emitPilotUpdate(pilot.id);
    return 'blocked' as const;
  };
  if (!agentId) return waitFor(`No ${engine} cartridge is running in ${repoName}. Launch one (Agents → + Launch) and the acceptance tests get written by itself.`, true);
  if (isCartridgeBusy(agentId)) return waitFor(`The ${engine} cartridge in ${repoName} is busy — the acceptance tests are requested when it is free.`, false);

  const out = dispatchPlannerRequest(pilot.id, 'tests', agentId);
  updateContract(c.id, { requestId: out.request.id, waitReason: '' });
  if (stageOpen) {
    updateStage(stage0!.id, {
      status: 'running', wait_reason: '', agent_id: agentId, request_id: out.request.id, started_at: stage0!.startedAt ?? nowIso(),
      completed_at: null, attempts: stage0!.attempts + 1,
    });
  }
  emitPilotUpdate(pilot.id);
  return 'blocked';
}

export interface AcceptanceSubmitOutcome { pilotId: string; notes: string[]; request: ReturnType<typeof getRequest> }

/**
 * A tests or review request answered. Tests: the files are READ and hashed now — a submission that
 * names files that do not exist is refused with the list, so the agent can write them and submit
 * again. Nothing is locked: the contract goes to the person for review.
 */
export async function submitAcceptanceResult(requestId: string, raw: unknown): Promise<AcceptanceSubmitOutcome> {
  const req = getRequest(requestId);
  if (!req) throw new PilotError('request not found', 404);
  if (req.status === 'superseded') throw new PilotError('this request was superseded by a newer one — nothing was recorded');
  if (req.status === 'ready') throw new PilotError('this request was already answered');
  const pilot = pilotOrThrow(req.pilotId);
  const c = contractOrThrow(pilot.id);
  return req.kind === 'tests' ? submitTests(pilot, c, req.id, raw) : submitReview(pilot, c, req.id, raw);
}

async function submitTests(pilot: GoalPilot, c: AcceptanceContract, requestId: string, raw: unknown): Promise<AcceptanceSubmitOutcome> {
  if (c.requestId !== requestId || c.status !== 'drafting') throw new PilotError('the contract is no longer waiting for these tests');
  const wanted = criteriaToWrite(c);
  const norm = normalizeTestsSubmission(raw, wanted);
  if (!norm.value) throw new PilotError(`submission rejected: ${norm.errors.join('; ')}`, 422);

  const a = access(c);
  const paths = [...new Set(norm.value.tests.flatMap((t) => t.files))];
  let reads;
  try { reads = await a.readFiles(paths); } catch (err) {
    throw new PilotError(`NeonCore could not read the test files: ${err instanceof Error ? err.message : String(err)}`, 503);
  }
  const byPath = new Map(reads.map((r) => [r.path, r]));
  const missing = paths.filter((p) => !byPath.get(p)?.exists);
  const unreadable = paths.filter((p) => byPath.get(p)?.exists && byPath.get(p)?.error);
  if (missing.length || unreadable.length) {
    throw new PilotError(`submission rejected: ${[
      missing.length ? `these files do not exist in ${path.basename(c.repoPath)}: ${missing.join(', ')} — write them, then submit again` : '',
      unreadable.length ? `these files cannot be used: ${unreadable.map((p) => `${p} (${byPath.get(p)!.error})`).join(', ')}` : '',
    ].filter(Boolean).join('; ')}`, 422);
  }

  const submitted: CriterionTest[] = norm.value.tests.map((t) => ({
    criterionId: t.criterionId, command: t.command,
    files: t.files.map((p) => { const r = byPath.get(p)!; return { path: p, sha256: r.sha256, bytes: r.bytes, content: r.content }; }),
  }));
  // An amendment replaces only the unlocked criteria's tests; the rest stay as locked.
  const draft = (c.amending ? [...c.tests.filter((t) => !wanted.some((w) => w.id === t.criterionId)), ...submitted] : submitted)
    .sort((x, y) => Number(x.criterionId.slice(3)) - Number(y.criterionId.slice(3)));

  // The files were read asynchronously: make sure nothing moved on meanwhile.
  const still = getContract(pilot.id);
  const reqNow = getRequest(requestId);
  if (!still || still.requestId !== requestId || still.status !== 'drafting' || reqNow?.status !== 'pending') {
    throw new PilotError('the contract moved on while the files were being read — nothing was recorded');
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE goal_pilot_requests SET status = ?, result = ?, notes = ?, error = ?, completed_at = ? WHERE id = ?')
      .run('ready', JSON.stringify({ tests: norm.value!.tests, notes: norm.value!.notes }), JSON.stringify(norm.notes), '', nowIso(), requestId);
    updateContract(c.id, { status: 'review', draftTests: draft, testNotes: norm.value!.notes, feedback: '', approval: null, waitReason: '' });
    const stage0 = acceptanceStage(pilot.id);
    if (stage0 && stage0.status !== 'completed' && stage0.status !== 'skipped') updateStage(stage0.id, { status: 'review', wait_reason: '' });
  });
  tx();
  // The submission is this turn's completion: the work standard is satisfied by it.
  disarmOnReport(db, reqNow.agentId);
  emitPilotUpdate(pilot.id);
  const n = submitted.length;
  announcePilot(pilot.id, 'tests-ready', `${n} acceptance test${n === 1 ? '' : 's'} to review`,
    `Check that each one encodes what you expect, run them (they should fail — nothing is built yet), then approve to lock them.${c.amending ? ` (Amendment: ${c.amending.criterionIds.join(', ')}.)` : ''}`,
    'action');
  return { pilotId: pilot.id, notes: norm.notes, request: getRequest(requestId) };
}

// ── the baseline and the lock ───────────────────────────────────────────────────

/**
 * Run the tests under review, before any work. Expected: every one FAILS. Shared: a second click
 * while one is running joins it. When the person has already asked to approve, the outcome decides
 * the lock (see evaluateApproval).
 */
export function runBaseline(pilotId: string): Promise<void> {
  const c = contractOrThrow(pilotId);
  if (c.status !== 'review') throw new PilotError(`the tests are ${c.status} — there is nothing under review to run`);
  const existing = baselines.get(c.id);
  if (existing) return existing;
  const tests = c.draftTests;
  let a: RepoAccess;
  try { a = repoAccessFor(c.repoPath); } catch (err) {
    // Unreachable repo (its machine's runner is offline): recorded as this run's outcome, so an
    // approval waiting on it says why instead of waiting forever — and nothing retries in a loop.
    updateContract(c.id, { baseline: { testsHash: testsHash(tests), at: nowIso(), results: [], error: err instanceof Error ? err.message : String(err) } });
    if (c.approval) evaluateApproval(pilotId);
    emitPilotUpdate(pilotId);
    return Promise.resolve();
  }
  activity.set(c.id, { kind: 'baseline', done: 0, total: tests.length, stageId: '' });
  emitPilotUpdate(pilotId);
  const job = (async () => {
    const results: CheckResult[] = [];
    let error = '';
    try {
      for (const t of tests) {
        results.push(await runCheck(a, t));
        activity.set(c.id, { kind: 'baseline', done: results.length, total: tests.length, stageId: '' });
        emitPilotUpdate(pilotId);
      }
    } catch (err) {
      error = err instanceof RepoAccessError || err instanceof Error ? err.message : String(err);
    }
    const now = getContract(pilotId);
    if (now && now.id === c.id) {
      updateContract(c.id, { baseline: { testsHash: testsHash(tests), at: nowIso(), results, error } });
      if (now.approval && now.status === 'review') evaluateApproval(pilotId);
    }
  })().finally(() => {
    activity.delete(c.id);
    baselines.delete(c.id);
    emitPilotUpdate(pilotId);
  });
  baselines.set(c.id, job);
  return job;
}

function baselineIsFresh(c: AcceptanceContract): boolean {
  return !!c.baseline && !c.baseline.error && c.baseline.testsHash === testsHash(c.draftTests) && c.baseline.results.length === c.draftTests.length;
}

/**
 * "Approve & lock". Locks as soon as a fresh baseline shows every test RED. A test that already
 * passes before any work proves nothing about the work — the approval stops there and says which,
 * unless the person confirmed they want it anyway (`confirmPassing`).
 */
export function approveTests(pilotId: string, opts: { confirmPassing?: boolean } = {}): AcceptanceContract {
  pilotOrThrow(pilotId);
  const c = contractOrThrow(pilotId);
  if (c.status !== 'review') throw new PilotError(`the tests are ${c.status}, not waiting for approval`);
  updateContract(c.id, { approval: { requestedAt: nowIso(), confirmPassing: !!opts.confirmPassing, blocked: '' } });
  if (baselineIsFresh(c)) evaluateApproval(pilotId);
  else void runBaseline(pilotId).catch((err) => console.warn('[acceptance] baseline failed:', err));
  emitPilotUpdate(pilotId);
  return getContract(pilotId)!;
}

function evaluateApproval(pilotId: string): void {
  const c = getContract(pilotId);
  if (!c || c.status !== 'review' || !c.approval) return;
  const block = (blocked: string) => {
    updateContract(c.id, { approval: { ...c.approval!, blocked } });
    emitPilotUpdate(pilotId);
    announcePilot(pilotId, 'approval-blocked', 'the acceptance tests were not locked', blocked, 'action');
  };
  if (c.baseline?.error) return block(`The tests could not be run: ${c.baseline.error}`);
  if (!baselineIsFresh(c)) return;
  const green = c.baseline!.results.filter((r) => r.passed).map((r) => r.criterionId);
  if (green.length && !c.approval.confirmPassing) {
    return block(`${green.join(', ')} already pass${green.length === 1 ? 'es' : ''} before any work — a test that passes now proves nothing about this work. Ask for changes, or approve anyway.`);
  }
  lockContract(pilotId);
}

function lockContract(pilotId: string): void {
  const c = getContract(pilotId)!;
  const version = c.version + 1;
  const red = c.baseline?.results.filter((r) => !r.passed).length ?? 0;
  updateContract(c.id, {
    status: 'locked', version, tests: c.draftTests, draftTests: [], lockedAt: nowIso(), amending: null, approval: null,
    feedback: '', waitReason: '',
  });
  const stage0 = acceptanceStage(pilotId);
  if (stage0 && stage0.status === 'review') {
    updateStage(stage0.id, {
      status: 'completed', completed_at: nowIso(), wait_reason: '',
      result_summary: `${c.draftTests.length} acceptance test${c.draftTests.length === 1 ? '' : 's'} approved and locked (v${version}). Before any work: ${red}/${c.draftTests.length} failing${red === c.draftTests.length ? ', as they should' : ''}.`,
    });
  }
  console.log(`[acceptance] ${pilotId.slice(0, 8)} contract locked v${version} (${c.draftTests.length} tests)`);
  emitPilotUpdate(pilotId);
  advancePilot(pilotId);
}

/** "Ask for changes": back to the test writer with the person's feedback. */
export function requestTestChanges(pilotId: string, feedback: string): AcceptanceContract {
  const pilot = pilotOrThrow(pilotId);
  const c = contractOrThrow(pilotId);
  if (c.status !== 'review') throw new PilotError(`the tests are ${c.status}, not under review`);
  const text = String(feedback ?? '').trim();
  if (text.length < 5) throw new PilotError('say what should change — it is sent to the agent writing the tests', 400);
  updateContract(c.id, {
    status: 'drafting', feedback: text.slice(0, 2000), requestId: '', approval: null, waitReason: '',
    amendments: [...c.amendments, { at: nowIso(), kind: 'changes-requested', criterionIds: criteriaToWrite(c).map((x) => x.id), reason: text.slice(0, 2000), version: c.version }],
  });
  const stage0 = acceptanceStage(pilotId);
  if (stage0 && stage0.status === 'review') updateStage(stage0.id, { status: 'pending', wait_reason: '' });
  driveContract(getPilot(pilot.id)!);
  emitPilotUpdate(pilotId);
  return getContract(pilotId)!;
}

/** Ask the test writer again after its request failed (an amendment's; stage 0 uses stage retry). */
export function askAgainForTests(pilotId: string): AcceptanceContract {
  const pilot = pilotOrThrow(pilotId);
  const c = contractOrThrow(pilotId);
  if (c.status !== 'drafting') throw new PilotError(`the tests are ${c.status} — nothing is being written`);
  const req = c.requestId ? getRequest(c.requestId) : null;
  if (req?.status === 'pending') throw new PilotError('a request for these tests is already out');
  updateContract(c.id, { requestId: '', waitReason: '' });
  driveContract(getPilot(pilot.id)!);
  return getContract(pilotId)!;
}

/**
 * Only a PERSON unlocks a test: with a reason, optionally with new wording for the criterion. The
 * old test stays in force for the check until the rewritten one is approved; stages that have not
 * started wait for the new lock.
 */
export function unlockCriterion(pilotId: string, criterionId: string, input: { reason?: unknown; text?: unknown; expect?: unknown }): AcceptanceContract {
  const pilot = pilotOrThrow(pilotId);
  if (pilot.phase !== 'running' && pilot.phase !== 'paused') throw new PilotError(`the pilot is ${pilot.phase} — a finished pipeline's contract cannot change`);
  const c = contractOrThrow(pilotId);
  if (c.status !== 'locked') throw new PilotError(`the contract is ${c.status} — finish the current review first`);
  const cr = c.criteria.find((x) => x.id === criterionId);
  if (!cr) throw new PilotError(`no criterion ${criterionId}`, 404);
  if (cr.verify !== 'test') throw new PilotError(`${criterionId} is a checklist item — it has no test to unlock`, 400);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw new PilotError('give the reason for unlocking — it is recorded as an amendment in the report', 400);
  const text = String(input.text ?? '').trim() || cr.text;
  const expect = String(input.expect ?? '').trim() || cr.expect;
  const criteria = c.criteria.map((x) => (x.id === criterionId ? { ...x, text, expect } : x));
  const amendment: Amendment = {
    at: nowIso(), kind: 'unlock', criterionIds: [criterionId], reason: reason.slice(0, 2000), version: c.version + 1,
    ...(text !== cr.text || expect !== cr.expect ? { before: { text: cr.text, expect: cr.expect }, after: { text, expect } } : {}),
  };
  updateContract(c.id, {
    status: 'drafting', criteria, criteriaHash: criteriaHash(criteria), amending: { criterionIds: [criterionId], reason },
    requestId: '', feedback: '', approval: null, waitReason: '', amendments: [...c.amendments, amendment],
  });
  // The goal's own text follows the contract — it is what every agent reads in the goal brief.
  db.prepare('UPDATE goals SET acceptance_criteria = ?, updated_at = ? WHERE id = ?').run(criteriaText(criteria), nowIso(), c.goalId);
  driveContract(getPilot(pilot.id)!);
  emitPilotUpdate(pilotId);
  return getContract(pilotId)!;
}

/** Skipping stage 0: the pipeline runs without acceptance tests, and the report says so. */
export function waiveTests(pilotId: string): void {
  const c = getContract(pilotId);
  if (!c || c.status === 'locked' || c.status === 'waived') return;
  const req = c.requestId ? getRequest(c.requestId) : null;
  if (req?.status === 'pending') {
    db.prepare(`UPDATE goal_pilot_requests SET status = 'superseded', completed_at = ? WHERE id = ?`).run(nowIso(), req.id);
  }
  updateContract(c.id, {
    status: 'waived', draftTests: [], approval: null, waitReason: '',
    amendments: [...c.amendments, { at: nowIso(), kind: 'waive', criterionIds: testCriteria(c).map((x) => x.id), reason: 'The person skipped writing the acceptance tests.', version: c.version }],
  });
}

/** Stage 0 retried: clear the failed request so a fresh one goes out. */
export function resetTestsRequest(pilotId: string): void {
  const c = getContract(pilotId);
  if (!c || c.status === 'locked' || c.status === 'waived') return;
  updateContract(c.id, { status: 'drafting', requestId: '', waitReason: '' });
}

// ── the check after every stage ─────────────────────────────────────────────────

/**
 * Check a finished workflow stage against the contract: first the HASH of every locked file (any
 * change stops the pipeline — only the person decides what happens to a changed test), then every
 * criterion's command. The stage completes with "x/n criteria passing" and the pipeline moves on.
 * Idempotent: a stage already being checked is not checked twice.
 */
export function verifyStage(pilotId: string, stageId: string): Promise<void> | null {
  if (verifying.has(stageId)) return null;
  const c = getContract(pilotId);
  const stage = getStage(stageId);
  if (!stage) return null;
  if (!c || c.tests.length === 0 || c.status === 'waived') {
    updateStage(stageId, { status: 'completed', verify_state: 'done', completed_at: nowIso(), wait_reason: '' });
    emitPilotUpdate(pilotId);
    advancePilot(pilotId);
    return null;
  }
  if (c.status !== 'locked') {
    const reason = 'Waiting for the amended acceptance tests to be approved before checking this stage\'s work.';
    if (stage.waitReason !== reason) { updateStage(stageId, { wait_reason: reason }); emitPilotUpdate(pilotId); }
    return null;
  }
  verifying.add(stageId);
  const job = checkStage(pilotId, c, stage).finally(() => {
    verifying.delete(stageId);
    activity.delete(c.id);
    baselines.delete(`verify:${stageId}`);
    emitPilotUpdate(pilotId);
  });
  baselines.set(`verify:${stageId}`, job);
  return job;
}

async function checkStage(pilotId: string, c: AcceptanceContract, stage: PilotStage): Promise<void> {
  const label = `Stage ${stage.position + 1} (${stage.title})`;
  const base = { id: randomUUID(), stageId: stage.id, stagePosition: stage.position + 1, stageTitle: stage.title, version: c.version };
  const record = (v: Verification, patch: Partial<AcceptanceContract> = {}) => {
    const now = getContract(pilotId) ?? c;
    updateContract(c.id, { ...patch, verifications: [...now.verifications, v].slice(-MAX_VERIFICATIONS) });
  };
  updateStage(stage.id, { wait_reason: '' });
  activity.set(c.id, { kind: 'verify', done: 0, total: c.tests.length, stageId: stage.id });
  emitPilotUpdate(pilotId);
  try {
    const a = repoAccessFor(c.repoPath);
    const files = lockedFiles(c.tests);
    const reads = await a.readFiles(files.map((f) => f.path));
    const tampered = findTampering(c.tests, reads);
    if (tampered.length) {
      if (getStage(stage.id)?.status !== 'verifying') return;
      const v: Verification = { ...base, at: nowIso(), status: 'tampered', passing: 0, total: c.tests.length, filesChecked: files.length, results: [], tampered, error: '' };
      record(v, { tamper: { stageId: stage.id, verificationId: v.id, files: tampered } });
      updateStage(stage.id, { verify_state: 'tampered' });
      const list = tampered.map((f) => `${f.path} (${f.criterionId}${f.actual ? '' : ', deleted'})`).join(', ');
      stopPilot(pilotId, `${label} changed locked acceptance tests: ${list}. Restore the approved version, or accept the change with a reason.`, false);
      announcePilot(pilotId, 'tests-tampered', 'locked acceptance tests were changed',
        `${label} modified ${list}. The pipeline is stopped until you restore the approved version or accept the change.`, 'action');
      return;
    }
    const results: CheckResult[] = [];
    for (const t of c.tests) {
      results.push(await runCheck(a, t));
      activity.set(c.id, { kind: 'verify', done: results.length, total: c.tests.length, stageId: stage.id });
      emitPilotUpdate(pilotId);
    }
    const passing = results.filter((r) => r.passed).length;
    const v: Verification = { ...base, at: nowIso(), status: verificationStatus(results), passing, total: results.length, filesChecked: files.length, results, tampered: [], error: '' };
    record(v);
    const failing = results.filter((r) => !r.passed).map((r) => r.criterionId);
    const fresh = getStage(stage.id);
    // Cancelled (or skipped) while the check ran: the evidence is kept, the stage is left as it is.
    if (fresh?.status !== 'verifying') { emitPilotUpdate(pilotId); return; }
    updateStage(stage.id, {
      status: 'completed', verify_state: 'done', completed_at: nowIso(), wait_reason: '',
      result_summary: `${fresh?.resultSummary ?? ''}\n\nAcceptance check (NeonCore ran the locked tests): ${passing}/${results.length} criteria passing${failing.length ? ` — not yet: ${failing.join(', ')}` : ''}. Locked test files unchanged.`.trim(),
    });
    console.log(`[acceptance] ${pilotId.slice(0, 8)} after stage ${stage.position + 1}: ${passing}/${results.length} passing`);
    emitPilotUpdate(pilotId);
    advancePilot(pilotId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record({ ...base, at: nowIso(), status: 'error', passing: 0, total: c.tests.length, filesChecked: 0, results: [], tampered: [], error: msg });
    updateStage(stage.id, { verify_state: 'error', wait_reason: msg });
    stopPilot(pilotId, `Could not check ${label} against the acceptance tests: ${msg} Fix that, then resume — the check runs again.`);
  }
}

/** "Restore the approved version": write the locked contents back, then check the stage again. */
export async function restoreTests(pilotId: string): Promise<AcceptanceContract> {
  pilotOrThrow(pilotId);
  const c = contractOrThrow(pilotId);
  if (!c.tamper) throw new PilotError('no locked test was changed — there is nothing to restore');
  const a = access(c);
  const approved = new Map(lockedFiles(c.tests).map((f) => [f.path, f]));
  activity.set(c.id, { kind: 'restore', done: 0, total: c.tamper.files.length, stageId: c.tamper.stageId });
  emitPilotUpdate(pilotId);
  try {
    for (const f of c.tamper.files) await a.writeFile(f.path, approved.get(f.path)?.content ?? '');
  } catch (err) {
    throw new PilotError(`could not restore the files: ${err instanceof Error ? err.message : String(err)}`, 503);
  } finally {
    activity.delete(c.id);
  }
  const stageId = c.tamper.stageId;
  updateContract(c.id, {
    tamper: null,
    amendments: [...c.amendments, { at: nowIso(), kind: 'restore', criterionIds: [...new Set(c.tamper.files.map((f) => f.criterionId))], reason: 'Restored the approved version.', paths: c.tamper.files.map((f) => f.path), version: c.version }],
  });
  recheck(pilotId, stageId);
  return getContract(pilotId)!;
}

/**
 * "Accept the change": the changed files become the locked version (v+1), with the person's reason
 * on record. A DELETED test cannot be accepted this way — unlock its criterion to have it rewritten.
 */
export async function acceptTestChange(pilotId: string, reasonRaw: unknown): Promise<AcceptanceContract> {
  pilotOrThrow(pilotId);
  const c = contractOrThrow(pilotId);
  if (!c.tamper) throw new PilotError('no locked test was changed — there is nothing to accept');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 5) throw new PilotError('give the reason for accepting the change — it is recorded in the report', 400);
  const deleted = c.tamper.files.filter((f) => !f.actual);
  if (deleted.length) throw new PilotError(`${deleted.map((f) => f.path).join(', ')} ${deleted.length === 1 ? 'was' : 'were'} deleted — restore the approved version, or unlock the criterion to have its test rewritten`, 400);
  const a = access(c);
  const reads = await a.readFiles(c.tamper.files.map((f) => f.path));
  const byPath = new Map(reads.map((r) => [r.path, r]));
  if (reads.some((r) => !r.exists || r.error)) throw new PilotError('a changed file can no longer be read — check the repo and try again', 409);
  const tests = c.tests.map((t) => ({ ...t, files: t.files.map((f) => { const r = byPath.get(f.path); return r ? { path: f.path, sha256: r.sha256, bytes: r.bytes, content: r.content } : f; }) }));
  const stageId = c.tamper.stageId;
  const version = c.version + 1;
  updateContract(c.id, {
    tests, version, tamper: null, lockedAt: nowIso(),
    amendments: [...c.amendments, { at: nowIso(), kind: 'accept-change', criterionIds: [...new Set(c.tamper.files.map((f) => f.criterionId))], reason: reason.slice(0, 2000), paths: c.tamper.files.map((f) => f.path), version }],
  });
  recheck(pilotId, stageId);
  return getContract(pilotId)!;
}

function recheck(pilotId: string, stageId: string): void {
  updateStage(stageId, { status: 'verifying', verify_state: 'pending', wait_reason: '' });
  const pilot = getPilot(pilotId);
  if (pilot?.phase === 'paused') setPhase(pilotId, 'running');
  emitPilotUpdate(pilotId);
  advancePilot(pilotId);
}

/** Check a stage again after its check could not run (an offline runner, a missing repo). */
export function verifyAgain(pilotId: string, stageId: string): void {
  const stage = getStage(stageId);
  if (!stage || stage.status !== 'verifying') throw new PilotError('this stage is not waiting for its acceptance check');
  if (stage.verifyState === 'tampered') throw new PilotError('a locked test was changed — restore it or accept the change first');
  recheck(pilotId, stageId);
}

// ── the independent checklist review ────────────────────────────────────────────

/**
 * Who judges the checklist: a live cartridge that can look at the work and did NOT do it.
 *
 * Where: the contract's repo first (the tests and the work live there), then the pipeline's other
 * repos. Who: a different engine from every one that ran a stage first, then a cartridge that ran no
 * stage. When only a cartridge that worked on the goal is available it is used, and the report says
 * the review was not independent — a review by the author is weaker evidence, not no evidence.
 */
export function pickReviewer(pilot: GoalPilot): { agentId: string; independent: boolean } | null {
  const c = getContract(pilot.id);
  const home = normalizeRepoPath(c?.repoPath || pilot.staffing?.repos[0]?.repoPath || '');
  const repos = new Set((pilot.staffing?.repos ?? []).map((r) => normalizeRepoPath(r.repoPath)));
  if (home) repos.add(home);
  const stages = stagesOf(pilot.id).filter((s) => s.kind === 'workflow' && s.agentId);
  const workerIds = new Set(stages.map((s) => s.agentId));
  const workerEngines = new Set(stages.map((s) => s.agentType));
  const live = (db.prepare(`SELECT id, repo_path, agent_type, status FROM agents WHERE status != 'offline' AND dismissed_at IS NULL ORDER BY last_seen DESC`).all() as
    { id: string; repo_path: string; agent_type: string; status: string }[]).filter((a) => repos.has(normalizeRepoPath(a.repo_path)));
  const atHome = live.filter((a) => normalizeRepoPath(a.repo_path) === home);
  const elsewhere = live.filter((a) => normalizeRepoPath(a.repo_path) !== home);
  const independent = (pool: typeof live) => pool.find((a) => !workerEngines.has(a.agent_type)) ?? pool.find((a) => !workerIds.has(a.id));
  const pick = independent(atHome) ?? independent(elsewhere);
  if (pick) return { agentId: pick.id, independent: true };
  const fallback = atHome[0] ?? live[0];
  return fallback ? { agentId: fallback.id, independent: false } : null;
}

/** Drive the review stage. Returns true when it is finished and the pipeline may move past it. */
export function advanceReviewStage(pilot: GoalPilot, stage: PilotStage): boolean {
  const c = getContract(pilot.id);
  if (!c || checklistCriteria(c).length === 0) {
    updateStage(stage.id, { status: 'completed', completed_at: nowIso(), result_summary: 'No checklist criteria to review.' });
    return true;
  }
  if (stage.status === 'review') return false;
  if (stage.status === 'running') {
    const req = stage.requestId ? getRequest(stage.requestId) : null;
    if (req?.status === 'pending' && !requestWentSilent(req.id)) return false;
    if (req?.status === 'ready') return false;   // the submission moves it to review
    const why = req?.status === 'pending' ? 'the reviewer finished without submitting verdicts' : req?.error || 'the request was lost';
    if (req?.status === 'pending') db.prepare(`UPDATE goal_pilot_requests SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`).run(why, nowIso(), req.id);
    updateStage(stage.id, { status: 'failed', completed_at: nowIso(), result_summary: `The checklist review did not happen: ${why}` });
    stopPilot(pilot.id, `Stage ${stage.position + 1} (${stage.title}) failed: ${why}. Retry it, or skip it (the checklist criteria then stay unchecked).`);
    return false;
  }
  // pending / waiting
  const reviewer = pickReviewer(pilot);
  if (!reviewer) {
    const reason = 'No cartridge is running in this pipeline\'s repos to review the checklist. Launch one — ideally a different engine from the one that did the work.';
    if (stage.waitReason !== reason) {
      updateStage(stage.id, { status: 'waiting', wait_reason: reason });
      announcePilot(pilot.id, 'review-needs-cartridge', 'the checklist review needs a cartridge', reason, 'action');
      emitPilotUpdate(pilot.id);
    }
    return false;
  }
  if (isCartridgeBusy(reviewer.agentId)) {
    const reason = 'The reviewing cartridge is busy — the review starts when it is free.';
    if (stage.waitReason !== reason) { updateStage(stage.id, { status: 'waiting', wait_reason: reason }); emitPilotUpdate(pilot.id); }
    return false;
  }
  const out = dispatchPlannerRequest(pilot.id, 'review', reviewer.agentId);
  updateStage(stage.id, {
    status: 'running', wait_reason: reviewer.independent ? '' : 'Only a cartridge that worked on this goal is available — the review is not independent.',
    agent_id: reviewer.agentId, request_id: out.request.id, started_at: nowIso(), completed_at: null, attempts: stage.attempts + 1,
  });
  updateContract(c.id, { checklist: { requestId: out.request.id, reviewerAgentId: reviewer.agentId, reviewerName: '', at: nowIso(), verdicts: [], confirmations: {}, confirmedAt: null, independent: reviewer.independent } });
  emitPilotUpdate(pilot.id);
  return false;
}

function submitReview(pilot: GoalPilot, c: AcceptanceContract, requestId: string, raw: unknown): AcceptanceSubmitOutcome {
  const stage = stagesOf(pilot.id).find((s) => s.kind === 'review' && s.requestId === requestId);
  if (!stage || stage.status !== 'running') throw new PilotError('the review is no longer waiting for these verdicts');
  const items = checklistCriteria(c);
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const list = Array.isArray(r.verdicts) ? r.verdicts : [];
  const errors: string[] = [];
  const verdicts: ChecklistVerdict[] = [];
  for (const cr of items) {
    const v = list.find((x) => x && typeof x === 'object' && String((x as Record<string, unknown>).criterionId ?? '').toUpperCase() === cr.id) as Record<string, unknown> | undefined;
    if (!v) { errors.push(`no verdict for ${cr.id}`); continue; }
    const verdict = String(v.verdict ?? '').toLowerCase();
    if (verdict !== 'met' && verdict !== 'not-met') { errors.push(`${cr.id}: verdict must be "met" or "not-met"`); continue; }
    const evidence = String(v.evidence ?? '').trim();
    if (evidence.length < 10) { errors.push(`${cr.id}: give the evidence — what you checked and what you found`); continue; }
    verdicts.push({ criterionId: cr.id, verdict, evidence: evidence.slice(0, 3000) });
  }
  if (errors.length) throw new PilotError(`submission rejected: ${errors.join('; ')}`, 422);
  const reviewer = db.prepare('SELECT name, repo_name, agent_type FROM agents WHERE id = ?').get(stage.agentId) as { name?: string; repo_name?: string; agent_type?: string } | undefined;
  const tx = db.transaction(() => {
    db.prepare('UPDATE goal_pilot_requests SET status = ?, result = ?, notes = ?, error = ?, completed_at = ? WHERE id = ?')
      .run('ready', JSON.stringify({ verdicts }), '[]', '', nowIso(), requestId);
    updateContract(c.id, {
      checklist: {
        independent: c.checklist?.independent ?? true,
        requestId, reviewerAgentId: stage.agentId,
        reviewerName: reviewer ? `${ENGINE_LABEL[reviewer.agent_type ?? ''] ?? reviewer.agent_type} · ${reviewer.repo_name || reviewer.name}` : stage.agentId.slice(0, 8),
        at: nowIso(), verdicts, confirmations: {}, confirmedAt: null,
      },
    });
    updateStage(stage.id, { status: 'review', wait_reason: '' });
  });
  tx();
  disarmOnReport(db, stage.agentId);
  emitPilotUpdate(pilot.id);
  const met = verdicts.filter((v) => v.verdict === 'met').length;
  announcePilot(pilot.id, 'checklist-ready', 'checklist verdicts to confirm',
    `The independent reviewer found ${met} of ${verdicts.length} checklist criteria met. Confirm or overrule each verdict to finish the goal.`, 'action');
  return { pilotId: pilot.id, notes: [], request: getRequest(requestId) };
}

/**
 * The person's word on each checklist verdict. Overruling the reviewer needs a note — it is the
 * evidence the report shows in place of the reviewer's.
 */
export function confirmChecklist(pilotId: string, raw: unknown): AcceptanceContract {
  const pilot = pilotOrThrow(pilotId);
  const c = contractOrThrow(pilotId);
  const stage = stagesOf(pilot.id).find((s) => s.kind === 'review');
  if (!stage || stage.status !== 'review' || !c.checklist) throw new PilotError('there are no checklist verdicts waiting for you');
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const confirmations: NonNullable<AcceptanceContract['checklist']>['confirmations'] = {};
  const errors: string[] = [];
  for (const cr of checklistCriteria(c)) {
    const d = src[cr.id] as Record<string, unknown> | undefined;
    if (!d || typeof d.accepted !== 'boolean') { errors.push(`decide ${cr.id}`); continue; }
    const verdict = c.checklist.verdicts.find((v) => v.criterionId === cr.id);
    const note = String(d.note ?? '').trim();
    const overrules = verdict && (verdict.verdict === 'met') !== d.accepted;
    if (overrules && note.length < 5) { errors.push(`${cr.id}: you are overruling the reviewer — say why`); continue; }
    confirmations[cr.id] = { accepted: d.accepted, note: note.slice(0, 2000), at: nowIso() };
  }
  if (errors.length) throw new PilotError(errors.join('; '), 400);
  updateContract(c.id, { checklist: { ...c.checklist, confirmations, confirmedAt: nowIso() } });
  const met = Object.values(confirmations).filter((x) => x.accepted).length;
  updateStage(stage.id, {
    status: 'completed', completed_at: nowIso(), wait_reason: '',
    result_summary: `${met}/${Object.keys(confirmations).length} checklist criteria met (reviewed by ${c.checklist.reviewerName || 'an independent cartridge'}, confirmed by you).`,
  });
  if (pilot.phase === 'paused') setPhase(pilot.id, 'running');
  emitPilotUpdate(pilotId);
  advancePilot(pilotId);
  return getContract(pilotId)!;
}

// ── the view ──────────────────────────────────────────────────────────────────

const VIEW_FILE_MAX = 24_000;

export type ContractView = Omit<AcceptanceContract, 'draftTests' | 'tests'> & {
  draftTests: CriterionTest[];
  tests: CriterionTest[];
  states: ReturnType<typeof criterionStates>;
  passing: number;
  total: number;
  activity: ContractActivity | null;
  baselineFresh: boolean;
  request: { status: string; error: string; agentId: string } | null;
};

/** The contract as the dashboard reads it: file contents capped, every criterion's evidence resolved. */
export function contractView(c: AcceptanceContract | null): ContractView | null {
  if (!c) return null;
  const cap = (tests: CriterionTest[]) => tests.map((t) => ({
    ...t, files: t.files.map((f) => (f.content.length > VIEW_FILE_MAX ? { ...f, content: `${f.content.slice(0, VIEW_FILE_MAX)}\n… (truncated — ${f.bytes} bytes)` } : f)),
  }));
  const states = criterionStates(c);
  const req = c.requestId ? getRequest(c.requestId) : null;
  return {
    ...c,
    draftTests: cap(c.draftTests),
    tests: cap(c.tests),
    states,
    passing: states.filter((s) => s.outcome === 'pass' || s.outcome === 'met').length,
    total: states.length,
    activity: contractActivity(c.id),
    baselineFresh: c.status === 'review' ? baselineIsFresh(c) : false,
    request: req ? { status: req.status, error: req.error, agentId: req.agentId } : null,
  };
}
