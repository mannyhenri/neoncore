/**
 * Nothing stays stuck while nobody is watching.
 *
 * Two ways the queue stops making progress even though a cartridge could be working, both
 * introduced or exposed by earlier changes in this session:
 *
 * 1. THE BLOCKED BUDGET HALTS HEALTHY LANES. `MAX_BLOCKED_TICKS` (240 × 15s = 60 min) halts a
 *    lane that has been waiting for a busy target. But these cartridges legitimately work for
 *    hours — the CE run has been going since 18:30 — so the budget fires on perfectly healthy
 *    work. Worse, the halt PERSISTS after the cartridge frees: the lane stays paused and the
 *    cartridge sits idle with four confers queued behind it until a human resumes it. That is
 *    precisely the overnight failure this was meant to prevent, caused by the guard against it.
 *
 * 2. A CONFER BLOCKED ON A HUMAN HOLDS ITS LANE FOREVER. Its participants are `waiting`, which
 *    counts as busy, so nothing else dispatches. With four confers all needing the same two
 *    cartridges, one unanswered question stops the entire night's work.
 *
 * The distinction that makes both safe: halting is for a WEDGE, not for a wait. A blocker that
 * is alive and working needs patience; a blocker that is offline or stale needs a human. Those
 * are different conditions and only the second should stop a lane.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  enqueue, listQueue, tickQueue, resumeLane, haltLane, MAX_BLOCKED_TICKS,
} from '../src/lib/queue-runner.ts';

installStubIO();

let n = 0;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function agent(status: string, seenMsAgo = 0): string {
  const id = `km-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/repo/km', 'km', 'claude', status, ago(seenMsAgo));
  return id;
}
const row = (id: string) => listQueue().find((i) => i.id === id)!;
const lane = (l: string) =>
  db.prepare('SELECT paused, halted_reason FROM queue_lanes WHERE lane = ?').get(l) as
    { paused: number; halted_reason: string } | undefined;

/** Drive an item's blocked counter to the edge without waiting an hour. */
function atBudget(id: string) {
  db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(MAX_BLOCKED_TICKS, id);
}

// ─── 1. Waiting on healthy work is not a wedge ──────────────────────────────

test('a lane NEVER halts while its blocker is alive and working', () => {
  // The cartridges here run for hours. Halting on duration alone would stop the queue during
  // normal operation and leave it stopped after the work finished.
  const a = agent('working', 5_000);              // busy, fresh heartbeat
  const out = enqueue({ kind: 'prompt', payload: { text: 'patient' }, targets: [a] });
  assert.ok(out.ok);
  atBudget(out.item.id);
  tickQueue();

  assert.ok(!lane(out.item.lane)?.paused,
    'the lane halted while the cartridge was healthily working — it would stay halted after it freed');
  assert.equal(row(out.item.id).status, 'queued');
});

test('the item dispatches the moment the healthy blocker frees', () => {
  // The property the whole ask turns on: when one finishes, the next goes.
  const a = agent('working', 5_000);
  const out = enqueue({ kind: 'prompt', payload: { text: 'next up' }, targets: [a] });
  assert.ok(out.ok);
  atBudget(out.item.id);
  tickQueue();
  assert.equal(row(out.item.id).status, 'queued');

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue();
  assert.equal(row(out.item.id).status, 'running',
    'the cartridge freed and the queued item did not start');
});

// ─── 2. A genuine wedge still halts ─────────────────────────────────────────

test('a lane DOES halt when its blocker is offline — that is a real wedge', () => {
  const a = agent('offline', 5_000);
  // An offline agent is not "busy" by status, so stamp it as carrying someone else's item —
  // that is what makes it block. Only ONE item on the lane, or the runner would be judging
  // the one in front instead of this one.
  db.prepare('UPDATE agents SET active_queue_item_id = ? WHERE id = ?').run('someone-else', a);

  const out = enqueue({ kind: 'prompt', payload: { text: 'stuck behind a corpse' }, targets: [a] });
  assert.ok(out.ok);
  atBudget(out.item.id);
  tickQueue();
  assert.ok(lane(out.item.lane)?.paused, 'a dead blocker must still halt the lane for a human');
});

test('a lane DOES halt when its blocker has gone stale — silent for far too long', () => {
  const a = agent('working', 3 * 60 * 60 * 1000); // "working" but not seen for 3 hours
  const out = enqueue({ kind: 'prompt', payload: { text: 'behind a ghost' }, targets: [a] });
  assert.ok(out.ok);
  atBudget(out.item.id);
  tickQueue();
  assert.ok(lane(out.item.lane)?.paused,
    'a cartridge claiming to work but silent for hours is a wedge, not a wait');
});

// ─── 3. A cleared cause must not leave the lane stopped ─────────────────────

test('a lane halted for waiting AUTO-RESUMES once the blocker is healthy again', () => {
  // Otherwise every spurious halt needs a human, and "I am going away" ends with four confers
  // parked behind a lane nobody resumed.
  const a = agent('working', 3 * 60 * 60 * 1000);
  const out = enqueue({ kind: 'prompt', payload: { text: 'revive me' }, targets: [a] });
  assert.ok(out.ok);
  atBudget(out.item.id);
  tickQueue();
  assert.ok(lane(out.item.lane)?.paused, 'setup: the lane should be halted');

  // The cartridge comes back and goes idle.
  db.prepare("UPDATE agents SET status = 'idle', last_seen = ? WHERE id = ?")
    .run(new Date().toISOString(), a);
  tickQueue();

  assert.ok(!lane(out.item.lane)?.paused, 'the halt outlived its cause and the lane stayed stopped');
  assert.equal(row(out.item.id).status, 'running', 'the item did not resume once the lane cleared');
});

test('a lane halted by a real FAILURE does not auto-resume', () => {
  // Auto-resume must be scoped to the transient cause. A dispatch that failed three times is a
  // problem a human has to look at; silently retrying it forever is how a bad item burns a
  // cartridge all night.
  const a = agent('idle');
  const out = enqueue({ kind: 'prompt', payload: { text: 'genuinely broken' }, targets: [a] });
  assert.ok(out.ok);
  haltLane(out.item.lane, 'dispatch failed 3x', out.item.id);
  tickQueue();
  assert.ok(lane(out.item.lane)?.paused, 'a failure halt must survive the tick');
});

// ─── 4. A held item is still held ───────────────────────────────────────────

test('none of this overrides a hold a human placed', () => {
  const a = agent('idle');
  const out = enqueue({ kind: 'prompt', payload: { text: 'parked on purpose' }, targets: [a] });
  assert.ok(out.ok);
  db.prepare('UPDATE queue_items SET paused = 1 WHERE id = ?').run(out.item.id);
  resumeLane(out.item.lane);
  tickQueue();
  assert.equal(row(out.item.id).status, 'queued', 'a deliberate hold was overridden by keep-moving logic');
});
