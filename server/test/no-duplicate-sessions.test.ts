/**
 * A session is shown ONCE — either as the real session, or as the queue item still waiting.
 *
 * The main screen renders active confers/workflow runs, and (since queueing) the ones waiting
 * on a busy cartridge. The waiting filter accepted status `queued` OR `running` — but a
 * `running` queue item has already dispatched and carries a `handle` pointing at the session
 * it created. So the moment a queued confer started, it appeared twice: once as the real
 * ConferCard, once as its own still-running queue item.
 *
 * The rule: an item is "waiting" only while it has NOT produced a session. `handle` is the
 * evidence that it has. Tested as a predicate over the status set rather than by reading the
 * component, so a UI rewrite cannot lose the rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWaitingSession } from '../../packages/client/src/queue-view.ts';
import type { QueueItem } from '../../packages/client/src/types.ts';

const base = (over: Partial<QueueItem>): QueueItem => ({
  id: 'i', kind: 'confer', payload: {}, targets: [], lane: 'l',
  status: 'queued', position: 1, handle: '', result: '', error: '',
  createdAt: '', startedAt: null, finishedAt: null,
  attempts: 0, stallTicks: 0, corrupt: false,
  ...over,
});

test('EVERY status is classified, and only one of them means "waiting"', () => {
  const CASES: { status: QueueItem['status']; handle: string; waiting: boolean; why: string }[] = [
    { status: 'queued',    handle: '',      waiting: true,  why: 'not started — nothing else represents it' },
    { status: 'running',   handle: 'sess1', waiting: false, why: 'dispatched — the real session card renders it' },
    { status: 'running',   handle: '',      waiting: true,  why: 'marked running but not yet dispatched, so nothing else shows it' },
    { status: 'done',      handle: 'sess1', waiting: false, why: 'finished' },
    { status: 'failed',    handle: '',      waiting: false, why: 'finished' },
    { status: 'cancelled', handle: '',      waiting: false, why: 'finished' },
    { status: 'blocked',   handle: '',      waiting: false, why: 'not waiting to start; it needs a human' },
  ];
  const wrong = CASES
    .filter((c) => isWaitingSession(base({ status: c.status, handle: c.handle })) !== c.waiting)
    .map((c) => `${c.status}${c.handle ? '+handle' : ''}: expected ${c.waiting} — ${c.why}`);
  assert.deepEqual(wrong, [], `misclassified:\n  ${wrong.join('\n  ')}`);
});

test('a dispatched item is never waiting, whatever its status says', () => {
  // The invariant in one line: a handle means a session exists, and the session owns the
  // rendering. This is what stopped one confer from appearing as two.
  const withHandle = (['queued', 'running', 'done', 'failed'] as QueueItem['status'][])
    .filter((s) => isWaitingSession(base({ status: s, handle: 'sess1' })));
  assert.deepEqual(withHandle, [], `these render a duplicate alongside their own session: ${withHandle.join(', ')}`);
});

test('prompts are never session-waiting — they belong to the task list', () => {
  assert.equal(isWaitingSession(base({ kind: 'prompt', status: 'queued' })), false,
    'a queued prompt on the main screen rebuilds the second list the merge removed');
});
