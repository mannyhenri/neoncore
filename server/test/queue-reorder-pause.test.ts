/**
 * A queue you can arrange: reorder what runs next, and hold one item without holding the lane.
 *
 * WHAT ALREADY EXISTED, AND WHY IT WASN'T ENOUGH. You could pause a whole LANE — which stops
 * everything behind it too — and `startNow` could jump one item to the front. Between "stop
 * the world" and "run this immediately" there was nothing: no way to say "this one is more
 * important than that one but neither is urgent", and no way to park one item while the rest
 * of the lane keeps draining.
 *
 * ── THE DISTINCTION THAT MATTERS ───────────────────────────────────────────────────────
 * Pausing an ITEM must NOT stall its lane. If a paused item at the head blocked everything
 * behind it, per-item pause would just be lane-pause with extra steps, and the feature would
 * be a trap: you park one thing and silently stop five others. So a paused item is SKIPPED —
 * the runner steps over it and dispatches the next eligible one. That is the whole reason
 * this is a separate concept from `haltLane`.
 *
 * ── WHY PAUSE IS A COLUMN, NOT A STATUS ────────────────────────────────────────────────
 * `blocked` already means "stopped and waiting on a human" and is what a halted lane produces.
 * Overloading it would make "the system stopped this" indistinguishable from "I stopped this",
 * and those need different UI and different recovery. A paused item is still `queued`; it is
 * simply not eligible.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  enqueue, listQueue, tickQueue, moveItem, pauseItem, resumeItem, startNow,
} from '../src/lib/queue-runner.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function agent(status = 'idle'): string {
  const id = `rp-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/repo/r', 'r', 'claude', status, ISO);
  return id;
}
const row = (id: string) => listQueue().find((i) => i.id === id)!;

/** Three items on one lane, in order, aimed at a BUSY cartridge so nothing dispatches yet. */
function lane(): { a: string; ids: string[] } {
  const a = agent('working');
  const ids = ['first', 'second', 'third'].map((t) => {
    const out = enqueue({ kind: 'prompt', payload: { text: t }, targets: [a] });
    assert.ok(out.ok);
    return out.item.id;
  });
  return { a, ids };
}
/** The queued items of a lane, in the order the runner would pick them. */
function order(laneName: string): string[] {
  return (db.prepare(
    "SELECT id FROM queue_items WHERE lane = ? AND status = 'queued' ORDER BY position",
  ).all(laneName) as { id: string }[]).map((r) => r.id);
}

// ─── Reordering ─────────────────────────────────────────────────────────────

test('EVERY move direction reorders within the lane', () => {
  const { ids } = lane();
  const l = row(ids[0]).lane;
  assert.deepEqual(order(l), ids, 'fixture should start in insertion order');

  const CASES: { label: string; id: string; dir: 'up' | 'down'; want: number[] }[] = [
    { label: 'move the last item up', id: ids[2], dir: 'up', want: [0, 2, 1] },
    { label: 'move it up again to the front', id: ids[2], dir: 'up', want: [2, 0, 1] },
    { label: 'move the front item down', id: ids[2], dir: 'down', want: [0, 2, 1] },
  ];

  const wrong: string[] = [];
  for (const c of CASES) {
    const out = moveItem(c.id, c.dir);
    if (!out.ok) { wrong.push(`${c.label}: refused — ${out.error}`); continue; }
    const got = order(l);
    const want = c.want.map((i) => ids[i]);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      wrong.push(`${c.label}: expected ${JSON.stringify(c.want)} got ${JSON.stringify(want.map((w) => ids.indexOf(w)))}`);
    }
  }
  assert.deepEqual(wrong, [], `reordering is wrong for:\n  ${wrong.join('\n  ')}`);
});

test('moving past either end is a no-op, not an error or a corrupted order', () => {
  const { ids } = lane();
  const l = row(ids[0]).lane;
  assert.equal(moveItem(ids[0], 'up').ok, true, 'moving the first item up should be harmless');
  assert.deepEqual(order(l), ids, 'a no-op move reordered the lane anyway');
  assert.equal(moveItem(ids[2], 'down').ok, true);
  assert.deepEqual(order(l), ids);
});

test('reordering changes what actually runs next', () => {
  // The assertion that makes the rest meaningful: position is not decoration.
  const { a, ids } = lane();
  moveItem(ids[2], 'up');
  moveItem(ids[2], 'up'); // third is now first
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue();
  assert.equal(row(ids[2]).status, 'running', 'the reordered item did not run first');
  assert.equal(row(ids[0]).status, 'queued');
});

test('a running item cannot be reordered', () => {
  const { a, ids } = lane();
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue();
  assert.equal(row(ids[0]).status, 'running');
  const out = moveItem(ids[0], 'down');
  assert.equal(out.ok, false, 'reordering work already in flight must be refused');
});

// ─── Per-item pause ─────────────────────────────────────────────────────────

test('a paused item is SKIPPED — the lane keeps draining', () => {
  // The property this whole feature turns on. If pausing the head stalled the lane, this
  // would silently be lane-pause and would hold up everything behind it.
  const { a, ids } = lane();
  assert.equal(pauseItem(ids[0]).ok, true);
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue();

  assert.equal(row(ids[0]).status, 'queued', 'a paused item must not dispatch');
  assert.equal(row(ids[0]).paused, true, 'it should still read as paused');
  assert.equal(row(ids[1]).status, 'running', 'the lane stalled behind a paused item');
});

test('resuming puts it back in line where it was', () => {
  const { a, ids } = lane();
  pauseItem(ids[0]);
  assert.equal(resumeItem(ids[0]).ok, true);
  assert.equal(row(ids[0]).paused, false);
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue();
  assert.equal(row(ids[0]).status, 'running', 'a resumed item lost its place');
});

test('a whole lane of paused items dispatches nothing and does not halt', () => {
  // Halting is for wedges. "I paused everything" is a choice, and the lane must be ready to
  // run the moment one is resumed rather than needing a separate un-halt.
  const { a, ids } = lane();
  ids.forEach((i) => pauseItem(i));
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue();

  for (const i of ids) assert.equal(row(i).status, 'queued');
  const laneRow = db.prepare('SELECT paused FROM queue_lanes WHERE lane = ?').get(row(ids[0]).lane) as
    { paused: number } | undefined;
  assert.ok(!laneRow?.paused, 'pausing every item must not halt the lane itself');
});

test('Start now overrides a pause — the explicit human action wins', () => {
  // Otherwise "start this now" silently does nothing on the exact item you were looking at,
  // which reads as the button being broken.
  const { ids } = lane();
  pauseItem(ids[0]);
  assert.equal(startNow(ids[0]).ok, true);
  assert.equal(row(ids[0]).paused, false, 'start-now left it paused');
  assert.equal(row(ids[0]).status, 'running');
});

test('pause and resume REFUSE what is not queued', () => {
  const { a, ids } = lane();
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue();
  assert.equal(row(ids[0]).status, 'running');

  const wrong: string[] = [];
  if (pauseItem(ids[0]).ok) wrong.push('pausing a RUNNING item claimed success');
  if (pauseItem('no-such-item').ok) wrong.push('pausing a missing item claimed success');
  if (resumeItem('no-such-item').ok) wrong.push('resuming a missing item claimed success');
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});
