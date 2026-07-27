/**
 * Federation unit tests.
 *
 * Every case here maps to a row in the plan's failure-mode table that was marked SILENT:
 * a bug that produces no error, no crash and no log, just a subtly wrong grid. Those are
 * the ones that need a test, because nothing else will ever tell you.
 *
 * NEONCORE_DB_PATH is set BEFORE any import that reaches db.ts, so this file gets its own
 * throwaway database and never touches the developer's real neoncore.db.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'neoncore-fed-'));
process.env.NEONCORE_DB_PATH = join(TMP, 'test.db');
process.env.NEONCORE_URL = 'http://self.test:4040';

// Imported after the env is set — db.ts reads NEONCORE_DB_PATH at module load.
const {
  normalizePeerUrl, addPeer, listPeerUrls, listPeers, mergeRoster, removePeer,
  recordPeerOk, recordPeerFailure, prunePeers, isSelf, STALE_AFTER_FAILURES, DROP_AFTER_MS,
} = await import('../src/lib/federation.ts');
const { getServerId } = await import('../src/lib/server-url.ts');
const db = (await import('../src/db.ts')).default;

before(() => { db.exec('DELETE FROM peers'); });
beforeEach(() => { db.exec('DELETE FROM peers'); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

// ─── URL normalization ──────────────────────────────────────────────────────
// SILENT FAILURE: `host:4040` and `host:4040/` become two rows for one server. It is
// pinged twice, counted twice, and every one of its cartridges renders twice in the
// merged grid. Nothing errors.

test('normalize: trailing slash does not create a second peer', () => {
  assert.equal(normalizePeerUrl('http://box:4040/'), normalizePeerUrl('http://box:4040'));
});

test('normalize: host case does not create a second peer', () => {
  assert.equal(normalizePeerUrl('http://BOX:4040'), 'http://box:4040');
});

test('normalize: default ports collapse onto the bare origin', () => {
  assert.equal(normalizePeerUrl('https://a.ts.net:443'), 'https://a.ts.net');
  assert.equal(normalizePeerUrl('http://a.local:80'), 'http://a.local');
});

test('normalize: a non-default port is preserved', () => {
  assert.equal(normalizePeerUrl('https://a.ts.net:8443'), 'https://a.ts.net:8443');
});

test('normalize: a sub-path is kept (a peer may sit behind a reverse proxy)', () => {
  assert.equal(normalizePeerUrl('https://h/neoncore/'), 'https://h/neoncore');
});

test('normalize: junk and non-http schemes are rejected, never stored', () => {
  for (const bad of ['', '   ', 'not a url', 'ftp://h', 'file:///etc/passwd', null, 42, {}]) {
    assert.equal(normalizePeerUrl(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('adding the same server under two spellings yields ONE peer', () => {
  addPeer('http://box:4040');
  addPeer('http://BOX:4040/');
  assert.deepEqual(listPeerUrls(), ['http://box:4040']);
});

// ─── Self-exclusion ─────────────────────────────────────────────────────────
// SILENT FAILURE: a server adds itself, then pings itself forever. A phantom extra
// server appears in every client's grid and the roster grows on each restart.

test('a server never adds itself by its own URL', () => {
  assert.equal(isSelf('http://self.test:4040'), true);
  assert.equal(addPeer('http://self.test:4040'), false);
  assert.deepEqual(listPeerUrls(), []);
});

test('self-exclusion survives spelling differences', () => {
  assert.equal(addPeer('http://SELF.TEST:4040/'), false);
  assert.deepEqual(listPeerUrls(), []);
});

test('a different URL with OUR serverId is still us', () => {
  // A server legitimately answers on localhost, its LAN name and its Tailscale name.
  // Matching on URL alone would let it enter its own roster under an alias.
  assert.equal(addPeer('http://other-name:4040', { serverId: getServerId() }), false);
  assert.deepEqual(listPeerUrls(), []);
});

test('self-exclusion honours extra aliases the server answers on', () => {
  assert.equal(isSelf('http://alias.local:4040', ['http://alias.local:4040']), true);
});

// ─── Roster merge ───────────────────────────────────────────────────────────

test('merge is a union — it adds what is new and keeps what is known', () => {
  addPeer('http://a:4040');
  const added = mergeRoster(['http://a:4040', 'http://b:4040', 'http://c:4040']);
  assert.deepEqual(added.sort(), ['http://b:4040', 'http://c:4040']);
  assert.deepEqual(listPeerUrls().sort(), ['http://a:4040', 'http://b:4040', 'http://c:4040']);
});

test('merge drops self and junk out of a peer payload', () => {
  const added = mergeRoster(['http://self.test:4040', 'garbage', 'http://real:4040', null]);
  assert.deepEqual(added, ['http://real:4040']);
});

test('merge tolerates a malformed payload instead of throwing', () => {
  // A peer on a different version may send anything. Throwing here would kill the tick
  // and take down liveness for every other peer.
  for (const junk of [null, undefined, 'nope', 42, { peers: [] }]) {
    assert.deepEqual(mergeRoster(junk), []);
  }
});

test('merge is idempotent — replaying the same roster adds nothing', () => {
  mergeRoster(['http://a:4040', 'http://b:4040']);
  assert.deepEqual(mergeRoster(['http://a:4040', 'http://b:4040']), []);
  assert.equal(listPeerUrls().length, 2);
});

// ─── Liveness and staleness ─────────────────────────────────────────────────

test('a peer is not stale until it has failed STALE_AFTER_FAILURES times in a row', () => {
  addPeer('http://a:4040');
  for (let i = 0; i < STALE_AFTER_FAILURES - 1; i++) recordPeerFailure('http://a:4040', 'boom');
  assert.equal(listPeers()[0].stale, false, 'one failure short of the threshold');

  recordPeerFailure('http://a:4040', 'boom');
  assert.equal(listPeers()[0].stale, true);
});

test('a single success clears the failure streak', () => {
  addPeer('http://a:4040');
  for (let i = 0; i < STALE_AFTER_FAILURES + 2; i++) recordPeerFailure('http://a:4040', 'boom');
  assert.equal(listPeers()[0].stale, true);

  recordPeerOk('http://a:4040', { name: 'studio', serverId: 'sid-1', version: '1' });
  const [peer] = listPeers();
  assert.equal(peer.stale, false);
  assert.equal(peer.consecutiveFailures, 0);
  assert.equal(peer.lastError, '');
  assert.equal(peer.name, 'studio');
});

test('recordPeerOk does not blank known metadata when a reply omits it', () => {
  addPeer('http://a:4040', { name: 'studio', serverId: 'sid-1' });
  recordPeerOk('http://a:4040', {});
  const [peer] = listPeers();
  assert.equal(peer.name, 'studio');
  assert.equal(peer.serverId, 'sid-1');
});

// ─── Pruning ────────────────────────────────────────────────────────────────

test('a healthy peer is never pruned, however old', () => {
  addPeer('http://a:4040');
  recordPeerOk('http://a:4040');
  prunePeers(Date.now() + DROP_AFTER_MS * 10);
  assert.deepEqual(listPeerUrls(), ['http://a:4040']);
});

test('a peer unreachable past the drop window is removed', () => {
  addPeer('http://a:4040');
  recordPeerFailure('http://a:4040', 'ECONNREFUSED');
  const dropped = prunePeers(Date.now() + DROP_AFTER_MS + 60_000);
  assert.deepEqual(dropped, ['http://a:4040']);
  assert.deepEqual(listPeerUrls(), []);
});

test('a peer that was NEVER reachable still ages out, measured from when it was added', () => {
  // A URL typed with a typo has no last_ok_at to age from. Without the added_at fallback
  // it would sit in the roster forever, pinged every 15s, for nothing.
  addPeer('http://typo:4040');
  recordPeerFailure('http://typo:4040', 'ENOTFOUND');
  assert.deepEqual(prunePeers(Date.now() + DROP_AFTER_MS + 60_000), ['http://typo:4040']);
});

test('a peer failing but still inside the window is kept', () => {
  addPeer('http://a:4040');
  recordPeerFailure('http://a:4040', 'timeout');
  assert.deepEqual(prunePeers(Date.now() + 60_000), []);
  assert.deepEqual(listPeerUrls(), ['http://a:4040']);
});

// ─── Identity ───────────────────────────────────────────────────────────────
// SILENT FAILURE: a serverId regenerated on boot makes every restart look like a brand
// new server. The old id lingers in peers' rosters as a ghost.

test('serverId is stable across calls and persisted in settings', () => {
  const first = getServerId();
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(getServerId(), first);

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'server_id'").get() as { value: string };
  assert.equal(stored.value, first);
});

// ─── Manual removal ─────────────────────────────────────────────────────────

test('removePeer deletes, and reports when there was nothing to delete', () => {
  addPeer('http://a:4040');
  assert.equal(removePeer('http://A:4040/'), true, 'removal normalizes too');
  assert.equal(removePeer('http://a:4040'), false);
});
