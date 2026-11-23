/**
 * runSpec — play a test's cached actions, sentence by sentence, with no AI. Stops at the first
 * failed sentence; the rest are `skipped`. A guardrail refusal or an exhausted budget makes the run
 * `blocked` rather than `failed`: the test did not fail, it was not allowed to go on.
 */
import { join } from 'node:path';
import { GuardError, invalidAction, perform } from './actions.mjs';
import { maskDeep } from './guard.mjs';
import { contextFor, openSession, specProblem } from './session.mjs';
import { scrubZip } from './zip.mjs';
import { snapshotPage } from './snapshot.mjs';

class BudgetError extends Error {}

function withBudget(promise, minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return promise;
  let timer;
  const cap = new Promise((_, reject) => { timer = setTimeout(() => reject(new BudgetError(`budget of ${minutes} minute(s) used up`)), minutes * 60_000); });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

/** Validate a run spec. Returns an error string or null. */
export function runSpecProblem(spec) {
  const p = specProblem(spec);
  if (p) return p;
  if (!Array.isArray(spec.sentences) || spec.sentences.length === 0) return 'spec.sentences must list at least one sentence';
  if (!Array.isArray(spec.cache)) return 'spec.cache must be QaAction[][] (one list per sentence)';
  for (const [i, list] of spec.cache.entries()) {
    if (!Array.isArray(list)) return `spec.cache[${i}] must be a list of actions`;
    for (const [j, a] of list.entries()) { const bad = invalidAction(a); if (bad) return `spec.cache[${i}][${j}]: ${bad}`; }
  }
  return null;
}

export async function runSpec(spec, outDir, { state } = {}) {
  const started = Date.now();
  const problem = runSpecProblem(spec);
  if (problem) {
    return { status: 'blocked', error: problem, steps: [], console: [], network: [], trace: '', durationMs: 0 };
  }
  const ctx = contextFor(spec);
  const session = await openSession(spec, outDir, { state });
  const steps = spec.sentences.map((sentence, index) => ({ index, sentence, status: 'skipped' }));
  let status = 'passed';
  let error;
  const tracePath = join(outDir, 'trace.zip');
  // Set when the budget stops the run: the play loop may still be unwinding (the browser closes
  // under it) and must not overwrite `blocked` with the failure that closing causes.
  let stopped = false;

  const play = async () => {
    await session.page.goto(new URL('/', spec.baseUrl).toString(), { waitUntil: 'load', timeout: 10_000 }).catch(() => {});
    for (const step of steps) {
      const actions = spec.cache[step.index];
      if (!actions || actions.length === 0) {
        Object.assign(step, { status: 'failed', error: 'no cached actions for this sentence' });
        status = 'failed';
        return;
      }
      for (const [j, action] of actions.entries()) {
        try {
          await perform(session.page, action, ctx);
        } catch (err) {
          if (stopped) return;
          const blocked = err instanceof GuardError;
          Object.assign(step, { status: 'failed', error: err.message, failedAction: { index: j, action } });
          step.screenshot = await session.screenshot(`step-${step.index + 1}-failed.png`);
          status = blocked ? 'blocked' : 'failed';
          return;
        }
      }
      if (stopped) return;
      step.status = 'passed';
    }
  };

  try {
    await withBudget(play(), spec.budget?.minutes);
  } catch (err) {
    stopped = true;
    status = 'blocked';
    error = err instanceof BudgetError ? err.message : `runner error: ${err.message}`;
    const current = steps.find((s) => s.status === 'skipped');
    if (current) Object.assign(current, { status: 'failed', error });
  }

  await session.close({ tracePath, statePath: state });
  try { scrubZip(tracePath, ctx.secrets); } catch { /* no trace written */ }
  const result = {
    status,
    ...(error ? { error } : {}),
    steps,
    console: session.consoleErrors,
    network: session.network,
    trace: tracePath,
    durationMs: Date.now() - started,
  };
  return maskDeep(result, ctx.secrets);
}

/**
 * act — run a flat action list, then snapshot the page it ends on. For a cartridge working out a
 * sentence step by step. Spec: a run spec with `actions: QaAction[]` (and optionally `start`, a path).
 */
export async function actSpec(spec, outDir, { state } = {}) {
  const started = Date.now();
  const problem = specProblem(spec) || (!Array.isArray(spec.actions) ? 'spec.actions must be a list of QaAction' : null)
    || spec.actions.map((a, i) => { const b = invalidAction(a); return b ? `spec.actions[${i}]: ${b}` : null; }).find(Boolean) || null;
  if (problem) return { status: 'blocked', error: problem, steps: [], snapshot: null, durationMs: 0 };
  const ctx = contextFor(spec);
  const session = await openSession(spec, outDir, { state, trace: false });
  const steps = spec.actions.map((action, index) => ({ index, action, status: 'skipped' }));
  let status = 'passed';
  let stopped = false;
  const play = async () => {
    await session.page.goto(new URL(spec.start || '/', spec.baseUrl).toString(), { waitUntil: 'load', timeout: 10_000 }).catch(() => {});
    for (const step of steps) {
      try { await perform(session.page, step.action, ctx); if (!stopped) step.status = 'passed'; } catch (err) {
        if (stopped) return;
        Object.assign(step, { status: 'failed', error: err.message });
        status = err instanceof GuardError ? 'blocked' : 'failed';
        return;
      }
    }
  };
  let error;
  try { await withBudget(play(), spec.budget?.minutes); } catch (err) { stopped = true; status = 'blocked'; error = err.message; }
  const snap = await snapshotPage(session, outDir);
  await session.close({ statePath: state });
  return maskDeep({ status, ...(error ? { error } : {}), steps, snapshot: snap, durationMs: Date.now() - started }, ctx.secrets);
}
