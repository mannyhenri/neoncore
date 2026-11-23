/**
 * THE QA RUN — docs/plans/qa-section.md, "Run flow".
 *
 *   run       each test in turn: cached → replay with the runner (no AI). Passed → passed. A step
 *             failed → a REPAIR request to the cartridge; its answer is validated (validateRepair),
 *             replayed, and a passing replay is `passed_with_repair` with a repair to review.
 *             `impossible`, or a replay that still fails → failed. Uncached → an AUTHOR request,
 *             then a replay. ai_calls counts every request answered: 0 when all replay from cache.
 *   explore   one EXPLORE request; its findings are deduplicated (findings.ts) and each new one
 *             gets a reproduction test.
 *   generate  the recorder's top journeys become tests (recorder.ts) — no AI.
 *
 * One test at a time, in order: the cartridge is one terminal, and a run's results read in order.
 */
import path from 'path';
import db from '../../db.js';
import { createTest, getResult, getRun, getTarget, getTest, insertRepair, insertRun, listTests, resultsOf, setTestCache, updateResult, updateRun, type QaResult, type QaRun, type QaTarget } from './store.js';
import { parseCache, parseSentenceActions, validateRepair } from './actions.js';
import { recordFinding } from './findings.js';
import { completeRequest, dispatchRequest, failRequest, getRequest, onQaRequestFailed, requestsOf, sweepQaRequests, type QaRequest } from './dispatch.js';
import { authorPrompt, explorePrompt, repairPrompt } from './prompts.js';
import { qaRunner, runDir } from './runner.js';
import { generateFromJourneys } from './recorder.js';
import { QaError, RUN_KINDS, type QaAction, type RunKind, type RunnerResult, type RunnerSpec } from './types.js';

const nowIso = () => new Date().toISOString();
/** Repairs one test may take in one run before it is called failed. */
export const MAX_REPAIRS_PER_TEST = 3;

function specFor(t: QaTarget, sentences: string[], cache: QaAction[][]): RunnerSpec {
  const env = Object.values(t.credentialsEnv).flatMap((c) => [c.user, c.pass]);
  return { baseUrl: t.baseUrl, allowHosts: t.allowHosts, denyActions: t.denyActions, env, sentences, cache, budget: { minutes: t.budgets.minutes } };
}

/** Start a run. Returns at once; the run moves on its own (and on submissions). */
export function startRun(body: { targetId?: unknown; kind?: unknown; testIds?: unknown; goal?: unknown; limit?: unknown }): QaRun {
  const target = getTarget(String(body.targetId ?? ''));
  if (!target) throw new QaError('target not found', 404);
  const kind = String(body.kind ?? 'run') as RunKind;
  if (!(RUN_KINDS as readonly string[]).includes(kind)) throw new QaError(`kind must be one of ${RUN_KINDS.join(', ')}`);
  let testIds: string[] = [];
  if (kind === 'run') {
    const all = listTests(target.id);
    testIds = Array.isArray(body.testIds) && body.testIds.length ? body.testIds.map(String) : all.map((t) => t.id);
    for (const id of testIds) if (!all.some((t) => t.id === id)) throw new QaError(`test ${id} is not a test of this target`);
    if (testIds.length === 0) throw new QaError('this target has no tests to run');
  }
  const run = insertRun(target.id, kind, testIds, String(body.goal ?? ''), target.agentId);
  if (kind === 'explore') {
    updateRun(run.id, { status: 'waiting' });
    dispatchRequest({ runId: run.id, kind: 'explore', agentId: target.agentId, prompt: (id) => explorePrompt(id, target, run.goal) });
  } else if (kind === 'generate') {
    const out = generateFromJourneys(target.id, Number(body.limit) || 5);
    updateRun(run.id, { status: 'completed', finishedAt: nowIso(), summary: `${out.created.length} test(s) generated from ${out.journeys} journey(s)` });
  } else {
    void advanceRun(run.id);
  }
  return getRun(run.id)!;
}

const driving = new Map<string, Promise<void>>();
/**
 * Move a run as far as it can go without waiting on a cartridge. Serialised per run: `first`
 * (a replay after a submission) runs in the same queue, so two replays of one run never overlap.
 */
export function advanceRun(runId: string, first?: () => Promise<void>): Promise<void> {
  const prev = driving.get(runId) ?? Promise.resolve();
  const next = prev.then(async () => { if (first) await first(); await step(runId); }).catch((err) => {
    console.error(`[qa] run ${runId.slice(0, 8)} failed to advance:`, err);
    updateRun(runId, { status: 'error', error: String(err instanceof Error ? err.message : err), finishedAt: nowIso() });
  });
  driving.set(runId, next);
  void next.finally(() => { if (driving.get(runId) === next) driving.delete(runId); });
  return next;
}

/** Settles when every run being driven has stopped moving (tests). */
export async function qaSettled(): Promise<void> {
  while (driving.size > 0) await Promise.all([...driving.values()]);
}

async function step(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run || run.kind !== 'run' || run.finishedAt) return;
  const target = getTarget(run.targetId);
  if (!target) { updateRun(runId, { status: 'error', error: 'the target was deleted', finishedAt: nowIso() }); return; }
  for (;;) {
    const results = resultsOf(runId);
    if (results.some((r) => r.status === 'authoring' || r.status === 'repairing')) { updateRun(runId, { status: 'waiting' }); return; }
    const next = results.find((r) => r.status === 'pending');
    if (!next) { finish(runId); return; }
    updateRun(runId, { status: 'running' });
    const test = getTest(next.testId);
    if (!test) { updateResult(next.id, { status: 'failed', error: 'the test was deleted' }); continue; }
    if (!test.cache) {
      updateResult(next.id, { status: 'authoring' });
      dispatchRequest({ runId, resultId: next.id, kind: 'author', agentId: target.agentId, context: { testId: test.id }, prompt: (id) => authorPrompt(id, target, test) });
      continue;
    }
    await replayAndJudge(run, target, next, test.sentences, test.cache);
  }
}

async function replay(run: QaRun, target: QaTarget, result: QaResult, sentences: string[], cache: QaAction[][]): Promise<RunnerResult> {
  const out = path.join(runDir(run.id), `${result.position + 1}-${result.testId.slice(0, 8)}-${result.repairs}`);
  return qaRunner()(specFor(target, sentences, cache), out);
}

function failedIndex(r: RunnerResult): number {
  const s = r.steps.find((x) => x.status === 'failed');
  return s ? s.index : -1;
}

/** Replay a test's cache and decide: passed, needs a repair, or failed. */
async function replayAndJudge(run: QaRun, target: QaTarget, result: QaResult, sentences: string[], cache: QaAction[][]): Promise<void> {
  const r = await replay(run, target, result, sentences, cache);
  const fresh = getResult(result.id)!;
  if (r.status === 'passed') {
    updateResult(result.id, { status: fresh.repairs > 0 ? 'passed_with_repair' : 'passed', evidence: r as unknown as Record<string, unknown>, error: '', failedStep: null });
    return;
  }
  const idx = failedIndex(r);
  const error = r.steps.find((s) => s.status === 'failed')?.error ?? r.error ?? 'the replay failed';
  if (r.status === 'blocked' || idx < 0) {
    updateResult(result.id, { status: 'failed', evidence: r as unknown as Record<string, unknown>, error, failedStep: idx >= 0 ? idx : null });
    return;
  }
  if (fresh.repairs >= MAX_REPAIRS_PER_TEST) {
    updateResult(result.id, { status: 'failed', evidence: r as unknown as Record<string, unknown>, error: `${error} (after ${fresh.repairs} repairs)`, failedStep: idx });
    return;
  }
  const test = getTest(result.testId)!;
  updateResult(result.id, { status: 'repairing', evidence: r as unknown as Record<string, unknown>, error, failedStep: idx });
  dispatchRequest({
    runId: run.id, resultId: result.id, kind: 'repair', agentId: target.agentId,
    context: { testId: test.id, sentenceIndex: idx, before: cache[idx], cache, error },
    prompt: (id) => repairPrompt(id, target, test, idx, cache[idx], error),
  });
}

function finish(runId: string): void {
  const results = resultsOf(runId);
  const failed = results.filter((r) => r.status === 'failed').length;
  const repaired = results.filter((r) => r.status === 'passed_with_repair').length;
  const passed = results.length - failed;
  const status = failed > 0 ? 'failed' : repaired > 0 ? 'passed_with_repair' : 'passed';
  updateRun(runId, { status, finishedAt: nowIso(), summary: `${passed}/${results.length} passed${repaired ? `, ${repaired} with repair` : ''}${failed ? `, ${failed} failed` : ''}` });
}

// ── submissions ─────────────────────────────────────────────────────────────────────────

export interface SubmitOutcome { ok: true; request: QaRequest; message: string }

/**
 * A cartridge's answer. Invalid → QaError, and the request stays pending so it can submit again.
 * Valid → stored, and the run moves on (asynchronously: the reply does not wait for the replay).
 */
export function submitQaResult(requestId: string, raw: unknown): SubmitOutcome {
  const req = getRequest(requestId);
  if (!req) throw new QaError('request not found', 404);
  if (req.status !== 'pending') throw new QaError(`this request is already ${req.status}`, 409);
  const run = getRun(req.runId);
  const target = run ? getTarget(run.targetId) : null;
  if (!run || !target) throw new QaError('the run for this request is gone', 410);
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  if (req.kind === 'explore') {
    if (!Array.isArray(body.findings)) throw new QaError('an explore result needs findings: [] (empty when nothing was found)');
    let created = 0; let repeats = 0;
    for (const f of body.findings as Record<string, unknown>[]) {
      const out = recordFinding(target.id, run.id, f);
      if (out.created) created++; else repeats++;
    }
    completeRequest(req.id, body);
    const pages = Array.isArray((body.coverage as { pages?: unknown } | undefined)?.pages) ? ((body.coverage as { pages: unknown[] }).pages.length) : 0;
    updateRun(run.id, { status: 'completed', finishedAt: nowIso(), addAiCall: true, summary: `${created} new finding(s), ${repeats} repeat(s)${pages ? `, ${pages} page(s) covered` : ''}` });
    return { ok: true, request: getRequest(req.id)!, message: `${created} new finding(s) recorded, ${repeats} already known.` };
  }

  const result = resultsOf(run.id).find((r) => r.id === req.resultId);
  const test = result ? getTest(result.testId) : null;
  if (!result || !test) throw new QaError('the test for this request is gone', 410);

  if (req.kind === 'author') {
    const cache = parseCache(body.cache, test.sentences);
    setTestCache(test.id, cache);
    completeRequest(req.id, body);
    updateRun(run.id, { addAiCall: true });
    void advanceRun(run.id, () => replayAndJudgeAuthored(run.id, result.id));
    return { ok: true, request: getRequest(req.id)!, message: 'Actions stored; NeonCore is replaying the test now.' };
  }

  // repair
  if (typeof body.impossible === 'string' && body.impossible.trim()) {
    completeRequest(req.id, body);
    updateRun(run.id, { addAiCall: true });
    updateResult(result.id, { status: 'failed', error: `cannot be done any more: ${body.impossible.trim()}` });
    void advanceRun(run.id);
    return { ok: true, request: getRequest(req.id)!, message: 'Recorded: the test fails, as it should when its intent cannot be met.' };
  }
  const idx = Number(req.context.sentenceIndex);
  if (body.sentenceIndex !== undefined && Number(body.sentenceIndex) !== idx) throw new QaError(`this request is for sentence ${idx}, not ${body.sentenceIndex}`);
  const before = (req.context.before ?? []) as QaAction[];
  const after = parseSentenceActions(body.actions, test.sentences[idx], `sentence ${idx + 1}`);
  const verdict = validateRepair(test.sentences[idx], before, after);
  if (!verdict.ok) throw new QaError(`repair rejected: ${verdict.reason}`);
  const prevCache = (req.context.cache ?? test.cache ?? []) as QaAction[][];
  const cache = prevCache.map((list, i) => (i === idx ? after : list));
  completeRequest(req.id, body);
  updateRun(run.id, { addAiCall: true });
  updateResult(result.id, { addRepair: true });
  setTestCache(test.id, cache);
  insertRepair(run.id, test.id, idx, test.sentences[idx], before, after, prevCache);
  void advanceRun(run.id, async () => {
    const r = getRun(run.id)!; const t = getTarget(r.targetId)!;
    await replayAndJudge(r, t, getResult(result.id)!, test.sentences, cache);
  });
  return { ok: true, request: getRequest(req.id)!, message: 'Repair accepted for review; NeonCore is replaying the test now.' };
}

/** After authoring: a replay that fails is a failed test, not another AI round. */
async function replayAndJudgeAuthored(runId: string, resultId: string): Promise<void> {
  const run = getRun(runId)!; const target = getTarget(run.targetId)!;
  const result = getResult(resultId)!; const test = getTest(result.testId)!;
  const r = await replay(run, target, result, test.sentences, test.cache ?? []);
  if (r.status === 'passed') updateResult(resultId, { status: 'passed', evidence: r as unknown as Record<string, unknown>, error: '', failedStep: null });
  else updateResult(resultId, { status: 'failed', evidence: r as unknown as Record<string, unknown>, failedStep: failedIndex(r) >= 0 ? failedIndex(r) : null, error: `the written actions did not pass: ${r.steps.find((s) => s.status === 'failed')?.error ?? r.error ?? ''}` });
}

// A request that failed without an answer: the test it was for fails; an explore run errors.
onQaRequestFailed((req) => {
  const run = getRun(req.runId);
  if (!run) return;
  if (req.kind === 'explore') { updateRun(run.id, { status: 'error', error: req.error, finishedAt: nowIso() }); return; }
  if (req.resultId) updateResult(req.resultId, { status: 'failed', error: `${req.kind === 'author' ? 'writing the actions' : 'the repair'} failed: ${req.error}` });
  void advanceRun(run.id);
});

/** A test written from an explorer finding or a journey, ready to run (helper for routes). */
export { createTest };

// ── the sweep ───────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
export function startQaEngine(intervalMs = 15_000): void {
  if (timer) return;
  const budgetOf = (req: QaRequest) => { const run = getRun(req.runId); const t = run ? getTarget(run.targetId) : null; return t?.budgets.minutes ?? 60; };
  timer = setInterval(() => {
    try { sweepQaRequests(Date.now(), budgetOf); } catch (err) { console.error('[qa] sweep failed:', err); }
  }, intervalMs);
  timer.unref?.();
  resumeRuns();
}

/**
 * After a restart: a test whose request was answered but whose replay was lost mid-way would wait
 * forever — put it back in line (its cache is what the cartridge wrote), and move every unfinished run on.
 */
export function resumeRuns(): void {
  const open = db.prepare(`SELECT id FROM qa_runs WHERE kind = 'run' AND finished_at IS NULL`).all() as { id: string }[];
  for (const { id } of open) {
    for (const r of resultsOf(id)) {
      if (r.status !== 'authoring' && r.status !== 'repairing') continue;
      const live = requestsOf(id).some((q) => q.resultId === r.id && q.status === 'pending');
      if (!live) updateResult(r.id, { status: 'pending' });
    }
    void advanceRun(id);
  }
}

export { failRequest, requestsOf };
