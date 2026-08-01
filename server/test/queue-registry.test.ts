/**
 * The queue's kind registry — every kind must be dispatchable AND detectable.
 *
 * This test is the reason the registry is data rather than a switch statement. The queue
 * advances one item when the previous one finishes, so a kind that can be STARTED but whose
 * completion cannot be OBSERVED does not fail loudly: it stalls that lane forever, or worse,
 * reports complete early and runs the next item on a cartridge still working on this one.
 * Running unattended overnight, both are silent.
 *
 * That is the same defect shape as the last feature — a producer with no consumer — so it is
 * tested by iterating the registry rather than by naming kinds. Add a kind to the union and
 * every assertion below applies to it automatically; forget its detector and this goes red
 * before it can ship.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_KINDS, KIND_IDS, getKind, type QueueKind, type QueueItem,
} from '../src/lib/queue-kinds.ts';

/** A queued-but-never-dispatched item of the given kind. */
function pending(kind: QueueKind): QueueItem {
  return {
    id: `item-${kind}`, kind, payload: {}, targets: [], lane: 'lane-1',
    status: 'queued', position: 0, handle: '', result: '', error: '',
    createdAt: new Date(0).toISOString(), startedAt: null, finishedAt: null,
  };
}

test('every kind in the union has a registry entry, and vice versa', () => {
  // Both directions on purpose. A kind added to the type with no entry is unrunnable; an
  // entry with no union member is unreachable code that reads as coverage.
  const registered = QUEUE_KINDS.map((k) => k.kind).sort();
  assert.deepEqual(registered, [...KIND_IDS].sort());
  assert.ok(QUEUE_KINDS.length > 0, 'an empty registry would make every assertion below vacuous');
});

test('every kind implements the COMPLETE contract — dispatch, detector, validator, describe', () => {
  const REQUIRED = ['dispatch', 'isComplete', 'validate', 'describe'] as const;
  const missing: string[] = [];
  for (const def of QUEUE_KINDS) {
    for (const fn of REQUIRED) {
      if (typeof (def as unknown as Record<string, unknown>)[fn] !== 'function') {
        missing.push(`${def.kind} is missing ${fn}()`);
      }
    }
  }
  assert.deepEqual(missing, [], `a kind that cannot be observed must not be dispatchable:\n  ${missing.join('\n  ')}`);
});

test('NO kind reports complete for an item that was never dispatched', () => {
  // The early-completion failure. A detector that answers 'complete' on an item with no
  // handle drains the whole queue the moment the tick runs — every item marked done, none
  // of them ever started. It reads as a successful overnight run.
  const wrong: string[] = [];
  for (const def of QUEUE_KINDS) {
    const verdict = def.isComplete(pending(def.kind));
    if (verdict.state === 'complete') wrong.push(`${def.kind} claims complete before dispatch`);
    if (!verdict.reason) wrong.push(`${def.kind} gave no reason for '${verdict.state}'`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('isComplete is THREE-STATE — "cannot tell" must be expressible', () => {
  // A boolean detector forces every uncertain case into complete-or-running. "I cannot tell"
  // is exactly the case that must stop the lane instead of advancing it, so it needs to be
  // sayable. This asserts the vocabulary, not any particular verdict.
  const LEGAL = new Set(['complete', 'running', 'needs_attention']);
  for (const def of QUEUE_KINDS) {
    const v = def.isComplete(pending(def.kind));
    assert.ok(LEGAL.has(v.state), `${def.kind} returned an unknown state '${v.state}'`);
    assert.notEqual(typeof v, 'boolean', `${def.kind} must not answer with a bare boolean`);
  }
});

test('every kind rejects an empty payload at the door', () => {
  // Validation at enqueue time, not at dispatch time. An item that cannot possibly run should
  // fail when the user adds it — while they are watching — not at 3am when it is next in line.
  const accepted: string[] = [];
  for (const def of QUEUE_KINDS) {
    if (def.validate({}) === null) accepted.push(`${def.kind} accepted an empty payload`);
  }
  assert.deepEqual(accepted, [], accepted.join('\n  '));
});

test('getKind throws on an unknown kind rather than silently doing nothing', () => {
  assert.throws(() => getKind('not-a-kind' as QueueKind), /unknown queue kind/i);
});
