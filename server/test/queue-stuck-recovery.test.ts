/**
 * A queued item must never wait forever in silence, and a human must always be able to
 * start one by hand.
 *
 * BOTH HALVES OF ONE COMPLAINT. Making the pre-dispatch guard agree with the route (a
 * cartridge busy with hand-typed work is busy) was correct, and it widened the window in
 * which an item waits on a target that may never free. The user hit the other end of it the
 * same afternoon: a prompt sat `queued` behind a working cartridge with no way to run it.
 * Waiting is right; waiting with no budget and no override is not.
 *
 * So there are two escapes, and they are different on purpose:
 *   · the BUDGET is automatic and pessimistic — after a long wait the lane halts with a
 *     reason naming the blocker, because a stopped queue you can read beats a queue that
 *     silently does nothing all night. This is the existing house rule (queue-resilience).
 *   · START NOW is manual and explicit — the human says "I know it is busy, do it anyway".
 *     That is categorically different from the runner deciding to dispatch onto busy work,
 *     which is the bug this whole feature exists to prevent. An override a person asks for
 *     is not the same as an override the system takes.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  enqueue, listQueue, tickQueue, startNow, haltLane, resumeLane,
  MAX_BLOCKED_TICKS,
} from '../src/lib/queue-runner.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function agent(status = 'working'): string {
  const id = `stuck-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/repo/s', 's', 'claude', status, ISO);
  return id;
}
/**
 * A blocker that is NOT coming back: claims to be working, silent for hours.
 *
 * Waiting on a healthy busy cartridge no longer halts anything — these cartridges legitimately
 * run for hours, and halting on duration stopped healthy lanes and left them stopped after the
 * work finished. Halting is now reserved for a genuine wedge, so a test that wants a halt has
 * to produce one.
 */
function wedgedAgent(): string {
  const id = agent('working');
  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?')
    .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), id);
  return id;
}

const row = (id: string) => listQueue().find((i) => i.id === id)!;
function lane(l: string) {
  return db.prepare('SELECT paused, halted_reason FROM queue_lanes WHERE lane = ?').get(l) as
    { paused: number; halted_reason: string } | undefined;
}

// ─── The budget: waiting is bounded, and the bound is generous ──────────────

test('the blocked budget is long enough that an ordinary turn never trips it', () => {
  // A cartridge legitimately works for many minutes. A budget tuned like the liveness one
  // (MAX_STALL_TICKS = 4, i.e. one minute) would halt healthy lanes constantly, which trains
  // people to resume without reading — and then the halt that mattered gets resumed too.
  assert.ok(MAX_BLOCKED_TICKS >= 120,
    `MAX_BLOCKED_TICKS=${MAX_BLOCKED_TICKS} is too aggressive for a normal long-running turn`);
});

test('a queued item blocked by a busy cartridge counts its wait', () => {
  const a = agent('working');
  const out = enqueue({ kind: 'prompt', payload: { text: 'wait for me' }, targets: [a] });
  assert.ok(out.ok);

  tickQueue();
  assert.equal(row(out.item.id).status, 'queued', 'must not dispatch onto a working cartridge');
  const first = row(out.item.id).stallTicks;
  tickQueue();
  assert.ok(row(out.item.id).stallTicks > first, 'a blocked item is not counting its wait at all');
});

test('the count RESETS once the cartridge frees — waits do not accumulate across turns', () => {
  // Without the reset, a lane that waited politely nine times over a week would halt on the
  // tenth for no reason anyone could see. The counter measures ONE continuous block.
  const a = agent('working');
  const out = enqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  assert.ok(out.ok);
  tickQueue();
  tickQueue();
  assert.ok(row(out.item.id).stallTicks > 0);

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a);
  tickQueue(); // now it dispatches, and the counter is cleared on start
  assert.equal(row(out.item.id).stallTicks, 0, 'the wait counter survived the block clearing');
});

test('at the budget the lane HALTS, and the reason names the cartridge holding it', () => {
  const a = wedgedAgent();
  const out = enqueue({ kind: 'prompt', payload: { text: 'held' }, targets: [a] });
  assert.ok(out.ok);
  const l = out.item.lane;

  // Drive the counter to the edge rather than ticking for an hour.
  db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(MAX_BLOCKED_TICKS, out.item.id);
  tickQueue();

  const state = lane(l);
  assert.ok(state?.paused, 'the lane waited past its budget without halting — silent forever');
  assert.match(state!.halted_reason, new RegExp(a),
    'the halt reason must name the blocking cartridge, or nobody can act on it');
});

test('below the budget the lane keeps waiting quietly', () => {
  const a = agent('working');
  const out = enqueue({ kind: 'prompt', payload: { text: 'patient' }, targets: [a] });
  assert.ok(out.ok);
  db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(MAX_BLOCKED_TICKS - 2, out.item.id);
  tickQueue();
  assert.ok(!lane(out.item.lane)?.paused, 'halted early — a normal long turn must not trip this');
});

test('a halt from one blocked lane does not stop an unrelated lane draining', () => {
  const blocked = wedgedAgent();
  const free = agent('idle');
  const held = enqueue({ kind: 'prompt', payload: { text: 'held' }, targets: [blocked] });
  const ok = enqueue({ kind: 'prompt', payload: { text: 'fine' }, targets: [free] });
  assert.ok(held.ok && ok.ok);

  db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(MAX_BLOCKED_TICKS, held.item.id);
  tickQueue();

  assert.ok(lane(held.item.lane)?.paused, 'the blocked lane should have halted');
  assert.equal(row(ok.item.id).status, 'running', 'a healthy lane stopped because another halted');
});

// ─── Start now: the human override ──────────────────────────────────────────

/**
 * THE SET of ways an item ends up sitting there, each needing the same one button.
 * Tested as a set because "start now" that only works for one of them is the same partial
 * fix as a queue that only guards two entry points.
 */
test('EVERY way an item gets stuck can be started by hand', () => {
  const CASES: { label: string; setup: () => string }[] = [
    {
      label: 'blocked behind a busy cartridge',
      setup: () => {
        const a = agent('working');
        const out = enqueue({ kind: 'prompt', payload: { text: 'go' }, targets: [a] });
        assert.ok(out.ok);
        return out.item.id;
      },
    },
    {
      label: 'its lane was halted',
      setup: () => {
        const a = agent('idle');
        const out = enqueue({ kind: 'prompt', payload: { text: 'go' }, targets: [a] });
        assert.ok(out.ok);
        haltLane(out.item.lane, 'something went wrong earlier', out.item.id);
        return out.item.id;
      },
    },
    {
      label: 'waiting behind another queued item in the same lane',
      setup: () => {
        const a = agent('idle');
        const first = enqueue({ kind: 'prompt', payload: { text: '1' }, targets: [a] });
        const second = enqueue({ kind: 'prompt', payload: { text: '2' }, targets: [a] });
        assert.ok(first.ok && second.ok);
        return second.item.id;
      },
    },
  ];

  const stuck: string[] = [];
  for (const c of CASES) {
    const id = c.setup();
    const out = startNow(id);
    if (!out.ok) { stuck.push(`${c.label}: startNow refused — ${out.error}`); continue; }
    if (row(id).status !== 'running') {
      stuck.push(`${c.label}: still ${row(id).status} after an explicit start`);
    }
  }
  assert.deepEqual(stuck, [], `these items cannot be started by hand:\n  ${stuck.join('\n  ')}`);
});

test('starting a halted lane by hand also RESUMES the lane', () => {
  // Otherwise the item runs once and everything behind it stays stopped, so the user has to
  // discover a second, differently-named control to get the queue moving again.
  const a = agent('idle');
  const out = enqueue({ kind: 'prompt', payload: { text: 'go' }, targets: [a] });
  assert.ok(out.ok);
  haltLane(out.item.lane, 'earlier failure', out.item.id);
  assert.ok(lane(out.item.lane)?.paused);

  assert.equal(startNow(out.item.id).ok, true);
  assert.ok(!lane(out.item.lane)?.paused, 'the lane is still halted, so nothing behind this will run');
});

test('start now REFUSES to double-dispatch onto a cartridge already running a queue item', () => {
  /**
   * THE LIMIT OF THE OVERRIDE. "I know it is busy, go anyway" is meaningful when the cartridge
   * is busy with work the queue does not own — something typed by hand — because the only cost
   * is two things talking at once. It is NOT meaningful when the cartridge is running another
   * QUEUE item, because `stamp()` overwrites active_queue_item_id unconditionally:
   *
   *   · the stamp moves from A to B
   *   · B's prompt lands on top of A's in-flight work
   *   · A's completion report then binds to B — so A can never complete, and B completes on
   *     work it never did
   *
   * That is the "a signal with no way to bind it" defect this codebase documents in
   * recordQueueCompletion. An override that silently corrupts attribution is not an override.
   */
  const a = agent('idle');
  const first = enqueue({ kind: 'prompt', payload: { text: '1' }, targets: [a] });
  const second = enqueue({ kind: 'prompt', payload: { text: '2' }, targets: [a] });
  assert.ok(first.ok && second.ok);

  tickQueue();
  assert.equal(row(first.item.id).status, 'running', 'the first item should be in flight');

  const out = startNow(second.item.id);
  assert.equal(out.ok, false, 'start-now double-dispatched onto a cartridge mid-item');
  assert.match((out as { error: string }).error, /running|in flight|busy/i,
    'the refusal must say WHICH condition blocked it, or the button looks broken');

  // And nothing was disturbed: the stamp still points at the item actually running.
  const stamp = db.prepare('SELECT active_queue_item_id FROM agents WHERE id = ?').get(a) as
    { active_queue_item_id: string };
  assert.equal(stamp.active_queue_item_id, first.item.id,
    'the refused start still moved the stamp — completion attribution is now wrong');
  assert.equal(row(second.item.id).status, 'queued');
});

test('start now IS allowed when the cartridge is busy with non-queue work', () => {
  // The case the override exists for: a hand-typed prompt is running, so there is no stamp to
  // corrupt. This is the difference between "busy" and "already carrying a queue item".
  const a = agent('working'); // working, unstamped
  const out = enqueue({ kind: 'prompt', payload: { text: 'go' }, targets: [a] });
  assert.ok(out.ok);
  assert.equal(startNow(out.item.id).ok, true, 'the override no longer works for its own use case');
  assert.equal(row(out.item.id).status, 'running');
});

test('start now REFUSES what is not startable, rather than pretending', () => {
  const REFUSALS: { label: string; id: () => string }[] = [
    {
      label: 'an item already running',
      id: () => {
        const a = agent('idle');
        const out = enqueue({ kind: 'prompt', payload: { text: 'r' }, targets: [a] });
        assert.ok(out.ok);
        tickQueue();
        assert.equal(row(out.item.id).status, 'running');
        return out.item.id;
      },
    },
    {
      label: 'an item already finished',
      id: () => {
        const a = agent('idle');
        const out = enqueue({ kind: 'prompt', payload: { text: 'd' }, targets: [a] });
        assert.ok(out.ok);
        db.prepare("UPDATE queue_items SET status = 'done' WHERE id = ?").run(out.item.id);
        return out.item.id;
      },
    },
    { label: 'an id that does not exist', id: () => 'no-such-item' },
  ];

  const wrong: string[] = [];
  for (const r of REFUSALS) {
    const out = startNow(r.id());
    if (out.ok) wrong.push(`${r.label}: startNow claimed success`);
    else if (!out.error) wrong.push(`${r.label}: refused with no reason`);
  }
  assert.deepEqual(wrong, [], `start now is dishonest about:\n  ${wrong.join('\n  ')}`);
});

test('resumeLane clears a blocked-budget halt so the lane can wait again', () => {
  // The halt must be recoverable by the ordinary control, not only by start-now: the
  // cartridge may simply have been busy, and the right answer is often "carry on waiting".
  const a = wedgedAgent();
  const out = enqueue({ kind: 'prompt', payload: { text: 'h' }, targets: [a] });
  assert.ok(out.ok);
  db.prepare('UPDATE queue_items SET stall_ticks = ? WHERE id = ?').run(MAX_BLOCKED_TICKS, out.item.id);
  tickQueue();
  assert.ok(lane(out.item.lane)?.paused);

  resumeLane(out.item.lane);
  assert.ok(!lane(out.item.lane)?.paused);
  assert.equal(row(out.item.id).stallTicks, 0, 'resuming must reset the wait, or it re-halts immediately');
});
