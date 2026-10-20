// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import {
  explainLoopCount, shouldExtendLoop, configForNextLoop, PER_DISPATCH_KEYS,
  MAX_LOOP_CEILING,
} from '../src/lib/workflow-loop.ts';

/**
 * A REAL epic is bigger than the ceiling, and its count is often unreadable.
 *
 * LIVE FAILURE (GRD-3502, 53 Jira tasks, run #7). Two independent caps turned a 53-task epic
 * into a 1-task run, and both were invisible from every surface:
 *
 *   1. `Load Epic` was force-completed by hand, so its result was the literal string
 *      "Force-completed manually". `TASKS:\s*(\d+)` matched nothing, the budget fell back to
 *      the static `loopCount: 1`, and the run dispatched ONE task before moving to
 *      `Verify Coverage`. The extension mechanism — built precisely to rescue a budget the
 *      work outlived — declined to fire, because `shouldExtendLoop` bails on `loopCount <= 1`.
 *      So the one case that most needs rescuing is the one case that cannot be rescued.
 *
 *   2. Even a clean `TASKS: 53` would have been clamped to MAX_LOOP_CEILING, silently
 *      dropping 13 tasks. The ceiling is a runaway guard, not a statement about how large an
 *      epic may legitimately be, and a 53-task epic is ordinary.
 *
 * SET-BASED over the seeded registry of data-driven loop steps rather than over the one
 * template that failed. `loopCountFrom` is a general mechanism and the two-repo template uses
 * it twice with its own patterns; a fix applied to `Epic: Task by Task` alone would leave
 * `Work Repo A` and `Work Repo B` capped exactly as before, and nothing would say so.
 */

/** The epic that exposed this. Any number comfortably above the old ceiling would do. */
const EPIC_SIZE = 53;

interface LoopStep {
  template: string;
  step: string;
  config: {
    loopCount?: number;
    loopCountFrom?: { step: string; pattern: string };
    loopUntil?: string;
  };
}

/** THE SET: every seeded step that reads its dispatch count out of an earlier step's output. */
function loopSteps(): LoopStep[] {
  const rows = db.prepare(`
    SELECT w.name AS template, s.name AS step, s.executor_config AS config
    FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
    WHERE w.template_id IS NULL
    ORDER BY w.name, s.position_y
  `).all() as { template: string; step: string; config: string }[];

  return rows
    .map((r) => ({ template: r.template, step: r.step, config: JSON.parse(r.config) }))
    .filter((r) => r.config?.loopCountFrom?.step && r.config?.loopCountFrom?.pattern);
}

/**
 * Build an upstream output this step will actually read, from the step's OWN pattern.
 *
 * Derived rather than hardcoded so a template that renames its count line (`TASKS:` →
 * `TASKS_A:`) is still covered without editing this file. If the shape ever drifts far enough
 * that the label cannot be recovered, the assertion below fails loudly rather than silently
 * testing a string nothing matches.
 */
function upstreamReporting(n: number, pattern: string): string {
  // An optional literal (`TASKS:?`) is written as present — the documented form of the line.
  const label = pattern.replace(/(\\?[^\\()])\?/g, '$1').replace(/\\s\*\(\\d\+\)\s*$/, '');
  return `EPIC: GRD-3502\nSTATE: docs/epic-state.md\n${label} ${n}\n`;
}

test('the registry is real — an empty scan would pass vacuously', () => {
  const set = loopSteps();
  assert.ok(set.length >= 3,
    `expected the seeded data-driven loop steps, got ${set.length}: ${JSON.stringify(set.map((s) => s.step))}`);
});

test('a 53-task epic gets 53 dispatches, in every template that counts from data', () => {
  const failures: string[] = [];

  for (const { template, step, config } of loopSteps()) {
    const { pattern, step: fromStep } = config.loopCountFrom!;
    const source = upstreamReporting(EPIC_SIZE, pattern);

    // Guard the derivation itself: a pattern this helper cannot satisfy proves nothing.
    if (!new RegExp(pattern).test(source)) {
      failures.push(`${template} / ${step}: built an upstream output that /${pattern}/ does not match`);
      continue;
    }

    const got = explainLoopCount(config, { [fromStep]: source });
    if (got.count !== EPIC_SIZE) {
      failures.push(
        `${template} / ${step}: ${EPIC_SIZE} tasks resolved to ${got.count} dispatches `
        + `(${got.basis}) — ${EPIC_SIZE - got.count} task(s) would never be dispatched`);
    }
  }

  assert.equal(failures.length, 0,
    `an epic larger than the ceiling is silently truncated:\n  ${failures.join('\n  ')}`);
});

test('a budget that fell back to 1 can still be rescued by a dispatch reporting work left', () => {
  const failures: string[] = [];

  for (const { template, step, config } of loopSteps()) {
    const fromStep = config.loopCountFrom!.step;

    // Exactly the live case: step 1 was force-completed, so its output carries no count.
    const resolved = explainLoopCount(config, { [fromStep]: 'Force-completed manually' });
    if (resolved.basis !== 'fallback' || resolved.count !== 1) {
      failures.push(`${template} / ${step}: expected an unreadable count to fall back to 1, got ${resolved.count} (${resolved.basis})`);
      continue;
    }

    // The budget is spent (dispatch 1 of 1) and the agent says 52 tasks are still outstanding.
    const extended = shouldExtendLoop({
      result: `DONE GLW-001 · commit abc1234 · ${EPIC_SIZE - 1} remaining`,
      config,
      currentLoop: 1,
      loopCount: resolved.count,
      extensions: 0,
    });

    if (!extended) {
      failures.push(
        `${template} / ${step}: budget fell back to 1 and the dispatch reported `
        + `${EPIC_SIZE - 1} remaining, but the loop refused to extend — the run ends at 1 task`);
    }
  }

  assert.equal(failures.length, 0,
    `a fallback budget is terminal, so an unreadable count silently caps the epic at one task:\n  ${failures.join('\n  ')}`);
});

test('the rescue reaches the whole epic, not just one extension past the fallback', () => {
  // Extending ONCE turns 1 task into 2, which is not a fix for 53. Drive the real loop: each
  // completed dispatch reports what is left, and the budget must keep pace until the work runs
  // out. A cap that bites at 11 would leave 42 tasks undispatched and still look like progress.
  const failures: string[] = [];

  for (const { template, step, config } of loopSteps()) {
    const fromStep = config.loopCountFrom!.step;
    let budget = explainLoopCount(config, { [fromStep]: 'Force-completed manually' }).count;
    let extensions = 0;
    let dispatched = 0;

    for (let loop = 1; loop <= budget; loop++) {
      dispatched++;
      const left = EPIC_SIZE - dispatched;
      const result = left > 0
        ? `DONE task-${dispatched} · commit abc1234 · ${left} remaining`
        : 'ALL TASKS COMPLETE · 53/53 done';

      if (shouldExtendLoop({ result, config, currentLoop: loop, loopCount: budget, extensions })) {
        budget++;
        extensions++;
      }
    }

    if (dispatched !== EPIC_SIZE) {
      failures.push(
        `${template} / ${step}: an unreadable count covered ${dispatched} of ${EPIC_SIZE} tasks `
        + `(${extensions} extension(s), final budget ${budget})`);
    }
  }

  assert.equal(failures.length, 0,
    `the extension budget runs out before the epic does:\n  ${failures.join('\n  ')}`);
});

test('the ceiling still bounds a runaway count', () => {
  // Raising the ceiling must not remove it: an absurd number is still clamped, and the basis
  // says so rather than reporting a number that looks deliberate.
  const set = loopSteps();
  const { config } = set[0];
  const { pattern, step: fromStep } = config.loopCountFrom!;

  const got = explainLoopCount(config, { [fromStep]: upstreamReporting(10_000_000, pattern) });
  assert.equal(got.count, MAX_LOOP_CEILING, 'an absurd count must clamp to the ceiling');
  assert.equal(got.basis, 'clamped', 'a clamped count must report itself as clamped');
});

/**
 * ── THE NUDGE BUDGET IS PER TASK, NOT PER EPIC ──────────────────────────────────────────
 *
 * The second cap that killed GRD-3502. `_nudges` is stored on the STEP, and a looped step is
 * ONE row re-dispatched N times. `full` autonomy allows six nudges (lib/autonomy.ts). A
 * cartridge that finishes a task and stops without reporting needs one nudge per task — so
 * six nudges spent across 63 dispatches means the run advances six times and then stalls
 * forever, step still `running`, workflow still `running`, nothing reported wrong.
 */
const PER_STEP_KEYS = ['_resolvedLoopCount', '_loopExtensions', 'loopCount', 'loopCountFrom', 'loopUntil', 'prompt', 'role'];

test('advancing a loop clears per-dispatch state and keeps per-step state', () => {
  const cfg: Record<string, unknown> = {
    role: 'backend',
    prompt: 'do one task',
    loopCount: 1,
    loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:\\s*(\\d+)' },
    loopUntil: 'ALL TASKS COMPLETE',
    _resolvedLoopCount: 63,
    _loopExtensions: 2,
    _currentLoop: 6,
    _nudges: 6,                                   // budget fully spent on the previous task
    _lastNudgeAt: '2026-09-06T16:34:27.928Z',
  };

  const next = configForNextLoop(cfg, 7);
  const failures: string[] = [];

  // THE SET: every key that is per-dispatch must be gone.
  for (const key of PER_DISPATCH_KEYS) {
    if (key in next) failures.push(`${key} survived into the next dispatch (= ${JSON.stringify(next[key])})`);
  }
  // ...and every key that belongs to the step must be untouched.
  for (const key of PER_STEP_KEYS) {
    if (JSON.stringify(next[key]) !== JSON.stringify(cfg[key])) {
      failures.push(`${key} was lost or altered: ${JSON.stringify(cfg[key])} -> ${JSON.stringify(next[key])}`);
    }
  }
  if (next._currentLoop !== 7) failures.push(`_currentLoop should advance to 7, got ${next._currentLoop}`);

  assert.equal(failures.length, 0, `loop advance leaks or drops state:\n  ${failures.join('\n  ')}`);
});

test('a 63-task run is never starved of nudges by an earlier task', () => {
  // The property, not one call: drive all 63 dispatches, spending the FULL nudge budget on
  // every one of them, and assert each dispatch still starts with a fresh budget.
  const policyMax = 6;                             // NUDGE_POLICY.full.maxAttempts
  let cfg: Record<string, unknown> = { _resolvedLoopCount: 63, _currentLoop: 1 };
  const starved: number[] = [];

  for (let loop = 1; loop <= 63; loop++) {
    const budgetAtStart = (cfg._nudges as number) || 0;
    if (budgetAtStart >= policyMax) starved.push(loop);
    cfg = { ...cfg, _nudges: policyMax, _lastNudgeAt: '2026-09-06T16:34:27.928Z' };  // task burns them all
    cfg = configForNextLoop(cfg, loop + 1);
  }

  assert.deepEqual(starved, [],
    `dispatches that began with no nudges left: ${starved.join(', ')} — the run stalls at the first of these`);
});
