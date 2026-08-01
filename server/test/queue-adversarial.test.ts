import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { KIND_IDS, QUEUE_KINDS, getKind, recordQueueCompletion } from '../src/lib/queue-kinds.js';
import {
  enqueue, tickQueue, listQueue, reconcileQueue, haltLane, MAX_STALL_TICKS,
} from '../src/lib/queue-runner.js';
import { installStubIO } from './helpers/stub-io.js';

/**
 * A RECORDING STUB, NEVER A REAL SOCKET.
 *
 * A test suite must not be able to emit to anything a human is reading. That principle is
 * independent of any mechanism: measuring zero egress today is a fact about today's code,
 * not a property of the design, so the capability is removed rather than relied upon.
 *
 * The stub records emissions and transmits nothing, and connect() makes a cartridge look
 * attached — so the dispatch HAPPY PATH is exercised with no blast radius, and emissions
 * become assertable instead of invisible.
 */

/**
 * The hostile suite: the two ways this feature hurts someone at 3am.
 *
 * A queue that advances on a false completion runs item N+1 against a cartridge still
 * working on item N, all night, and every morning the queue looks drained. A queue that
 * stalls forever does nothing and says nothing. Everything below is a route into one of
 * those two, written to BREAK the implementation rather than to demonstrate it.
 *
 * The companion suite (queue-registry.test.ts) proves the design works. This one assumes
 * it does not.
 */

const io = installStubIO();

const now = () => Date.now();
const item = (id: string) => listQueue().find((i) => i.id === id)!;

function makeAgent(id: string, status = 'working'): string {
  db.prepare(`
    INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, branch, current_task,
      status, pending_question, trust_mode, agent_mode, last_seen, session_id, agent_type)
    VALUES (?, ?, 'm', '/tmp/r', 'r', 'main', '', ?, '', 0, 'trust', ?, ?, 'claude')
  `).run(id, id, status, new Date().toISOString(), `sess-${id}`);
  io.connect(id); // look attached, so dispatch takes the happy path rather than retrying
  return id;
}

/** Enqueue or fail loudly — a silent enqueue rejection would make every later assert vacuous. */
function mustEnqueue(input: Parameters<typeof enqueue>[0]) {
  const r = enqueue(input);
  assert.ok(r.ok, `enqueue rejected: ${r.ok ? '' : r.error}`);
  return r.item;
}

// ---------------------------------------------------------------------------
// The registry contract — set-based, so a half-built kind cannot ship
// ---------------------------------------------------------------------------

test('every kind declares validate/describe/dispatch/isComplete — a kind with no detector stalls its lane forever', () => {
  assert.equal(QUEUE_KINDS.length, KIND_IDS.length, 'registry and id list disagree');
  const broken: string[] = [];
  for (const id of KIND_IDS) {
    const def = getKind(id);
    for (const fn of ['validate', 'describe', 'dispatch', 'isComplete'] as const) {
      if (typeof def[fn] !== 'function') broken.push(`${id}.${fn}`);
    }
  }
  assert.deepEqual(broken, [], `registry incomplete: ${broken.join(', ')}`);
});

test('an unknown kind is rejected, never silently queued', () => {
  assert.throws(() => getKind('nope' as never), /unknown queue kind/i);
  const r = enqueue({ kind: 'nope' as never, payload: {} });
  assert.equal(r.ok, false, 'an unknown kind was accepted into the queue');
});

test('isComplete returns one of exactly three states for every kind, and always a reason', () => {
  const valid = new Set(['complete', 'running', 'needs_attention']);
  const bad: string[] = [];
  for (const id of KIND_IDS) {
    const fake = {
      id: `probe-${id}`, kind: id, payload: {}, targets: ['nobody'], lane: `probe-${id}`,
      status: 'running' as const, position: 0, handle: '', result: '', error: '',
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null,
    };
    try {
      const v = getKind(id).isComplete(fake);
      if (!valid.has(v.state)) bad.push(`${id}: state=${JSON.stringify(v.state)}`);
      if (!v.reason) bad.push(`${id}: no reason — unactionable at 3am`);
    } catch (e) { bad.push(`${id}: threw ${(e as Error).message}`); }
  }
  assert.deepEqual(bad, [], bad.join(', '));
});

// ---------------------------------------------------------------------------
// ADVANCING ON A NON-COMPLETION
// ---------------------------------------------------------------------------

test('ATTACK: an UNSTAMPED agent reporting completion must not advance anything', () => {
  // The demotion bug one level up: a report that cannot be bound to an item must be
  // ignored, never attributed to "whatever that agent is running".
  const a = makeAgent('adv-unbound');
  const first = mustEnqueue({ kind: 'prompt', payload: { text: '1' }, targets: [a] });
  const second = mustEnqueue({ kind: 'prompt', payload: { text: '2' }, targets: [a] });
  tickQueue(now());
  assert.equal(item(first.id).status, 'running');

  db.prepare("UPDATE agents SET active_queue_item_id = '' WHERE id = ?").run(a);
  recordQueueCompletion(a, true, 'I am done (unstamped)');
  tickQueue(now());

  assert.equal(item(first.id).status, 'running', 'an unstamped report advanced the item');
  assert.equal(item(second.id).status, 'queued', 'an unstamped report started the next item');
});

test('ATTACK: a report stamped for a DIFFERENT item must not complete this one', () => {
  const a = makeAgent('adv-wrongitem');
  const mine = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  tickQueue(now());
  db.prepare('UPDATE agents SET active_queue_item_id = ? WHERE id = ?').run('some-other-item', a);
  recordQueueCompletion(a, true, 'done, but for another item');
  tickQueue(now());
  assert.equal(item(mine.id).status, 'running', 'a report bound elsewhere completed this item');
});

test('ATTACK: replaying the same report must advance exactly one item, not two', () => {
  const a = makeAgent('adv-replay');
  const i1 = mustEnqueue({ kind: 'prompt', payload: { text: '1' }, targets: [a] });
  const i2 = mustEnqueue({ kind: 'prompt', payload: { text: '2' }, targets: [a] });
  const i3 = mustEnqueue({ kind: 'prompt', payload: { text: '3' }, targets: [a] });
  tickQueue(now());
  for (let i = 0; i < 5; i++) recordQueueCompletion(a, true, 'replayed');
  tickQueue(now());
  assert.equal(item(i1.id).status, 'done');
  assert.equal(item(i2.id).status, 'running', 'replay did not advance exactly one');
  assert.equal(item(i3.id).status, 'queued', 'replay skipped an item — the queue drained faster than the work');
});

test('ATTACK: needs_review HALTS the lane — the overnight failure mode', () => {
  // standard_state='needs_review' is set exactly when an agent stopped WITHOUT filing a
  // report. Reading that as success is how broken work stacks on broken work all night.
  const a = makeAgent('adv-review');
  const first = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  const second = mustEnqueue({ kind: 'prompt', payload: { text: 'y' }, targets: [a] });
  tickQueue(now());
  db.prepare("UPDATE agents SET standard_state = 'needs_review' WHERE id = ?").run(a);
  tickQueue(now());

  const f = item(first.id);
  assert.notEqual(f.status, 'done', 'work that never filed a report was marked done');
  assert.ok(['blocked', 'failed'].includes(f.status), `expected halt, got ${f.status}`);
  assert.equal(item(second.id).status, 'queued', 'the lane advanced past unreported work');
  assert.ok(f.error || f.result, 'halted with no reason recorded');
});

test('ATTACK: fan-out needs EVERY target to report — a silent target must not be discarded', () => {
  const a = makeAgent('adv-fan-a');
  const b = makeAgent('adv-fan-b');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a, b], lane: 'adv-fan' });
  tickQueue(now());
  db.prepare('UPDATE agents SET active_queue_item_id = ? WHERE id = ?').run(it.id, a);
  recordQueueCompletion(a, true, 'a is done');
  tickQueue(now());
  assert.notEqual(item(it.id).status, 'done', 'completed while one target never reported — its work was discarded');
});

test('ATTACK: a FAILED report must not read as completion', () => {
  const a = makeAgent('adv-failrep');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  tickQueue(now());
  db.prepare('UPDATE agents SET active_queue_item_id = ? WHERE id = ?').run(it.id, a);
  recordQueueCompletion(a, false, 'could not do it');
  tickQueue(now());
  assert.notEqual(item(it.id).status, 'done', 'a failure report was treated as success');
});

// ---------------------------------------------------------------------------
// STALLING FOREVER
// ---------------------------------------------------------------------------

test('ATTACK: an offline cartridge halts once its budget is spent — not on sight, but not never either', () => {
  // Deliberately NOT a halt on the first tick: a reconnect is one or two ticks, so offline
  // gets MAX_STALL_TICKS of budget (the companion test proves a one-tick blip survives).
  // This is the other half — a condition that PERSISTS past its budget must still halt,
  // because retrying forever is its own silent failure.
  const a = makeAgent('adv-offline');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  tickQueue(now());
  db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(a);
  for (let i = 0; i <= MAX_STALL_TICKS; i++) tickQueue(now());
  const s = item(it.id).status;
  assert.ok(['blocked', 'failed'].includes(s),
    `offline target left the item ${s} after ${MAX_STALL_TICKS + 1} ticks — it will wait forever`);
});

test('ATTACK: a wedged-but-alive item hits the ceiling and halts, never completes', () => {
  // Signal-only cannot see a cartridge blocked on a permission prompt nobody will answer.
  // This is the honest cost of rejecting idle-advance; the ceiling is what bounds it.
  const a = makeAgent('adv-wedged');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  tickQueue(now());
  assert.equal(item(it.id).status, 'running');
  const sevenHoursLater = now() + 7 * 60 * 60 * 1000;
  tickQueue(sevenHoursLater);
  const after = item(it.id);
  assert.notEqual(after.status, 'done', 'a ceiling was treated as completion');
  assert.ok(['blocked', 'failed'].includes(after.status), `wedged item left ${after.status}`);
});

test('ATTACK: a poisoned lane must not stop an unrelated healthy lane', () => {
  const bad = makeAgent('adv-poison');
  const good = makeAgent('adv-healthy');
  const poisoned = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [bad], lane: 'lane-poison' });
  const healthy = mustEnqueue({ kind: 'prompt', payload: { text: 'y' }, targets: [good], lane: 'lane-healthy' });
  tickQueue(now());
  // Corrupt the poisoned row so its detector has to cope with garbage.
  db.prepare("UPDATE queue_items SET payload_json = '{not json' WHERE id = ?").run(poisoned.id);
  assert.doesNotThrow(() => tickQueue(now()), 'a corrupt row threw out of the tick and stopped every lane');

  db.prepare('UPDATE agents SET active_queue_item_id = ? WHERE id = ?').run(healthy.id, good);
  recordQueueCompletion(good, true, 'fine');
  assert.doesNotThrow(() => tickQueue(now()));
  assert.equal(item(healthy.id).status, 'done', 'a poisoned lane blocked an unrelated healthy lane');
});

test('ATTACK: a halted lane must not stop other lanes draining', () => {
  const a = makeAgent('adv-halt-a');
  const b = makeAgent('adv-halt-b');
  const stuck = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a], lane: 'lane-stuck' });
  const moving = mustEnqueue({ kind: 'prompt', payload: { text: 'y' }, targets: [b], lane: 'lane-moving' });
  haltLane('lane-stuck', 'test halt');
  tickQueue(now());
  assert.notEqual(item(stuck.id).status, 'running', 'a halted lane still dispatched');
  assert.equal(item(moving.id).status, 'running', 'a halted lane stopped an unrelated lane');
});

test('ATTACK: an item cannot be double-started, however many ticks race it', () => {
  // startItem marks running BEFORE awaiting dispatch. That is reasoning, not a test —
  // so this is the test.
  const a = makeAgent('adv-double');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  for (let i = 0; i < 5; i++) tickQueue(now());
  const started = db.prepare('SELECT started_at FROM queue_items WHERE id = ?').get(it.id) as { started_at: string };
  tickQueue(now());
  const again = db.prepare('SELECT started_at FROM queue_items WHERE id = ?').get(it.id) as { started_at: string };
  assert.equal(again.started_at, started.started_at, 'started_at moved — the item was dispatched twice');
});

test('ATTACK: a restart mid-item reconciles rather than stranding or silently completing', () => {
  const a = makeAgent('adv-restart');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  tickQueue(now());
  assert.equal(item(it.id).status, 'running');
  // Simulate the crash: the stamp is gone, the row still says running.
  db.prepare("UPDATE agents SET active_queue_item_id = '' WHERE id = ?").run(a);
  assert.doesNotThrow(() => reconcileQueue());
  const after = item(it.id);
  assert.notEqual(after.status, 'done', 'a restart silently completed an item nobody observed finishing');
  assert.notEqual(after.status, 'running', 'a restart left a prompt stranded with no stamp and no observer');
});

test('ATTACK: a READ-ONLY prompt must still be able to complete — most queued prompts edit nothing', async () => {
  // The feature-breaking one. send-command.ts:204 dispatches with standard_armed = 0, and
  // work-standard.ts:325 returns cleared:false while unarmed — so "research X", "review this",
  // "what is the status of Y" can NEVER clear, never bind a completion, and hang until the
  // 6h ceiling. The lazy arming is correct FOR the work standard (a conversation should not
  // owe a report) and fatal AS a queue signal. A queued item is dispatched work with a known
  // objective, not free conversation, so it must arm at dispatch.
  const a = makeAgent('adv-readonly');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'research X and tell me what you find' }, targets: [a] });
  tickQueue(now());
  // tickQueue is synchronous but startItem awaits dispatch, so arming lands after this
  // turn of the loop. Asserting immediately reads state before the await resolves.
  await new Promise((r) => setTimeout(r, 200));
  const armed = db.prepare('SELECT standard_armed, active_queue_item_id FROM agents WHERE id = ?')
    .get(a) as { standard_armed: number; active_queue_item_id: string };
  assert.equal(armed.active_queue_item_id, it.id, 'queue dispatch did not stamp the agent');
  assert.equal(armed.standard_armed, 1,
    'a queue-dispatched prompt was left unarmed — a read-only prompt can never report completion');
});

test('ATTACK: a multi-target item must not let a second item drive the same cartridge', () => {
  // lane = `agent:${targets[0]}` uses the FIRST target only, so an item on [A,B] occupies
  // lane agent:A while another item on [B] occupies agent:B — and both tick. That breaks the
  // one-cartridge-one-thing invariant in exactly the "one or many cartridges" case the user
  // asked for.
  const a = makeAgent('adv-lane-a');
  const b = makeAgent('adv-lane-b');
  const fan = mustEnqueue({ kind: 'prompt', payload: { text: 'fan' }, targets: [a, b] });
  const solo = mustEnqueue({ kind: 'prompt', payload: { text: 'solo' }, targets: [b] });
  tickQueue(now());
  const both = [item(fan.id).status, item(solo.id).status].filter((s) => s === 'running');
  assert.equal(both.length, 1,
    `cartridge ${b} is being driven by two running items at once — the lane invariant is broken`);
});

test('ATTACK: a one-tick offline blip is a reconnect, not a death', () => {
  // Relay reconnects, a VS Code reload, or the cleanup scheduler flipping status all produce
  // a transient offline. Permanent consequence for a routine event.
  const a = makeAgent('adv-blip');
  const it = mustEnqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
  tickQueue(now());
  db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(a);
  tickQueue(now());
  db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(a);
  tickQueue(now());
  const s = item(it.id).status;
  assert.notEqual(s, 'failed', 'a single-tick reconnect killed the item');
  assert.ok(['running', 'queued'].includes(s), `expected survival across a blip, got ${s}`);
});

test('ATTACK: a restart must not halt the lane when the agent is demonstrably not still working', () => {
  // Failing the ITEM is right — its completion could not be observed. Halting the LANE means
  // a human is needed after every deploy, and a 24/7 queue that needs a person per deploy is
  // not 24/7. If the target is offline, the old prompt is definitively not running.
  const a = makeAgent('adv-deploy');
  const first = mustEnqueue({ kind: 'prompt', payload: { text: '1' }, targets: [a] });
  const second = mustEnqueue({ kind: 'prompt', payload: { text: '2' }, targets: [a] });
  tickQueue(now());
  db.prepare("UPDATE agents SET active_queue_item_id = '', status = 'offline' WHERE id = ?").run(a);
  reconcileQueue();
  assert.notEqual(item(first.id).status, 'done', 'a restart silently completed an unobserved item');
  const lane = db.prepare('SELECT paused FROM queue_lanes WHERE lane = ?').get(`agent:${a}`) as { paused: number } | undefined;
  assert.notEqual(lane?.paused, 1,
    'the lane was halted by a restart even though the agent is offline and cannot still be working');
  void second;
});

test('an empty queue is a cheap no-op', () => {
  assert.doesNotThrow(() => tickQueue(now()));
  assert.doesNotThrow(() => tickQueue(now()));
});
