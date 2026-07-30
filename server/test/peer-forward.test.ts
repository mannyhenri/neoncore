import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

/**
 * Reaching an agent a PEER owns.
 *
 * A cartridge registers with exactly one server — whichever its relay points at. Federation
 * gossiped state but never routed commands, so a server asked to message an agent it did not
 * own simply answered 404. That is precisely why a confer across two machines needed a human
 * to carry every message.
 *
 * The pure resolution/merge logic is tested here against an injectable fetch, so the failure
 * modes that actually matter — a sleeping peer, a peer that lies, an id collision — are
 * exercised deterministically rather than depending on two live servers.
 */

const PEER_A = 'http://peer-a.local:4040';
const PEER_B = 'http://peer-b.local:4040';

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | 'throw';

/** Swap global fetch for a scripted fleet. Returns the calls made, for routing assertions. */
function withFleet(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const out = handler(u, init);
    if (out === 'throw') throw new Error('unreachable');
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body,
      text: async () => JSON.stringify(out.body),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** peer-forward reads the peer list and token from the module-level db singleton. */
function seedPeers(urls: string[]) {
  const db = new Database(process.env.NEONCORE_DB_PATH!);
  db.exec('DELETE FROM peers');
  const now = new Date().toISOString();
  for (const u of urls) {
    db.prepare('INSERT INTO peers (url, server_id, name, version, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(u, '', '', '', now);
  }
  db.close();
}

// UNCONDITIONAL, never honouring an inherited value: seedPeers() runs DELETE FROM peers,
// and inheriting NEONCORE_DB_PATH would point that at a developer's real database.
process.env.NEONCORE_DB_PATH = `/tmp/neoncore-peerfwd-${process.pid}.db`;

const { findAgentOwner, forwardMessageToOwner, listFleetAgents } = await import('../src/lib/peer-forward.ts');

// ─── Ownership resolution ───────────────────────────────────────────────────

test('finds the peer that owns an agent', async () => {
  seedPeers([PEER_A, PEER_B]);
  const f = withFleet((url) =>
    url.startsWith(PEER_B) && url.includes('/api/agents/')
      ? { status: 200, body: { id: 'agent-x' } }
      : { status: 404, body: {} });
  try {
    assert.equal(await findAgentOwner('agent-x'), PEER_B);
  } finally { f.restore(); }
});

test('nobody owning it is null, not a crash', async () => {
  seedPeers([PEER_A, PEER_B]);
  const f = withFleet(() => ({ status: 404, body: {} }));
  try {
    assert.equal(await findAgentOwner('ghost'), null);
  } finally { f.restore(); }
});

// A sleeping laptop is the normal case in this fleet, not an exceptional one.
test('an unreachable peer never masks a healthy one', async () => {
  seedPeers([PEER_A, PEER_B]);
  const f = withFleet((url) =>
    url.startsWith(PEER_A) ? 'throw' : { status: 200, body: { id: 'agent-x' } });
  try {
    assert.equal(await findAgentOwner('agent-x'), PEER_B, 'a dead peer must not hide the owner');
  } finally { f.restore(); }
});

test('with no peers at all it resolves to null without any network call', async () => {
  seedPeers([]);
  const f = withFleet(() => ({ status: 200, body: { id: 'agent-x' } }));
  try {
    assert.equal(await findAgentOwner('agent-x'), null);
    assert.equal(f.calls.length, 0, 'a single-server install must not make peer calls');
  } finally { f.restore(); }
});

// ─── Delivery ───────────────────────────────────────────────────────────────

test('forwards to the OWNING peer, on the real delivery endpoint', async () => {
  seedPeers([PEER_A, PEER_B]);
  const f = withFleet((url) => {
    if (url.includes('/api/agents/')) return url.startsWith(PEER_B) ? { status: 200, body: { id: 'a1' } } : { status: 404, body: {} };
    return { status: 201, body: { id: 'cmd', delivered: true } };
  });
  try {
    const out = await forwardMessageToOwner('a1', 'hello peer');
    assert.equal(out.ok, true);
    assert.equal(out.origin, PEER_B);

    const send = f.calls.find((c) => c.url.includes('/api/commands/send'));
    assert.ok(send, 'must use /api/commands/send — /api/agents/message records, it does not deliver');
    assert.ok(send!.url.startsWith(PEER_B), 'must be sent to the owner, not another peer');
    assert.match(String((send!.init as RequestInit).body), /hello peer/);
  } finally { f.restore(); }
});

test('a peer that accepts but cannot deliver is reported as NOT delivered', async () => {
  seedPeers([PEER_B]);
  const f = withFleet((url) =>
    url.includes('/api/agents/')
      ? { status: 200, body: { id: 'a1' } }
      : { status: 201, body: { id: 'cmd', delivered: false } });
  try {
    const out = await forwardMessageToOwner('a1', 'hi');
    assert.equal(out.ok, false, 'accepted-but-undelivered must not read as success');
    assert.match(out.reason || '', /live command channel/i);
  } finally { f.restore(); }
});

test('every failure mode returns a reason instead of throwing', async () => {
  const CASES: { label: string; handler: Handler }[] = [
    { label: 'owner unreachable mid-send', handler: (u) => (u.includes('/api/agents/') ? { status: 200, body: { id: 'a1' } } : 'throw') },
    { label: 'peer rejects the send', handler: (u) => (u.includes('/api/agents/') ? { status: 200, body: { id: 'a1' } } : { status: 500, body: { error: 'boom' } }) },
    { label: 'nobody owns it', handler: () => ({ status: 404, body: {} }) },
  ];
  const silent: string[] = [];
  for (const c of CASES) {
    seedPeers([PEER_B]);
    const f = withFleet(c.handler);
    try {
      const out = await forwardMessageToOwner('a1', 'hi');
      if (out.ok || !out.reason) silent.push(c.label);
    } finally { f.restore(); }
  }
  assert.deepEqual(silent, [], `these failed without explaining why: ${silent.join(', ')}`);
});

// ─── Fleet-wide agent listing ───────────────────────────────────────────────

test('merges peer agents and tags each with its origin', async () => {
  seedPeers([PEER_B]);
  const f = withFleet(() => ({ status: 200, body: [{ id: 'remote-1', name: 'macbook/neoncore' }] }));
  try {
    const all = await listFleetAgents([{ id: 'local-1', name: 'macpro/neoncore' }]);
    assert.equal(all.length, 2);
    assert.equal(all.find((a) => a.id === 'local-1')!.origin, '');
    assert.equal(all.find((a) => a.id === 'remote-1')!.origin, PEER_B);
  } finally { f.restore(); }
});

test('a duplicate id keeps the LOCAL view', async () => {
  seedPeers([PEER_B]);
  const f = withFleet(() => ({ status: 200, body: [{ id: 'dup', name: 'stale-remote-copy' }] }));
  try {
    const all = await listFleetAgents([{ id: 'dup', name: 'authoritative-local' }]);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'authoritative-local');
  } finally { f.restore(); }
});

test('an unreachable peer does not blank the local list', async () => {
  seedPeers([PEER_A]);
  const f = withFleet(() => 'throw');
  try {
    const all = await listFleetAgents([{ id: 'local-1' }]);
    assert.deepEqual(all.map((a) => a.id), ['local-1']);
  } finally { f.restore(); }
});
