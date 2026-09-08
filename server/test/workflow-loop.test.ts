import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLoopCount, shouldStopLooping, explainLoopCount, shouldExtendLoop,
  MAX_LOOP_CEILING, MAX_LOOP_EXTENSIONS,
} from '../src/lib/workflow-loop.ts';

/**
 * A workflow that must cover N tasks has to be told N — not asked to remember.
 *
 * REPORTED: "wouldn't it make more sense to identify the number of tasks, pass that integer into
 * the workflow as the number of times it repeats so it guarantees all the tasks will be covered?"
 *
 * Correct, and the template did not do it. Its loop lived entirely inside one step's PROMPT:
 * the engine dispatched `Work Every Task` once with `loopCount: 1`, and everything after the
 * first task depended on an agent obeying a long instruction for hours. An agent that completed
 * three of twelve and reported done ended the step, and the workflow moved on to Notify. Nothing
 * counted, so nothing noticed. The engine already had the primitive — loopCount re-dispatches a
 * step — and nothing anywhere set it from data.
 *
 * SET-BASED over the ways a count can be read or fail to be read, because the dangerous cases
 * are all the ones where the number is ABSENT or WRONG: silently looping once is the current bug,
 * and silently looping 900 times is the obvious over-correction.
 */

const CFG = (over: Record<string, unknown> = {}) => ({
  loopCount: 1,
  loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:\\s*(\\d+)' },
  ...over,
});

/** THE SET: what the upstream step said, and how many dispatches that must produce. */
const CASES: { label: string; deps: Record<string, string>; cfg?: Record<string, unknown>; want: number }[] = [
  { label: 'a clean count', deps: { 'Load Epic': 'EPIC: x\nTASKS: 7\n' }, want: 7 },
  { label: 'a count of one', deps: { 'Load Epic': 'TASKS: 1' }, want: 1 },
  { label: 'padded and lowercase-adjacent text around it', deps: { 'Load Epic': 'blah\n  TASKS:   12  \nmore' }, want: 12 },

  // Absent or unreadable: fall back to the static count rather than inventing one. Looping once
  // is wrong, but looping an arbitrary number because a regex missed is worse.
  { label: 'no match at all', deps: { 'Load Epic': 'EPIC: x' }, want: 1 },
  { label: 'the named step produced nothing', deps: { 'Load Epic': '' }, want: 1 },
  { label: 'the named step is not among the dependencies', deps: { 'Something Else': 'TASKS: 9' }, want: 1 },
  { label: 'no dependencies at all', deps: {}, want: 1 },

  // Nonsense numbers.
  { label: 'zero tasks', deps: { 'Load Epic': 'TASKS: 0' }, want: 1 },
  { label: 'a negative-looking count', deps: { 'Load Epic': 'TASKS: -3' }, want: 1 },
  { label: 'an absurd count is clamped, not obeyed', deps: { 'Load Epic': 'TASKS: 100000' }, want: MAX_LOOP_CEILING },

  // No dynamic config: the static number is authoritative.
  { label: 'static loopCount with no resolver', deps: { 'Load Epic': 'TASKS: 7' }, cfg: { loopCountFrom: undefined, loopCount: 3 }, want: 3 },
  { label: 'no loop config whatsoever', deps: {}, cfg: { loopCount: undefined, loopCountFrom: undefined }, want: 1 },
];

test('the case table is real — an empty scan would pass vacuously', () => {
  assert.ok(CASES.length >= 10, `expected a full case table, got ${CASES.length}`);
});

test('every way of reading a task count resolves to the right number of dispatches', () => {
  const failures: string[] = [];
  for (const c of CASES) {
    const got = resolveLoopCount(CFG(c.cfg ?? {}), c.deps);
    if (got !== c.want) failures.push(`${c.label}: resolved ${got}, expected ${c.want}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('a resolved count is never below one — a workflow that runs zero times is a silent skip', () => {
  for (const c of CASES) {
    assert.ok(resolveLoopCount(CFG(c.cfg ?? {}), c.deps) >= 1, `${c.label} resolved below 1`);
  }
});

/**
 * THE OTHER HALF: stopping early.
 *
 * A guaranteed count guarantees the work is COVERED, not that there is that much work. If the
 * tasks run out at 9 of 12, three more dispatches would send an agent to do nothing — and
 * "do nothing" is exactly the instruction most likely to be interpreted creatively.
 */
const STOP_CASES: { label: string; result: string; sentinel?: string; want: boolean }[] = [
  { label: 'the sentinel is present', result: 'ALL TASKS COMPLETE — 9 done, 0 skipped', want: true },
  { label: 'the sentinel appears mid-output', result: 'blah\nALL TASKS COMPLETE\nmore', want: true },
  { label: 'ordinary progress output', result: 'DONE task-4 · commit abc123 · 3 remaining', want: false },
  { label: 'empty result', result: '', want: false },
  { label: 'no sentinel configured', result: 'ALL TASKS COMPLETE', sentinel: '', want: false },
  // Case matters less than presence; an agent shouting it must still stop the loop.
  { label: 'different casing', result: 'all tasks complete', want: true },
];

test('the loop stops early when the work runs out', () => {
  const failures: string[] = [];
  for (const c of STOP_CASES) {
    const sentinel = c.sentinel === undefined ? 'ALL TASKS COMPLETE' : c.sentinel;
    const got = shouldStopLooping(c.result, { loopUntil: sentinel });
    if (got !== c.want) failures.push(`${c.label}: got ${got}, expected ${c.want}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

/**
 * ── THE BUDGET CAN END WHILE THE WORK HAS NOT ────────────────────────────────────────────
 *
 * LIVE, on the Redo-Between-Frames epic. `Load Epic` counted the epic at 12:28 UTC and reported
 * `TASKS: 10` — correct, Jira held exactly RBF-001..010. The run's OWN FIRST TASK was a probe,
 * and its verdict added an eleventh: RBF-011 was created at 13:10 UTC, 42 minutes after the
 * count, and inserted into the epic as a dependency of RBF-008. `Work Every Task` began at 14:38
 * with the budget frozen at 10. The agent works in dependency order, so RBF-011 took a slot and
 * pushed everything down one: the ten dispatches covered RBF-001..009 plus RBF-011, and RBF-010
 * — last in dependency order — fell off the end, never dispatched. `Verify Coverage` saw it
 * (`10/11 done · 1 outstanding`) and the run completed green anyway.
 *
 * A count sampled once is an ESTIMATE, and this template's first step exists precisely to
 * discover things. Freezing it is right — a loop whose length is re-read from its own output
 * every pass has no length. What was missing is the other half: a way for the loop to say the
 * work is not finished, bounded so it can never run away.
 *
 * SET-BASED over every way the budget and the work can diverge without anyone being told, since
 * the whole failure is that each of these reads as a clean finish.
 */
const DIVERGENCE = [
  'scope grew after the count was taken',
  'the count could not be read and fell back to the static one',
  'the count exceeded the ceiling and was clamped',
  'the final dispatch reported work still remaining',
  'the count was read cleanly and is trusted',
] as const;

test('the divergence set is enumerated, not sampled', () => {
  assert.equal(DIVERGENCE.length, 5,
    'the set of ways a budget can end with work outstanding changed — update it deliberately');
});

/**
 * Half one: the count's BASIS is always stated. A fallback to the static count is invisible
 * today — the executor logs only when the resolved number differs from the static one, so a
 * regex miss on a twelve-task epic resolves to 1, matches the static 1, and logs nothing at all.
 */
const BASIS_CASES: { label: string; deps: Record<string, string>; cfg?: Record<string, unknown>; basis: string; count: number }[] = [
  { label: 'read from upstream data', deps: { 'Load Epic': 'TASKS: 7' }, basis: 'data', count: 7 },
  { label: 'regex missed — fell back', deps: { 'Load Epic': 'EPIC: x' }, basis: 'fallback', count: 1 },
  { label: 'upstream step absent — fell back', deps: {}, basis: 'fallback', count: 1 },
  { label: 'unparseable number — fell back', deps: { 'Load Epic': 'TASKS: 0' }, basis: 'fallback', count: 1 },
  { label: 'over the ceiling — clamped', deps: { 'Load Epic': 'TASKS: 100000' }, basis: 'clamped', count: MAX_LOOP_CEILING },
  { label: 'no resolver configured at all', deps: {}, cfg: { loopCountFrom: undefined, loopCount: 3 }, basis: 'static', count: 3 },
];

test('every resolved count states HOW it was arrived at', () => {
  const failures: string[] = [];
  for (const c of BASIS_CASES) {
    const got = explainLoopCount(CFG(c.cfg ?? {}), c.deps);
    if (got.basis !== c.basis || got.count !== c.count) {
      failures.push(`${c.label}: got ${got.count}/${got.basis}, expected ${c.count}/${c.basis}`);
    }
    if (!got.note.trim()) failures.push(`${c.label}: produced an empty note`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('explainLoopCount and resolveLoopCount never disagree', () => {
  for (const c of [...CASES, ...BASIS_CASES]) {
    const cfg = CFG((c as { cfg?: Record<string, unknown> }).cfg ?? {});
    assert.equal(explainLoopCount(cfg, c.deps).count, resolveLoopCount(cfg, c.deps),
      `${c.label}: the two entry points resolved different counts`);
  }
});

/**
 * Half two: the loop may be EXTENDED when the last dispatch says work remains — the fix for
 * RBF-010. Bounded three ways so a runaway is impossible: only for a count that came from data
 * (a static count is the author's decision, not an estimate), never past MAX_LOOP_EXTENSIONS,
 * and never past MAX_LOOP_CEILING.
 */
const EXTEND: { label: string; over?: Partial<Parameters<typeof shouldExtendLoop>[0]>; want: boolean }[] = [
  { label: 'budget spent, work remains — the RBF-010 case', want: true },
  { label: 'budget spent, nothing remains', over: { result: 'DONE t · commit abc · 0 remaining' }, want: false },
  { label: 'budget spent, the stop sentinel was raised', over: { result: 'ALL TASKS COMPLETE · 2 remaining' }, want: false },
  { label: 'budget not yet spent — ordinary re-dispatch handles it', over: { currentLoop: 5 }, want: false },
  { label: 'the result says nothing about what remains', over: { result: 'finished the task' }, want: false },
  { label: 'a static count is a decision, not an estimate', over: { config: { loopCount: 10, loopUntil: 'ALL TASKS COMPLETE' } }, want: false },
  // WAS `want: false`, labelled "a single-dispatch step is not a loop". That reasoning holds for
  // a step whose AUTHOR wrote one dispatch — and that case is the row above, which has no
  // `loopCountFrom` and is still refused. This row is the other thing the old guard caught: a
  // step that reads its count from data, whose read FAILED, leaving the fallback budget of 1.
  // Live (GRD-3502): `Load Epic` was force-completed, the 53-task epic fell back to 1, the one
  // dispatch reported `52 remaining`, and the rescue was refused because the budget it wanted to
  // grow was 1. A budget known to be unreliable is the case that most needs extending.
  { label: 'a data-driven count that fell back to 1 is an estimate, and is rescuable', over: { currentLoop: 1, loopCount: 1 }, want: true },
  { label: 'a static single-dispatch step is still not a loop', over: { currentLoop: 1, loopCount: 1, config: { loopCount: 1, loopUntil: 'ALL TASKS COMPLETE' } }, want: false },
  { label: 'extensions are exhausted', over: { extensions: MAX_LOOP_EXTENSIONS }, want: false },
  { label: 'the hard ceiling is never crossed', over: { currentLoop: MAX_LOOP_CEILING, loopCount: MAX_LOOP_CEILING }, want: false },
  { label: 'the agent shouts it', over: { result: 'DONE t · commit abc · 4 REMAINING' }, want: true },
  { label: 'the last count in the output wins', over: { result: '3 remaining\nreconsidered: 0 remaining' }, want: false },
];

test('the loop extends exactly when the work outlived the budget', () => {
  const base = {
    result: 'DONE RBF-011 · commit 4f2a91c · 1 remaining',
    config: { loopCount: 1, loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:\\s*(\\d+)' }, loopUntil: 'ALL TASKS COMPLETE' },
    currentLoop: 10,
    loopCount: 10,
    extensions: 0,
  };
  const failures: string[] = [];
  for (const c of EXTEND) {
    const got = shouldExtendLoop({ ...base, ...(c.over ?? {}) } as Parameters<typeof shouldExtendLoop>[0]);
    if (got !== c.want) failures.push(`${c.label}: got ${got}, expected ${c.want}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('extension is bounded — no sequence of "work remains" runs past the ceiling', () => {
  // The property that matters more than any single case: an agent that says "1 remaining"
  // forever must still stop. Simulated end to end rather than asserted about one call.
  let loop = 3, budget = 3, extensions = 0, dispatches = 0;
  const config = { loopCount: 1, loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:\\s*(\\d+)' }, loopUntil: 'ALL TASKS COMPLETE' };
  while (shouldExtendLoop({ result: 'DONE x · commit y · 99 remaining', config, currentLoop: loop, loopCount: budget, extensions })) {
    budget += 1; extensions += 1; loop += 1; dispatches += 1;
    assert.ok(dispatches < 1000, 'the extension loop never terminated');
  }
  assert.equal(extensions, MAX_LOOP_EXTENSIONS, 'extensions stopped somewhere other than the stated cap');
  assert.ok(budget <= MAX_LOOP_CEILING, `budget ${budget} exceeded the hard ceiling`);
});
