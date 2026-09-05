import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLoopCount, shouldStopLooping, MAX_LOOP_CEILING } from '../src/lib/workflow-loop.ts';

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
