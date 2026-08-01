/**
 * A queue you can leave running: ordinary events must not become permanent stops.
 *
 * Every defect the critique found had one shape. A socket blip during startup, a relay
 * reconnect, a deploy restart, a config change — each is routine, and each halted a lane until
 * a human resumed it. Over a week of unattended running the queue converges on fully stopped,
 * which defeats the entire point of the feature.
 *
 * Halting is still the right response to a GENUINE wedge — a stopped queue you can read beats a
 * drained queue that ran nothing correctly. So the fix is not to stop halting; it is to narrow
 * what counts as failure. This suite is the definition of that boundary, written as a SET so a
 * newly-added error path has to declare which side of it it is on.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import {
  enqueue, listQueue, tickQueue, reconcileQueue, rowToItem,
  MAX_DISPATCH_ATTEMPTS, MAX_STALL_TICKS,
} from '../src/lib/queue-runner.ts';

// A RECORDING STUB, never a real Socket.IO Server. sendCommandToAgent emits on dispatch, so
// without any io every prompt dispatch throws and the suite tests the retry path while believing
// it tests the happy one. But constructing a real server from a test sets the same module-global
// that production reads — a capability a test suite should not have at all, whatever it does with
// it. The stub gives the happy path and reaches nobody.
const { installStubIO } = await import('./helpers/stub-io.js');
installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function agent(status = 'working'): string {
  const id = `ag-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, agent_type, status, last_seen)
              VALUES (?,?,?,?,?,?,?)`).run(id, `t/${id}`, 'm', '/r', 'claude', status, ISO);
  return id;
}
function reset(): void {
  // A dispatched prompt writes real command/activity rows that reference the agent, so a plain
  // DELETE FROM agents trips a foreign key. Suspend enforcement for the fixture teardown only —
  // this is fixture cleanup, not something the product ever does.
  db.pragma('foreign_keys = OFF');
  for (const t of ['queue_items', 'queue_completions', 'queue_lanes', 'commands', 'activity', 'agents']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist in a trimmed schema */ }
  }
  db.pragma('foreign_keys = ON');
}
function lanePaused(lane: string): boolean {
  const r = db.prepare('SELECT paused FROM queue_lanes WHERE lane = ?').get(lane) as { paused: number } | undefined;
  return Boolean(r?.paused);
}
function itemRow(id: string): { status: string; attempts: number; stall_ticks: number } {
  return db.prepare('SELECT status, attempts, stall_ticks FROM queue_items WHERE id = ?').get(id) as never;
}
async function tickAndSettle(now = Date.now()): Promise<void> {
  tickQueue(now);
  await new Promise((r) => setTimeout(r, 80));
}

/** Make every outbound dispatch fail, without touching the developer's live server on :4040.
 *  This is the real transient class: the runner's first tick landing before the socket is up. */
async function withFailingDispatch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('WebSocket not initialized. Call initWebSocket first.'); }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// ─── The set: ordinary events, none of which may permanently stop a lane ────────────

test('NO transient condition permanently halts a lane on its first occurrence', async () => {
  const CASES: { label: string; setup: () => { lane: string; itemId: string } }[] = [
    {
      label: 'dispatch fails (socket not up yet — the startup race)',
      setup: () => {
        const out = enqueue({ kind: 'workflow', payload: { workflowId: 'w1' } });
        assert.ok(out.ok);
        return { lane: out.ok ? out.item.lane : '', itemId: out.ok ? out.item.id : '' };
      },
    },
    {
      label: 'target briefly offline (a relay reconnect)',
      setup: () => {
        const a = agent('offline');
        const out = enqueue({ kind: 'prompt', payload: { text: 'hi' }, targets: [a] });
        assert.ok(out.ok);
        const id = out.ok ? out.item.id : '';
        // Force it 'running' so the tick evaluates the live-target check rather than dispatch.
        db.prepare("UPDATE queue_items SET status='running', started_at=? WHERE id=?").run(ISO, id);
        return { lane: out.ok ? out.item.lane : '', itemId: id };
      },
    },
  ];

  const halted: string[] = [];
  for (const c of CASES) {
    reset();
    const { lane } = c.setup();
    await withFailingDispatch(() => tickAndSettle());
    if (lanePaused(lane)) halted.push(c.label);
  }
  assert.deepEqual(halted, [], `these routine events permanently halted a lane:\n  ${halted.join('\n  ')}`);
});

test('a transient condition DOES halt once it has persisted past its budget', async () => {
  // The other half of the boundary. Retrying forever is its own failure: an item that can never
  // dispatch would spin silently all night and look like a queue that is working.
  reset();
  const out = enqueue({ kind: 'workflow', payload: { workflowId: 'w1' } });
  assert.ok(out.ok);
  const id = out.ok ? out.item.id : '';
  const lane = out.ok ? out.item.lane : '';

  await withFailingDispatch(async () => {
    for (let i = 0; i < MAX_DISPATCH_ATTEMPTS; i++) await tickAndSettle();
  });

  assert.equal(itemRow(id).status, 'failed', 'a permanently undispatchable item must stop being retried');
  assert.equal(lanePaused(lane), true, 'and only THEN may the lane halt');
});

// ─── Corrupt persisted JSON must be contained at the boundary ───────────────────────

test('EVERY json column in queue_items survives corruption without throwing', () => {
  // Not just payload_json: the same unguarded parse applies to every serialized column, and a
  // test naming one would pass while the other still took the read path down.
  const JSON_COLUMNS = ['payload_json', 'targets_json'];
  const thrown: string[] = [];

  for (const col of JSON_COLUMNS) {
    reset();
    db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
                VALUES ('bad','prompt','{}','[]','lane-x','queued',1,?)`).run(ISO);
    db.prepare(`UPDATE queue_items SET ${col} = '{not json' WHERE id = 'bad'`).run();
    try {
      listQueue();
      tickQueue();
    } catch (err) {
      thrown.push(`${col}: ${(err as Error).message.slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    thrown, [],
    `a corrupt row must not take down the read path — every enqueue and every socket update ` +
    `goes through listQueue():\n  ${thrown.join('\n  ')}`,
  );
});

test('a corrupt row is quarantined, not silently treated as an empty item', () => {
  reset();
  db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
              VALUES ('bad','prompt','{not json','[]','lane-x','queued',1,?)`).run(ISO);
  tickQueue();
  const row = itemRow('bad');
  assert.equal(row.status, 'failed', 'an unreadable item must be marked, not skipped — skipping it silently loses work');
});

// ─── The arming collision: a read-only prompt must be able to finish ────────────────

test('a queued prompt ARMS the work standard at dispatch, so a read-only turn can still report', async () => {
  // Lazy arming (armOnWork) only fires on a MUTATING tool, by design: answering a question
  // should never oblige you to file a completion report. Correct for free conversation, fatal
  // as a queue signal — "research X" never arms, so `cleared` is never true, so the item hangs
  // to the ceiling. A queued item is dispatched work with a known objective, not conversation.
  reset();
  const a = agent('working');
  db.prepare("UPDATE agents SET standard_offered = 1, standard_armed = 0 WHERE id = ?").run(a);
  const out = enqueue({ kind: 'prompt', payload: { text: 'research X and report' }, targets: [a] });
  assert.ok(out.ok);
  await tickAndSettle();

  const row = db.prepare('SELECT standard_armed, active_objective FROM agents WHERE id = ?')
    .get(a) as { standard_armed: number; active_objective: string };
  assert.equal(row.standard_armed, 1, 'a queued prompt that edits no file could otherwise never complete');
});

// ─── Fan-out must not drive one cartridge from two lanes ────────────────────────────

test('a cartridge is never driven by two items at once, even across lanes', async () => {
  // lane = `agent:${targets[0]}` names ONE cartridge, so a prompt to [A,B] sits in lane agent:A
  // while an item targeting B sits in lane agent:B — and both tick. "One thing at a time" is the
  // premise of lanes, and multi-target is exactly the case the user asked for.
  reset();
  const a = agent('working');
  const b = agent('working');
  const fanout = enqueue({ kind: 'prompt', payload: { text: 'both' }, targets: [a, b] });
  const single = enqueue({ kind: 'prompt', payload: { text: 'just b' }, targets: [b] });
  assert.ok(fanout.ok && single.ok);
  const fanId = fanout.ok ? fanout.item.id : '';
  const oneId = single.ok ? single.item.id : '';

  // Pin the fan-out as running and bound to both cartridges, as dispatch would.
  db.prepare("UPDATE queue_items SET status='running', started_at=? WHERE id=?").run(ISO, fanId);
  db.prepare("UPDATE agents SET active_queue_item_id = ? WHERE id IN (?, ?)").run(fanId, a, b);

  await tickAndSettle();

  assert.equal(
    itemRow(oneId).status, 'queued',
    'cartridge B is already running the fan-out item — a second item must wait, not run concurrently',
  );
});

// ─── A deploy restart must not accumulate halts ─────────────────────────────────────

test('restart halts a lane ONLY when the target is genuinely still working', () => {
  const CASES: { status: string; expectHalt: boolean }[] = [
    { status: 'working', expectHalt: true },   // may still be mid-prompt — unsafe to continue
    { status: 'idle', expectHalt: false },     // definitively not running it
    { status: 'offline', expectHalt: false },  // definitively not running it
  ];
  const wrong: string[] = [];
  for (const c of CASES) {
    reset();
    const a = agent(c.status);
    const out = enqueue({ kind: 'prompt', payload: { text: 'x' }, targets: [a] });
    assert.ok(out.ok);
    const id = out.ok ? out.item.id : '';
    const lane = out.ok ? out.item.lane : '';
    db.prepare("UPDATE queue_items SET status='running', started_at=? WHERE id=?").run(ISO, id);

    reconcileQueue();

    assert.equal(itemRow(id).status, 'failed', 'the item always fails — its completion could not be observed');
    if (lanePaused(lane) !== c.expectHalt) {
      wrong.push(`agent ${c.status}: lane halted=${lanePaused(lane)}, expected ${c.expectHalt}`);
    }
  }
  assert.deepEqual(wrong, [], `restarts must not accumulate halts on lanes that are safe to continue:\n  ${wrong.join('\n  ')}`);
});

// ─── Loopback dispatch must survive strict auth ─────────────────────────────────────

test('the workflow dispatcher authenticates to its own server', async () => {
  // auth.ts rejects unauthenticated requests once strict mode is on — which is exactly what you
  // enable before leaving a machine running unattended, i.e. the scenario this feature is FOR.
  // Turning on the security setting would otherwise silently disable the workflow half.
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('fleet_token','tok-abc',?)").run(ISO);
  const { QUEUE_KINDS } = await import('../src/lib/queue-kinds.ts');
  const wf = QUEUE_KINDS.find((k) => k.kind === 'workflow')!;

  let seen: Record<string, string> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    seen = (init?.headers as Record<string, string>) ?? {};
    return { ok: true, status: 200, json: async () => ({ workflow: { id: 'run-1' } }), text: async () => '' } as unknown as Response;
  }) as typeof fetch;

  try {
    await wf.dispatch({ ...rowToItem({ id: 'i', kind: 'workflow', payload_json: '{"workflowId":"w1"}', targets_json: '[]', lane: 'l', status: 'queued', position: 1, created_at: ISO }) });
  } finally { globalThis.fetch = original; }

  assert.match(seen.Authorization ?? '', /^Bearer /, 'a loopback dispatch with no token dies the moment strict auth is enabled');
});

test('MAX_STALL_TICKS is exported so the offline budget is a stated number, not a magic one', () => {
  assert.ok(MAX_STALL_TICKS >= 1 && MAX_DISPATCH_ATTEMPTS >= 1);
});
