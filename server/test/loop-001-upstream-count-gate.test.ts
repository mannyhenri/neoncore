/**
 * LOOP-001 — a step whose output another step reads a loop count from must actually emit it.
 *
 * THE DEFECT. `loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:\s*(\d+)' }` sizes a loop
 * from an upstream step's result. When that step reports its counts as prose — "43 child
 * issues, 42 To Do" — the regex misses and `explainLoopCount` falls back to the static
 * `loopCount: 1`. The run works ONE task and reports a clean finish. Measured across the 27
 * dispatched epic loops on this machine, 10 died this way, including six consecutive
 * fantasy-coach runs each doing 1 task of ~40. The engine already logs a warning nobody acts
 * on, so a malformed upstream step degrades silently into a valid-looking single-task run.
 *
 * ── WHY THIS IS NOT HARDCODED TO "Load Epic" ──────────────────────────────────────────
 * The requirement is not a property of a step called Load Epic; it is a property of being
 * READ FROM. `Epic: Two Repos` has two independent loops reading TASKS_A and TASKS_B off one
 * upstream step, and a future template will invent another. So the rule is derived from the
 * config registry: for the step completing now, find every sibling whose `loopCountFrom.step`
 * names it, and require the result to satisfy each of their patterns.
 *
 * ── THE INVARIANT THAT MATTERS MOST ───────────────────────────────────────────────────
 * The gate must accept EXACTLY what the reader accepts — no more, no less. A gate that is
 * stricter blocks work that would have run fine; a gate that is looser lets a result through
 * that still falls back to 1, which is the bug wearing a badge saying it was checked. That is
 * asserted over a corpus rather than at the one or two points I would think of.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopCountRequirements, validateUpstreamCount, type LoopConfig } from '../src/lib/workflow-loop.js';

const READER: LoopConfig = { loopCountFrom: { step: 'Load Epic', pattern: 'TASKS:\\s*(\\d+)' } };
const TWO_REPOS: { name: string; config: LoopConfig }[] = [
  { name: 'Work Repo A', config: { loopCountFrom: { step: 'Scope & Partition', pattern: 'TASKS_A:\\s*(\\d+)' } } },
  { name: 'Work Repo B', config: { loopCountFrom: { step: 'Scope & Partition', pattern: 'TASKS_B:\\s*(\\d+)' } } },
];

test('a step nobody reads a count from carries no requirement', () => {
  const reqs = loopCountRequirements('Notify', [{ name: 'Work Every Task', config: READER }]);
  assert.deepEqual(reqs, []);
  assert.equal(validateUpstreamCount('anything at all', reqs).ok, true);
});

test('a step that IS read from must emit the count', () => {
  const reqs = loopCountRequirements('Load Epic', [{ name: 'Work Every Task', config: READER }]);
  assert.equal(reqs.length, 1);

  const good = validateUpstreamCount('EPIC: X\nSTATE: tracker\nTASKS: 42', reqs);
  assert.equal(good.ok, true, 'a result carrying the count must be accepted');

  const bad = validateUpstreamCount('the epic has 43 child issues, 42 still To Do', reqs);
  assert.equal(bad.ok, false, 'prose counts are exactly the defect — they must be rejected');
  if (!bad.ok) {
    assert.match(bad.reason, /TASKS/, 'the reason must name the pattern the author has to satisfy');
    assert.match(bad.reason, /Work Every Task/, 'and which step is waiting to read it');
  }
});

test('every reader must be satisfied, not just the first', () => {
  const reqs = loopCountRequirements('Scope & Partition', TWO_REPOS);
  assert.equal(reqs.length, 2, 'two independent loops read this one step');

  assert.equal(validateUpstreamCount('TASKS_A: 5\nTASKS_B: 9', reqs).ok, true);

  const half = validateUpstreamCount('TASKS_A: 5', reqs);
  assert.equal(half.ok, false, 'satisfying one loop and starving the other is a half-fix');
  if (!half.ok) assert.match(half.reason, /TASKS_B/, 'the reason must name the MISSING one');
});

test('an unparseable pattern is an authoring bug and must not block work', () => {
  const reqs = loopCountRequirements('Load Epic',
    [{ name: 'Broken', config: { loopCountFrom: { step: 'Load Epic', pattern: '([unclosed' } } }]);
  const out = validateUpstreamCount('no count here', reqs);
  assert.equal(out.ok, true, 'a bad regex must not wedge an agent behind a gate it cannot satisfy');
});

/** THE INVARIANT: gate acceptance and reader matching must agree on every candidate. */
test('the gate accepts exactly what the reader accepts', () => {
  const pattern = 'TASKS:\\s*(\\d+)';
  const reqs = loopCountRequirements('Load Epic', [{ name: 'R', config: { loopCountFrom: { step: 'Load Epic', pattern } } }]);
  const corpus = [
    'TASKS: 42', 'TASKS:42', 'TASKS:   7', 'tasks: 42', 'TASKS: forty',
    'prefix TASKS: 3 suffix', 'TASKS:\n42', '', 'TASKS:', 'TASKS: 0',
    'EPIC: k\nSTATE: tracker\nROOT: /r\nTESTS: npm test\nTASKS: 15',
    'the epic has 43 child issues, 42 To Do',
  ];
  const disagreements: string[] = [];
  for (const r of corpus) {
    const readerWould = new RegExp(pattern).test(r);
    const gateDoes = validateUpstreamCount(r, reqs).ok;
    if (readerWould !== gateDoes) {
      disagreements.push(`${JSON.stringify(r)}: reader=${readerWould} gate=${gateDoes}`);
    }
  }
  assert.deepEqual(disagreements, [],
    `the gate and the parser disagree — a result that passes the gate and still falls back to 1\n` +
    `is the original bug wearing a badge saying it was checked:\n  ${disagreements.join('\n  ')}`);
});
