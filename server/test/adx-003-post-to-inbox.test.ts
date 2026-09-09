/**
 * ADX-003 — postToInbox(pid, token, text): the client that writes one message
 * into a cartridge's addressed inbox socket.
 *
 * WHY EVERY FAILURE IS A NAMED KIND RATHER THAN A THROWN ERROR. ADX-005 wires
 * this in as a delivery BRANCH, and a branch has to decide what to do next: a
 * missing socket means fall through to the relay websocket, a timeout means the
 * cartridge is wedged and the command row should stay pending, a wrong endpoint
 * means the pid is stale and the agent row needs re-registering. `catch (e)`
 * with a string message cannot make those decisions, and the branch that has to
 * make them is the one that spends a user's dispatch.
 *
 * THE FAILURE THIS MODULE MUST NOT PRETEND AWAY. ADX-001 measured a session
 * parked on the trust-this-folder prompt: it ACCEPTS the connection, ACCEPTS the
 * bytes, and delivers nothing — silently, on both sides. So a clean write is not
 * evidence of delivery, and the success shape says `handedOver`, never
 * `delivered`. That naming is asserted below, because the whole point is that
 * ADX-005 must not read a silent socket as proof.
 *
 * WHY THE TESTS USE FAKE SERVERS. The acceptance criterion asks for coverage of
 * each failure mode "without touching a live cartridge" — and posting to a real
 * one would inject a message into somebody's running session. Every case here is
 * a net.Server on a temp path behaving badly on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  postToInbox, inboxSocketPath, ownershipProblem, type InboxFailure,
} from '../src/lib/post-to-inbox.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adx003-'));
let n = 0;
const nextPath = () => path.join(tmp, `s${++n}.sock`);

/** A server that behaves badly on purpose. `onConn` decides how. */
function fakeInbox(onConn: (c: net.Socket) => void): Promise<{ p: string; close: () => void }> {
  const p = nextPath();
  return new Promise((resolve) => {
    const srv = net.createServer(onConn);
    srv.listen(p, () => resolve({ p, close: () => { try { srv.close(); } catch { /* */ } } }));
  });
}

/** Collect a complete line, then hand it back. */
function collector(): { lines: string[]; onConn: (c: net.Socket) => void } {
  const lines: string[] = [];
  return {
    lines,
    onConn: (c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      c.on('error', () => { /* the client may hang up first */ });
    },
  };
}

/* ── The happy path, and what "ok" is allowed to claim ───────────────────── */

test('a message is handed over as one complete line, auth first when a token is given', async () => {
  const c = collector();
  const { p, close } = await fakeInbox(c.onConn);
  const r = await postToInbox({ pid: 1, token: 'tok-abc', text: 'hello there', socketPath: p });
  close();
  assert.equal(r.ok, true, `expected a clean hand-over, got ${JSON.stringify(r)}`);

  assert.equal(c.lines.length, 2, `expected an auth line and a message line, got ${c.lines.length}`);
  assert.deepEqual(JSON.parse(c.lines[0]), { type: 'auth', token: 'tok-abc' });
  const msg = JSON.parse(c.lines[1]);
  assert.equal(msg.type, 'user');
  assert.equal(msg.message.role, 'user');
  assert.equal(msg.message.content, 'hello there');
});

test('no token means no auth line — the message still stands alone', async () => {
  const c = collector();
  const { p, close } = await fakeInbox(c.onConn);
  const r = await postToInbox({ pid: 1, text: 'no auth here', socketPath: p });
  close();
  assert.equal(r.ok, true);
  assert.equal(c.lines.length, 1, 'an auth line was sent for a call that supplied no token');
  assert.equal(JSON.parse(c.lines[0]).type, 'user');
});

test('success says handedOver, never delivered', async () => {
  const c = collector();
  const { p, close } = await fakeInbox(c.onConn);
  const r = await postToInbox({ pid: 1, text: 'x', socketPath: p });
  close();
  /*
   * ADX-001 measured a session that accepts the bytes and does nothing with
   * them. Calling this field `delivered` would licence ADX-005 to mark a command
   * row delivered on the strength of a socket that swallowed it.
   */
  assert.ok('handedOver' in r, 'the success shape must say handedOver');
  assert.ok(!('delivered' in r), 'the success shape must NOT claim delivery — the socket cannot prove it');
});

/* ── The 30s deadline: connect only once the message is ready ────────────── */

test('the connection is opened only when the message is ready to write', async () => {
  /*
   * Claude Code closes a connection that has not sent a COMPLETE LINE within 30
   * seconds, and that clock starts at connect. An implementation that connects
   * and then goes off to build its payload spends the caller's budget on its own
   * bookkeeping. Measured rather than asserted structurally: the gap between the
   * server seeing a connection and seeing the terminating newline.
   */
  let connectedAt = 0; let completedAt = 0;
  const { p, close } = await fakeInbox((c) => {
    connectedAt = Date.now();
    c.on('data', (d) => { if (d.toString().includes('\n')) completedAt ||= Date.now(); });
    c.on('error', () => { /* */ });
  });
  await postToInbox({ pid: 1, token: 't', text: 'y'.repeat(50_000), socketPath: p });
  close();
  assert.ok(completedAt > 0, 'the server never saw a complete line');
  assert.ok(completedAt - connectedAt < 250,
    `${completedAt - connectedAt}ms passed between connect and the complete line — `
    + 'the payload is being built after connecting, which spends the deadline');
});

/* ── Failure modes, as a registry ────────────────────────────────────────── */

const FAILURES: {
  kind: InboxFailure;
  why: string;
  run: () => Promise<{ ok: boolean; failure?: InboxFailure }>;
}[] = [
  {
    kind: 'bad-pid',
    why: 'a pid names a path, so 0 or a fraction builds a path that is not a cartridge',
    run: () => postToInbox({ pid: 0, text: 'x' }),
  },
  {
    kind: 'no-socket',
    why: 'the session is gone; the branch should fall through to another transport',
    run: () => postToInbox({ pid: 1, text: 'x', socketPath: path.join(tmp, 'absent.sock') }),
  },
  {
    kind: 'refused',
    why: 'a stale socket FILE with nothing listening — the session died without cleaning up',
    run: async () => {
      /*
       * Node UNLINKS the socket file on srv.close(), so closing a server in this
       * process leaves no stale path and produces `no-socket` instead — a fixture
       * that tests the wrong thing. A real stale socket comes from a process that
       * DIED without cleaning up, so this kills one.
       */
      const sp = nextPath();
      const child = spawn(process.execPath, ['-e',
        `require('net').createServer(()=>{}).listen(${JSON.stringify(sp)},()=>console.log('up'))`]);
      await new Promise<void>((r) => child.stdout.on('data', () => r()));
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(fs.existsSync(sp), 'the fixture failed: no stale socket file was left behind');
      return postToInbox({ pid: 1, text: 'x', socketPath: sp });
    },
  },
  {
    kind: 'timeout',
    why: 'connected and wedged — the cartridge is alive but not reading',
    run: async () => {
      const { p, close } = await fakeInbox((c) => { c.pause(); });
      const r = await postToInbox({ pid: 1, text: 'x'.repeat(4_000_000), socketPath: p, timeoutMs: 300 });
      close();
      return r;
    },
  },
  {
    kind: 'auth-rejected',
    why: 'the peer hung up after the auth line — the Windows named-pipe path',
    run: async () => {
      const { p, close } = await fakeInbox((c) => { c.destroy(); });
      const r = await postToInbox({ pid: 1, token: 'wrong', text: 'x'.repeat(2_000_000), socketPath: p });
      close();
      return r;
    },
  },
  {
    kind: 'write-failed',
    why: 'the peer hung up mid-write and we sent NO auth line, so it cannot be an auth refusal',
    run: async () => {
      const { p, close } = await fakeInbox((c) => { c.destroy(); });
      const r = await postToInbox({ pid: 1, text: 'x'.repeat(2_000_000), socketPath: p });
      close();
      return r;
    },
  },
];

for (const f of FAILURES) {
  test(`${f.kind}: ${f.why}`, async () => {
    const r = await f.run();
    assert.equal(r.ok, false, `expected a failure, got ${JSON.stringify(r)}`);
    assert.equal(r.failure, f.kind, `expected ${f.kind}, got ${r.failure}`);
  });
}

test('every failure kind is distinguishable — no two cases collapse to one label', async () => {
  /*
   * The point of typing these is that ADX-005 branches on them. Two conditions
   * reporting the same kind would make one of those branches unreachable, which
   * is worse than an untyped error because it looks handled.
   */
  const seen = new Map<string, string>();
  for (const f of FAILURES) {
    const r = await f.run();
    const prev = seen.get(r.failure as string);
    assert.equal(prev, undefined,
      `${f.kind} and ${prev} both report "${r.failure}" — the branch cannot tell them apart`);
    seen.set(r.failure as string, f.kind);
  }
  assert.equal(seen.size, FAILURES.length);
});

/* ── Ownership, and not being macOS-only ─────────────────────────────────── */

test('a socket owned by another user is refused rather than written to', () => {
  /*
   * Tested as a pure function against synthetic stats: simulating a second uid
   * needs a second user, and skipping the case because the fixture is awkward is
   * how a security check ships unexercised. Writing to a socket we do not own is
   * speaking as somebody else's session.
   */
  assert.equal(ownershipProblem({ uid: 501 }, 501), null, 'our own socket was refused');
  assert.equal(ownershipProblem({ uid: 0 }, 501), 'not-owned', 'a root-owned socket was accepted');
  assert.equal(ownershipProblem({ uid: 502 }, 501), 'not-owned', "another user's socket was accepted");
  assert.equal(ownershipProblem({ uid: 501 }, undefined), null,
    'a platform with no uid (Windows) must not be blocked by a POSIX-only check');
});

test('the socket path is not hardcoded to macOS', () => {
  const posix = inboxSocketPath(4242, 'darwin');
  assert.equal(posix, '/tmp/cc-socks/4242.sock');
  assert.equal(inboxSocketPath(4242, 'linux'), '/tmp/cc-socks/4242.sock');
  const win = inboxSocketPath(4242, 'win32');
  assert.ok(win.startsWith('\\\\'), `win32 must use a named pipe, got ${win}`);
  assert.ok(win.includes('4242'), 'the win32 pipe name must still identify the session');
  assert.notEqual(win, posix, 'win32 resolves to the POSIX path — this is a macOS-only interface');
});
