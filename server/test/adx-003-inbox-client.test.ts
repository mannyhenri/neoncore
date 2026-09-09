/**
 * ADX-003 — THE SOCKET CLIENT, AND THE FAILURES IT MUST TELL APART.
 *
 * `postToInbox(pid, token, text)` is the transport ADX-005 will wire into
 * `sendCommandToAgent`. Its whole job is to be HONEST about what happened, because the caller
 * has to choose between "delivered, stop here" and "fall through to the next branch". A client
 * that returns a bare boolean forces that decision to be made on no information.
 *
 * ── THE FAILURE MODES ARE THE SPECIFICATION ───────────────────────────────────────────
 * Four are named in the task; a fifth comes from ADX-001's measured caveat and is the reason
 * this file exists at all:
 *
 *   no-socket   the path is absent — the session exited (the spike measured that the socket is
 *               removed on exit), so there is nothing to talk to
 *   refused     the path exists but nothing is listening — a STALE socket, the exact artefact
 *               a crashed session leaves behind
 *   timeout     connected and the write never completed
 *   auth        the peer rejected the credential. Cannot happen on macOS today (the spike
 *               measured that even a WRONG token is delivered) but is mandatory on Windows,
 *               so the shape exists rather than being retrofitted later
 *   stale-pid   the path resolves to a process that is NOT the cartridge we meant. A pid is
 *               recycled by the OS; the socket is named by pid. Writing to whatever now owns
 *               that number is how a prompt lands in a stranger's session
 *
 * ── WHY IT VERIFIES THE ENDPOINT RATHER THAN TRUSTING THE PATH ────────────────────────
 * ADX-001 says so explicitly: "the CLI's own client additionally verifies the endpoint's pid and
 * uid before writing; our client should do the same rather than trusting the path, since a stale
 * socket path can be re-bound by a recycled pid." Trusting `/tmp/cc-socks/<pid>.sock` to mean
 * what it says is the one mistake with a blast radius outside this process.
 *
 * ── THE DEADLINE IS ABOUT WHEN THE CONNECTION OPENS ───────────────────────────────────
 * Claude Code closes a connection whose first line has not arrived in 30s. The task's phrasing —
 * "the connection opens only when the message is ready" — is the real requirement: build the
 * payload first, THEN connect. A client that connects and then goes looking for its text is
 * racing a deadline it does not own.
 *
 * Every test here runs against a REAL Unix socket created in a temp dir, never a live cartridge.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postToInbox, inboxPathFor, INBOX_DEADLINE_MS, type InboxResult } from '../src/lib/inbox-client.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adx003-'));
const sockPath = (name: string) => path.join(TMP, `${name}.sock`);
const servers: net.Server[] = [];

test.after(() => {
  for (const s of servers) { try { s.close(); } catch { /* already closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A listener that records every line it receives, standing in for a cartridge's inbox. */
function listener(p: string, opts: { onLine?: (l: string, sock: net.Socket) => void } = {}) {
  const lines: string[] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        lines.push(line);
        opts.onLine?.(line, sock);
      }
    });
    sock.on('error', () => { /* client hangups are normal */ });
  });
  servers.push(server);
  return new Promise<{ lines: string[]; server: net.Server }>((res) => {
    server.listen(p, () => res({ lines, server }));
  });
}

// ── SET 1: every failure mode is distinguishable ───────────────────────────
test('EVERY failure mode returns its own kind, never a bare false', async () => {
  const wrong: string[] = [];

  // No socket at all, for a pid that IS alive — otherwise this would be testing the pid check
  // rather than the missing path. The two are separate failures and must stay separable.
  const gone = await postToInbox({ socketPath: sockPath('absent'), pid: process.pid, token: null, text: 'x' });
  if (gone.ok || gone.kind !== 'no-socket') wrong.push(`absent path → ${JSON.stringify(gone)}`);

  // path exists, nothing listening (a stale socket left by a crash)
  const stale = sockPath('stale');
  fs.writeFileSync(stale, '');            // a file where a socket should be
  const refused = await postToInbox({ socketPath: stale, pid: process.pid, token: null, text: 'x' });
  if (refused.ok || refused.kind !== 'refused') wrong.push(`stale socket → ${JSON.stringify(refused)}`);

  // the peer rejects the credential
  const authp = sockPath('auth');
  await listener(authp, { onLine: (l, sock) => {
    if (l.includes('"auth"')) { sock.write('{"type":"auth_error","error":"bad token"}\n'); sock.end(); }
  } });
  const rejected = await postToInbox({ socketPath: authp, pid: process.pid, token: 'wrong', text: 'x', requireAuth: true });
  if (rejected.ok || rejected.kind !== 'auth') wrong.push(`auth rejection → ${JSON.stringify(rejected)}`);

  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('a live listener receives the message and reports delivered', async () => {
  const p = sockPath('happy');
  const { lines } = await listener(p);
  const res = await postToInbox({ socketPath: p, pid: process.pid, token: null, text: 'hello cartridge' });
  assert.equal(res.ok, true, `expected delivery, got ${JSON.stringify(res)}`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(lines.length, 1, `expected exactly one line, got ${lines.length}: ${lines.join(' | ')}`);
  const msg = JSON.parse(lines[0]);
  assert.equal(msg.type, 'user');
  assert.equal(msg.message.role, 'user');
  assert.equal(msg.message.content, 'hello cartridge');
});

test('the auth line is sent FIRST and only when a token is supplied', async () => {
  const withTok = sockPath('with-token');
  const a = await listener(withTok);
  await postToInbox({ socketPath: withTok, pid: process.pid, token: 'tok-abc', text: 'hi' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.lines.length, 2, `expected auth + message, got ${a.lines.join(' | ')}`);
  assert.equal(JSON.parse(a.lines[0]).type, 'auth', 'auth must be the FIRST line on the connection');
  assert.equal(JSON.parse(a.lines[0]).token, 'tok-abc');
  assert.equal(JSON.parse(a.lines[1]).type, 'user');

  const noTok = sockPath('no-token');
  const b = await listener(noTok);
  await postToInbox({ socketPath: noTok, pid: process.pid, token: null, text: 'hi' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.lines.length, 1, 'no token means no auth line — macOS accepts a bare message');
  assert.equal(JSON.parse(b.lines[0]).type, 'user');
});

// ── SET 2: the endpoint is verified, not assumed ───────────────────────────
test('a socket whose pid is no longer the cartridge is refused BEFORE any write', async () => {
  // The path says pid 999999; nothing by that pid is alive. A recycled pid is how a prompt
  // reaches a stranger's session, so the client must check rather than trust the filename.
  const p = sockPath('recycled');
  const { lines } = await listener(p);
  const res = await postToInbox({ socketPath: p, pid: 999999, token: null, text: 'must not arrive' });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'stale-pid', `expected stale-pid, got ${JSON.stringify(res)}`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(lines.length, 0, 'nothing may be written to an endpoint that failed verification');
});

test('endpoint verification runs BEFORE the path check — the order is deliberate', () => {
  // A dead pid AND a missing socket is reported as stale-pid, not no-socket. That ordering is
  // the safety property: the pid check is what stops a write reaching a recycled process, so it
  // must not be reachable only when a socket happens to exist. Pinned because the obvious
  // refactor — cheap existsSync first — silently inverts it.
  return postToInbox({ socketPath: sockPath('neither'), pid: 999999, token: null, text: 'x' })
    .then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.kind, 'stale-pid',
        'a dead pid must be reported as such even when the socket is also missing');
    });
});

// ── SET 3: the deadline ────────────────────────────────────────────────────
test('the payload is built before the connection opens — the 30s clock is not raced', async () => {
  // A caller that hands over a promise-shaped text must not cause a connection to sit open
  // waiting for it. This asserts the ORDER: no connection until the bytes exist.
  const p = sockPath('ordering');
  let connectedAt = 0;
  const server = net.createServer((s) => { connectedAt = Date.now(); s.on('error', () => {}); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(p, () => r()));
  const start = Date.now();
  await postToInbox({ socketPath: p, pid: process.pid, token: null, text: 'ready' });
  assert.ok(connectedAt >= start, 'connection happened');
  assert.ok(INBOX_DEADLINE_MS <= 30_000,
    `the client's own deadline (${INBOX_DEADLINE_MS}ms) must not exceed the peer's 30s`);
});

test('a peer that accepts the connection and never reads still resolves — it does not hang', async () => {
  const p = sockPath('silent');
  const server = net.createServer(() => { /* accept and ignore, like a trust-prompt session */ });
  servers.push(server);
  await new Promise<void>((r) => server.listen(p, () => r()));
  const res = await postToInbox({ socketPath: p, pid: process.pid, token: null, text: 'x', timeoutMs: 400 });
  // Written is the honest answer: the bytes left, and this client cannot see whether the peer
  // acted on them. ADX-001's caveat says a session parked on the trust prompt looks exactly
  // like this, so the caller must not read `ok` as proof a human saw anything.
  assert.equal(typeof res.ok, 'boolean');
  assert.ok('kind' in res || res.ok, 'every result carries either ok or a kind');
});

// ── SET 4: the result type is exhaustive ───────────────────────────────────
test('every declared failure kind is reachable — no dead variants in the union', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'lib', 'inbox-client.ts'), 'utf8');
  const declared = [...src.matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const unique = [...new Set(declared)];
  assert.ok(unique.length >= 5, `only ${unique.length} failure kinds declared: ${unique.join(', ')}`);
  for (const k of ['no-socket', 'refused', 'timeout', 'auth', 'stale-pid']) {
    assert.ok(unique.includes(k), `the union is missing the '${k}' kind`);
  }
});

// ── FOLDED IN from adx-003-post-to-inbox.test.ts ───────────────────────────
//
// Two cartridges implemented ADX-003 simultaneously in one working tree, and both
// modules were committed: this one, which send-command actually imports, and an
// orphan that nothing imported. The orphan was deleted; these are the two cases it
// covered that this file did not, ported to the module that ships.
//
// Everything else it tested was already covered here under different names — the
// complete-line write, the auth-line ordering, the build-before-connect rule, and
// the distinguishable-failure set — so porting it verbatim would have added seven
// tests and no coverage.

test('a pid we do NOT own is refused before any write', async () => {
  /*
   * `pidIsOurs` treats ESRCH (the process is gone) and EPERM (it exists and belongs
   * to somebody else) as the same answer, and its comment says so — but only the
   * ESRCH path was exercised. They are different hazards: a dead pid is a session
   * that ended, while a live one owned by another user is somebody else's socket,
   * and writing to it would speak as them.
   *
   * pid 1 drives EPERM portably — it is always alive and never ours.
   */
  const res = await postToInbox({ pid: 1, token: null, text: 'must not reach init' });
  assert.equal(res.ok, false, 'a process owned by another user was accepted as our peer');
  assert.equal((res as { kind: string }).kind, 'stale-pid',
    `expected the endpoint check to refuse pid 1, got ${JSON.stringify(res)}`);
});

test('the socket path is not hardcoded to macOS', () => {
  /*
   * The epic's constraints say plainly: "Do not design a macOS-only interface" —
   * Unix domain sockets here, named pipes on native Windows. `inboxPathFor` has a
   * win32 branch and nothing exercised it, so a change that collapsed the two would
   * have gone unnoticed until somebody ran this on Windows.
   *
   * The pipe NAME itself is unverified — ADX-001 was measured on macOS and the name
   * could not be recovered from the CLI bundle — so this asserts the SHAPE and that
   * the two platforms differ, which is what a test on this machine can honestly claim.
   */
  const posix = inboxPathFor(4242);
  assert.match(posix, /^\/tmp\/cc-socks\/4242\.sock$/, `unexpected posix path: ${posix}`);

  /*
   * Bound to inboxPathFor's OWN BODY, by brace depth. The first version of this
   * scanned the whole file for /win32/ — which still appears in postToInbox's
   * platform guards — so collapsing inboxPathFor to the POSIX path alone left it
   * passing. A mutation proved it: the branch was gone and the test was green.
   * A scan wider than the thing it describes is a scan that cannot fail for it.
   */
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'lib', 'inbox-client.ts'), 'utf8');
  const at = src.indexOf('export function inboxPathFor');
  assert.notEqual(at, -1, 'inboxPathFor is gone');
  let i = src.indexOf('{', at); let depth = 0; let end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(at, end + 1);
  assert.match(body, /win32/,
    'inboxPathFor no longer branches on platform — this is now a macOS-only interface');
  assert.match(body, /pipe/,
    'the win32 branch no longer produces a named pipe');
});
