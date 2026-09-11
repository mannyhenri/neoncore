// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { enqueue, listQueue, tickQueue, remapStaleTargets } from '../src/lib/queue-runner.ts';
import { KIND_IDS, type QueueKind } from '../src/lib/queue-kinds.ts';

/**
 * A queued item aimed at a cartridge that has since been RELAUNCHED must reach the relaunch.
 *
 * REPORTED: "just tried to redo a confer but it says Milestone "Frame" could not reach 2
 * participant(s) — is that cartridge running? they're both running". They were. Relaunching a
 * cartridge registers a NEW agent row with a new id; the old row stays, `offline`. The queue
 * item still carried the old ids — in `targets` and again inside its payload (a confer's
 * `participantIds`) — so the redo dispatched to two rows nothing was listening on, and failed
 * with a message that blamed the user for a cartridge that was visibly up.
 *
 * The item names a cartridge by NAME (machine/repo); the id is an implementation detail of one
 * launch. So at dispatch, every id that points at a dead row is moved to the live row of the
 * same name — in the targets AND everywhere in the payload, because each kind keeps its ids in
 * a different field and a fix that knew only about `targets` would still fail the confer.
 *
 * SET-BASED over every registered queue kind: each names where it carries cartridge ids, and a
 * kind added without a fixture here fails the test rather than silently keeping the old bug.
 */
const io = installStubIO();
let n = 0;
const now = () => new Date().toISOString();

function agent(name: string, status: string): string {
  const id = `ag-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, name, 'box', `/repo/${name}`, name, 'claude', status, now());
  return id;
}

/** How each kind carries cartridge ids in its payload, given the ids it targets. */
const PAYLOAD_FOR: Record<QueueKind, (ids: string[]) => Record<string, unknown>> = {
  prompt: () => ({ text: 'hello' }),
  workflow: (ids) => ({ workflowId: 'wf-1', repoPath: '/repo/a', startOptions: { agentId: ids[0], initialContext: 'x' } }),
  confer: (ids) => ({ repoName: 'a', repoPath: '/repo/a', participantIds: ids, task: 'talk' }),
  task: (ids) => ({ taskId: 't-1', agentId: ids[0] }),
};

test('THE SET: every registered queue kind has a fixture saying where it carries cartridge ids', () => {
  for (const k of KIND_IDS) assert.ok(PAYLOAD_FOR[k], `no fixture for kind "${k}"`);
});

test('every kind: ids of relaunched cartridges are moved to the live rows, in targets and payload', () => {
  for (const kind of KIND_IDS) {
    const oldA = agent(`box/${kind}-a`, 'offline');
    const oldB = agent(`box/${kind}-b`, 'offline');
    const newA = agent(`box/${kind}-a`, 'idle');
    const newB = agent(`box/${kind}-b`, 'working');
    const keep = agent(`box/${kind}-c`, 'idle');           // alive: must be left alone

    const id = `q-${kind}-${++n}`;
    db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, kind, JSON.stringify(PAYLOAD_FOR[kind]([oldA, oldB, keep])), JSON.stringify([oldA, oldB, keep]),
           `lane:${kind}`, 'queued', n, now());

    const before = listQueue().find((i) => i.id === id)!;
    const { item, remapped } = remapStaleTargets(before);

    assert.deepEqual(remapped, { [oldA]: newA, [oldB]: newB }, `${kind}: wrong remap table`);
    assert.deepEqual(item.targets, [newA, newB, keep], `${kind}: targets still point at the dead rows`);
    const payload = JSON.stringify(item.payload);
    assert.ok(!payload.includes(oldA) && !payload.includes(oldB), `${kind}: the payload still carries a dead id: ${payload}`);
    if (kind !== 'prompt') {
      assert.ok(payload.includes(newA), `${kind}: the payload does not name the relaunched cartridge: ${payload}`);
    }

    // Persisted, not just returned: the runner reads the row again on the next tick.
    const stored = listQueue().find((i) => i.id === id)!;
    assert.deepEqual(stored.targets, [newA, newB, keep], `${kind}: the remap was not written to the row`);
  }
});

test('an id with no live row of the same name is left as it is — the item then fails honestly', () => {
  const dead = agent('box/gone-forever', 'offline');
  const id = `q-gone-${++n}`;
  db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, 'prompt', JSON.stringify({ text: 'x' }), JSON.stringify([dead]), 'lane:gone', 'queued', n, now());
  const { item, remapped } = remapStaleTargets(listQueue().find((i) => i.id === id)!);
  assert.deepEqual(remapped, {});
  assert.deepEqual(item.targets, [dead]);
});

test('a dismissed relaunch is not a candidate, and the newest live row wins', () => {
  const old = agent('box/multi', 'offline');
  const dismissed = agent('box/multi', 'idle');
  db.prepare('UPDATE agents SET dismissed_at = ? WHERE id = ?').run(now(), dismissed);
  const older = agent('box/multi', 'idle');
  db.prepare("UPDATE agents SET last_seen = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(older);
  const newest = agent('box/multi', 'idle');

  const id = `q-multi-${++n}`;
  db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, 'prompt', JSON.stringify({ text: 'x' }), JSON.stringify([old]), 'lane:multi', 'queued', n, now());
  const { remapped } = remapStaleTargets(listQueue().find((i) => i.id === id)!);
  assert.deepEqual(remapped, { [old]: newest });
});

test('end to end: a redone prompt aimed at a relaunched cartridge is delivered to the relaunch', async () => {
  const old = agent('box/relaunched', 'offline');
  const fresh = agent('box/relaunched', 'idle');
  io.connect(fresh);                                   // a relay is listening on the NEW row only

  const out = enqueue({ kind: 'prompt', payload: { text: 'run this again' }, targets: [old] });
  assert.ok(out.ok, 'enqueue refused');
  tickQueue();
  // Dispatch is async (fleet-aware delivery awaits before it emits); wait for the wire, bounded.
  const hit = (id: string) => io.emissions.some((e) => e.event === 'command_send' && (e.room === `agent:${id}` || e.room === `sock-${id}`));
  for (let i = 0; i < 100 && !hit(fresh) && !hit(old); i++) await new Promise<void>((r) => setTimeout(r, 10));

  const item = listQueue().find((i) => i.id === (out as { item: { id: string } }).item.id)!;
  assert.equal(item.status, 'running', `expected the prompt to dispatch, got ${item.status}: ${item.error}`);
  assert.deepEqual(item.targets, [fresh], 'the prompt did not move to the relaunched cartridge');
  // What actually went over the wire: the stub records every room emission.
  assert.ok(hit(fresh), `nothing was emitted to the relaunched cartridge; emissions: ${JSON.stringify(io.emissions.map((e) => [e.room, e.event]))}`);
  assert.ok(!hit(old), 'the prompt was also sent to the dead row');
});
