/**
 * A failed item can be put back, and the whole prompt is readable.
 *
 * Two gaps the user hit in one sitting. A queue row showed two clipped lines, so the only way
 * to see what had actually been asked was the database. And a failed item was terminal — the
 * server restarted mid-prompt, the item failed by design, and there was no way to say "run
 * that again" short of retyping it.
 *
 * Retry is not "clear the error". It has to undo everything that stopped the item: the failed
 * status, the attempt counter that would halt it again after one more try, the stall counter,
 * and the lane halt that the failure caused. Resetting the status alone would produce an item
 * that looks queued and never runs, which is worse than a visible failure.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { retryItem, haltLane, listQueue, MAX_DISPATCH_ATTEMPTS } from '../src/lib/queue-runner.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function item(status: string, lane = 'agent:x', attempts = 0, stall = 0): string {
  const id = `q-${++n}`;
  db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position,
              created_at, started_at, finished_at, attempts, stall_ticks, error)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'prompt', JSON.stringify({ text: 'the full original request' }), '["a1"]', lane,
         status, n, ISO, ISO, ISO, attempts, stall, 'server restarted while this prompt was running');
  return id;
}

test('EVERY piece of state that stopped the item is undone', () => {
  // Set-based on the stop-causes, not on "status === queued". Each of these independently
  // prevents the item from running again, so clearing three of four produces an item that sits
  // in the queue forever looking fine.
  const lane = 'agent:retry-all';
  const id = item('failed', lane, MAX_DISPATCH_ATTEMPTS, 4);
  haltLane(lane, 'dispatch failed 3x', id); // the product records WHICH item halted it

  assert.equal(retryItem(id), true);

  const row = db.prepare('SELECT status, attempts, stall_ticks, error, finished_at, started_at FROM queue_items WHERE id = ?')
    .get(id) as Record<string, unknown>;
  const laneRow = db.prepare('SELECT paused, halted_reason FROM queue_lanes WHERE lane = ?').get(lane) as
    { paused: number; halted_reason: string } | undefined;

  const stillStopping: string[] = [];
  if (row.status !== 'queued') stillStopping.push(`status is ${row.status}`);
  if (row.attempts !== 0) stillStopping.push(`attempts is ${row.attempts} — it would halt again after one try`);
  if (row.stall_ticks !== 0) stillStopping.push(`stall_ticks is ${row.stall_ticks}`);
  if (row.error !== '') stillStopping.push('the old error is still displayed');
  if (row.finished_at !== null) stillStopping.push('finished_at still set — the item reads as complete');
  if (row.started_at !== null) stillStopping.push('started_at still set — the ceiling would measure from the OLD start');
  if (laneRow?.paused) stillStopping.push('the lane is still halted, so nothing in it can run');

  assert.deepEqual(stillStopping, [], `retry left the item unable to run:\n  ${stillStopping.join('\n  ')}`);
});

test('retrying does NOT resume a lane halted for an unrelated reason', () => {
  // Only the halt this item caused is cleared. A lane stopped by a different failure stays
  // stopped, or retrying one item silently restarts work a human deliberately paused.
  const lane = 'agent:shared';
  const failed = item('failed', lane);
  const other = item('failed', lane);
  haltLane(lane, `item ${other.slice(0, 8)} timed out`, other); // halted by the OTHER item

  retryItem(failed);
  const laneRow = db.prepare('SELECT paused FROM queue_lanes WHERE lane = ?').get(lane) as { paused: number };
  assert.equal(laneRow.paused, 1,
    'the lane was halted by a DIFFERENT item — retrying this one must not resume it');
});

test('only terminal items can be retried', () => {
  const RETRYABLE = ['failed', 'cancelled'];
  const NOT = ['queued', 'running', 'done'];
  const wrong: string[] = [];
  for (const s of RETRYABLE) if (!retryItem(item(s))) wrong.push(`${s} should be retryable`);
  for (const s of NOT) if (retryItem(item(s))) wrong.push(`${s} must NOT be retryable — it is not finished`);
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('retrying something that does not exist is false, not a crash', () => {
  assert.equal(retryItem('no-such-item'), false);
});

test('the FULL prompt is on the item the API returns — nothing is truncated server-side', () => {
  // Clipping belongs to the row rendering, never to the data. If the server trimmed it, the
  // "see it in its entirety" affordance would have nothing to expand to.
  const long = 'x'.repeat(4000);
  const id = `q-long-${++n}`;
  db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, 'prompt', JSON.stringify({ text: long }), '[]', 'agent:long', 'queued', n, ISO);

  const found = listQueue().find((q) => q.id === id);
  assert.equal((found?.payload as { text: string }).text.length, 4000,
    'the payload came back truncated, so no UI can show the request in full');
});
