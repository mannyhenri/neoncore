/**
 * ADX-002 — THE RELAY REPORTS ITS PTY CHILD'S PID AND MESSAGING TOKEN.
 *
 * WHAT ADX-001 CHANGED ABOUT THIS TASK, and why the obvious implementation is
 * the wrong one. The epic (and this task's own description) says the relay
 * "reads CLAUDE_CODE_MESSAGING_TOKEN from its PTY child's environment". That
 * is the one approach the spike PROVED IMPOSSIBLE: `ps eww` exposes a same-uid
 * process's environment on macOS, so it looks viable, but what it shows is the
 * EXEC-TIME environment and claude generates the token after exec. Measured on
 * a live relay-owned session: 47 vars visible, MESSAGING_TOKEN absent, while a
 * CHILD of claude sees 60 including it. The direction is the trap.
 *
 * So the relay MINTS the token and INJECTS it into the environment it already
 * controls at pty.spawn. It then knows the value by construction rather than by
 * discovery. `injectsTheToken` below is what stops a later refactor quietly
 * going back to reading it.
 *
 * WHY THE PID CANNOT BE PART OF THE FIRST REGISTRATION. `registerAgent()` runs
 * BEFORE `pty.spawn()` — deliberately, so the agent row and id exist before the
 * relay joins its socket room. There is no child, and therefore no pid, at that
 * moment. A test that only asserts "the payload contains a pid" would pass
 * against a relay reporting `undefined`, so the ordering is asserted directly.
 *
 * WHY THE NON-LEAK CHECK IS SET-BASED OVER SERIALIZERS DISCOVERED IN SOURCE.
 * There are TWO copies of `normalizeAgent` — routes/agents.ts and routes/trust.ts
 * — byte-identical today and maintained by hand. Dropping the token from one and
 * not the other leaks it through the other, and nothing would say so. The set is
 * therefore discovered by scanning, never listed here, so a third copy is covered
 * the day it appears.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import agentsRouter from '../src/routes/agents.ts';

installStubIO();

const ROOT = path.join(import.meta.dirname, '..', '..');
const RELAY = path.join(ROOT, 'agent', 'relay', 'index.js');
const relaySrc = () => fs.readFileSync(RELAY, 'utf8');

let base = '';
let server: Server;

function boot(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

let n = 0;
/** Register through the real route, exactly as the relay does. */
async function register(extra: Record<string, unknown> = {}, repo = '') {
  const repoPath = repo || `/tmp/adx002-${++n}`;
  const res = await fetch(`${base}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `m/${path.basename(repoPath)}`, machine: 'm', repoPath,
      repoName: path.basename(repoPath), branch: 'main',
      sessionId: `relay-${1000 + n}`, agentType: 'claude', status: 'idle',
      ...extra,
    }),
  });
  return { res, body: await res.json(), repoPath };
}
const rowFor = (repoPath: string) =>
  db.prepare('SELECT * FROM agents WHERE repo_path = ?').get(repoPath) as Record<string, unknown>;

/* ── 1. The row can hold them ────────────────────────────────────────────── */

test('the agents table has somewhere to put the inbox pid and token', () => {
  const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('inbox_pid'), 'agents.inbox_pid is missing');
  assert.ok(cols.includes('inbox_token'), 'agents.inbox_token is missing');
});

/* ── 2. Registration persists them ───────────────────────────────────────── */

test('registration persists the inbox pid and token on the agent row', async () => {
  await boot();
  const { repoPath } = await register({ inboxPid: 4242, inboxToken: 'tok-abcdefghijklmnop' });
  const row = rowFor(repoPath);
  assert.equal(Number(row.inbox_pid), 4242);
  assert.equal(row.inbox_token, 'tok-abcdefghijklmnop');
  server.close();
});

test('a later registration WITHOUT inbox fields does not wipe them', async () => {
  await boot();
  const { repoPath } = await register({ inboxPid: 777, inboxToken: 'tok-qrstuvwxyz012345' });
  /*
   * Every hook fires register(). Those payloads carry no pid and no token, and
   * they outnumber the relay's single report enormously — so a naive
   * `inbox_pid = ?` would blank the inbox milliseconds after the relay set it,
   * and delivery would fail for a reason nothing reports.
   */
  await register({}, repoPath);
  const row = rowFor(repoPath);
  assert.equal(Number(row.inbox_pid), 777, 'a hook re-registration blanked the inbox pid');
  assert.equal(row.inbox_token, 'tok-qrstuvwxyz012345', 'a hook re-registration blanked the inbox token');
  server.close();
});

test('a replaced PTY child overwrites the previous pid and token', async () => {
  await boot();
  const { repoPath } = await register({ inboxPid: 111, inboxToken: 'tok-first-aaaaaaaaaa' });
  await register({ inboxPid: 222, inboxToken: 'tok-second-bbbbbbbbb' }, repoPath);
  const row = rowFor(repoPath);
  assert.equal(Number(row.inbox_pid), 222, 'a new child did not refresh the pid');
  assert.equal(row.inbox_token, 'tok-second-bbbbbbbbb', 'a new child did not refresh the token');
  server.close();
});

test('a nonsense pid is refused rather than stored as garbage', async () => {
  await boot();
  /*
   * The pid names a socket path. A stored 0, a negative or a non-number turns
   * into /tmp/cc-socks/0.sock, which either does not exist or — worse — could be
   * some other process. Refusing at the write is the cheap place; discovering it
   * at delivery time is the expensive one.
   */
  for (const bad of [0, -1, 'nope', 1.5, null]) {
    const { repoPath } = await register({ inboxPid: bad, inboxToken: 'tok-ccccccccccccccc' });
    const row = rowFor(repoPath);
    assert.equal(Number(row.inbox_pid), 0, `pid ${JSON.stringify(bad)} was stored rather than refused`);
  }
  server.close();
});

/* ── 3. It never leaves ──────────────────────────────────────────────────── */

/** Every hand-maintained agent serializer in the tree, discovered rather than listed. */
function serializers(): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const src = fs.readFileSync(p, 'utf8');
        const at = src.indexOf('function normalizeAgent');
        if (at === -1) continue;
        /* Bound by brace depth from the declaration — a fixed character window
         * silently stops matching the day the function grows, and then blames
         * the code it can no longer see. */
        let i = src.indexOf('{', at), depth = 0, end = i;
        for (; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        out.push({ file: path.relative(ROOT, p), body: src.slice(at, end + 1) });
      }
    }
  };
  walk(path.join(ROOT, 'server', 'src'));
  return out;
}

test('every agent serializer keeps the token out of what a client receives', () => {
  const found = serializers();
  assert.ok(found.length >= 2,
    `expected at least the two known normalizeAgent copies, found ${found.length} — the scan is broken`);
  const leaking = found.filter((s) => /inbox_?[Tt]oken/.test(s.body)).map((s) => s.file);
  assert.deepEqual(leaking, [], `these serializers carry the messaging token to clients: ${leaking.join(', ')}`);
});

test('the API response for a registered agent contains no token', async () => {
  await boot();
  const { body } = await register({ inboxPid: 9090, inboxToken: 'tok-must-not-appear-1' });
  assert.ok(!JSON.stringify(body).includes('tok-must-not-appear-1'),
    'the register response echoed the messaging token back to the client');
  const list = await (await fetch(`${base}/api/agents`)).json();
  assert.ok(!JSON.stringify(list).includes('tok-must-not-appear-1'),
    'the agent list served the messaging token to the dashboard');
  server.close();
});

/* ── 4. The relay side ───────────────────────────────────────────────────── */

test('the relay MINTS and INJECTS the token — it does not read it from the child', () => {
  const src = relaySrc();
  assert.match(src, /randomBytes\(/,
    'the relay does not mint a token; ADX-001 proved it cannot read one out of its child');
  assert.match(src, /CLAUDE_CODE_MESSAGING_TOKEN\s*:/,
    'the relay does not inject CLAUDE_CODE_MESSAGING_TOKEN into the env it spawns with');
  /* The spawn env must no longer be a bare pass-through, or the injection is not reaching it. */
  const spawnAt = src.indexOf('pty.spawn(');
  assert.ok(spawnAt !== -1, 'the relay no longer spawns a PTY');
  const spawnCall = src.slice(spawnAt, src.indexOf('});', spawnAt));
  assert.ok(!/env:\s*process\.env\s*,/.test(spawnCall),
    'pty.spawn still passes env: process.env unchanged — the token is not being injected');
});

test('the relay reports the pid AFTER the child exists, not in the first registration', () => {
  const src = relaySrc();
  /*
   * Bound to the CALL, never to the first mention of `inboxPid`. The reporting
   * function is declared up with the other server calls, above pty.spawn — a
   * scan for the identifier finds that declaration and concludes the relay
   * reports too early, which is a statement about where the code was typed
   * rather than about when it runs.
   */
  const spawn = src.indexOf('pty.spawn(');
  const call = src.search(/^\s*reportInbox\(/m);
  assert.ok(spawn !== -1 && call !== -1,
    'could not locate pty.spawn and the reportInbox call site in the relay');
  assert.ok(spawn < call,
    'reportInbox is called before pty.spawn — there is no child yet, so the pid can only be undefined');

  /* And the first registration must not carry one, for the same reason. */
  const at = src.indexOf('async function registerAgent(');
  assert.ok(at !== -1, 'registerAgent is gone');
  let i = src.indexOf('{', at), depth = 0, end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(!/inboxPid/.test(src.slice(at, end + 1)),
    'the first registration payload carries an inboxPid, and it runs before the child exists');
});

test('the relay never writes the token to its log', () => {
  const src = relaySrc();
  /*
   * The log file is plain text on disk and is quoted into bug reports. A token
   * that reaches it is a token that outlives the session that owned it.
   */
  const logCalls = [...src.matchAll(/\blog\(([^\n]*)\)/g)].map((m) => m[1]);
  const leaking = logCalls.filter((c) => /token/i.test(c) && !/no token|redact|token\.length|hasToken/i.test(c));
  assert.deepEqual(leaking, [], `these relay log lines carry the token: ${leaking.join(' | ')}`);
});

test('the pid cannot go stale inside one relay: the relay dies with its child', () => {
  const src = relaySrc();
  /*
   * "Values refresh when the PTY child is replaced" is satisfied TODAY by
   * construction rather than by a watcher: onExit tears the relay down, so a new
   * child means a new relay and a fresh registration. That is only true while
   * onExit still exits. If someone later makes the relay respawn its child in
   * place, this fails and forces them to re-report the pid — which is exactly
   * the epic's open question 2.
   */
  const at = src.indexOf('ptyProc.onExit(');
  assert.ok(at !== -1, 'the relay no longer handles child exit');
  const body = src.slice(at, src.indexOf('});', at));
  assert.match(body, /process\.exit\(/,
    'the relay no longer exits with its child, so a replaced child would leave a stale inbox pid');
});
