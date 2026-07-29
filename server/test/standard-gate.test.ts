/**
 * The default work-standard gate appended to new workflows (routes/workflows.ts).
 *
 * Importing the route module pulls in db.ts, which opens the real SQLite file. That is
 * acceptable here — the function under test is pure and touches neither.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withStandardGate } from '../src/routes/workflows.ts';

type Step = Record<string, unknown>;

const work = (id: string, deps: string[] = [], executorId = 'agent-1'): Step => ({
  id, name: `Work ${id}`, executorType: 'claude-code', executorId, dependsOn: deps,
});

const gateOf = (steps: Step[]) =>
  steps.find((s) => (s.executorConfig as Record<string, unknown> | undefined)?.gateType === 'standard');

test('a plain workflow gains a standard gate at the end', () => {
  const out = withStandardGate([work('a'), work('b', ['a'])]);
  assert.equal(out.length, 3);
  const gate = gateOf(out);
  assert.ok(gate, 'no standard gate was appended');
  assert.equal(gate.executorType, 'quality-gate');
  assert.deepEqual(gate.dependsOn, ['b'], 'the gate must run after the work');
});

test('the gate waits on EVERY terminal branch, not just the last step', () => {
  // a → b, a → c. Both b and c are terminal; a gate depending only on c would let an
  // unfinished parallel branch sail past the check.
  const out = withStandardGate([work('a'), work('b', ['a']), work('c', ['a'])]);
  const gate = gateOf(out)!;
  assert.deepEqual([...(gate.dependsOn as string[])].sort(), ['b', 'c']);
});

test('the gate inherits an executor so it can actually be dispatched', () => {
  const out = withStandardGate([work('a', [], 'cartridge-9')]);
  assert.equal(gateOf(out)!.executorId, 'cartridge-9');
});

test('opting out leaves the steps untouched', () => {
  const steps = [work('a')];
  assert.deepEqual(withStandardGate(steps, { skip: true }), steps);
});

// A workflow that already ends in a critic does not need a second one stacked on top.
const EXISTING_GATES = ['quality-gate', 'review-gate'];

test('no gate is added when the workflow already has one', () => {
  for (const type of EXISTING_GATES) {
    const out = withStandardGate([work('a'), { id: 'g', executorType: type, dependsOn: ['a'] }]);
    assert.equal(out.length, 2, `a ${type} should have suppressed the default gate`);
  }
});

test('a workflow with no work steps is left alone', () => {
  const steps = [{ id: 'c', executorType: 'connector', dependsOn: [] }];
  assert.deepEqual(withStandardGate(steps), steps);
});

test('steps with no explicit executorType count as work', () => {
  // '' defaults to claude-code at insert time, so it must be gated like one.
  const out = withStandardGate([{ id: 'a', executorId: 'agent-1', dependsOn: [] }]);
  assert.ok(gateOf(out), 'an untyped step is a work step and must be gated');
});

test('the appended gate never depends on itself', () => {
  const out = withStandardGate([work('a'), work('b', ['a'])]);
  const gate = gateOf(out)!;
  assert.ok(!(gate.dependsOn as string[]).includes(gate.id as string));
});

test('gate ids are unique across calls so two workflows never collide', () => {
  const a = gateOf(withStandardGate([work('a')]))!.id;
  const b = gateOf(withStandardGate([work('a')]))!.id;
  assert.notEqual(a, b);
});
