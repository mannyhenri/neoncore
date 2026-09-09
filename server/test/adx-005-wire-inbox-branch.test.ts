/**
 * ADX-005 — THE INBOX SOCKET BECOMES A DELIVERY BRANCH.
 *
 * This is the task the epic was built toward: a cartridge whose relay websocket is gone is no
 * longer a dead end. Today that case logs `NO COMMAND CHANNEL`, sets `delivered = false`, and
 * leaves the row pending — the failure that stalled a 50-task workflow. The inbox socket reaches
 * the same cartridge by a different road.
 *
 * ── WHERE THE BRANCH SITS, AND WHY THAT POSITION IS THE WHOLE DESIGN ──────────────────
 * `postToInbox` is ASYNC. `sendCommandToAgent` is SYNCHRONOUS and returns `Command | null`, and
 * the epic requires all 22 call sites to stay unchanged — so the signature cannot become a
 * promise. A fallback chain also cannot "fall through" asynchronously: by the time the socket
 * answers, the function has returned and the next branch is unreachable.
 *
 * Both problems dissolve if the branch is placed where the ALTERNATIVE IS THE DEAD END. Nothing
 * follows the no-channel case, so nothing needs to run after the socket answers:
 *
 *   success → the row becomes delivered. A dispatch that would have been lost is rescued.
 *   failure → the row stays pending and NO COMMAND CHANNEL is logged, which is exactly where
 *             today's code already ends up. Strictly no worse, often better.
 *
 * That is why this task does not change the signature, does not touch a caller, and does not
 * need the socket's answer before returning.
 *
 * ── `delivered` IS NOT SET OPTIMISTICALLY, AND THAT IS DELIBERATE ─────────────────────
 * ADX-001 measured that a session parked on the trust-this-folder prompt accepts the connection,
 * takes the write, and delivers nothing, with no error on either side. So a socket that swallowed
 * our bytes is not proof a human saw anything. The synchronous return keeps `delivered = false`
 * for this branch — the same value the dead end returns today — and the ROW carries the outcome
 * once it is actually known. Claiming delivery we cannot observe is the one thing this epic
 * exists to stop doing.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { inboxPathFor } from '../src/lib/inbox-client.ts';

const io = installStubIO();
const SRC = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'lib', 'send-command.ts'), 'utf8');

/**
 * The listener is bound at the path PRODUCTION derives — `inboxPathFor(pid)` — not at a temp
 * path of the test's choosing. Pointing it anywhere else would leave the path derivation itself
 * untested, which is the part that decides whether a real dispatch finds a real cartridge.
 *
 * `process.pid` is used because the client verifies the endpoint is a LIVE process owned by this
 * user before writing (ADX-003), so a made-up pid is refused before any socket is touched. The
 * test process is the only pid guaranteed to satisfy that, and its number cannot collide with a
 * running session's.
 */
const SOCK = inboxPathFor(process.pid);
const servers: net.Server[] = [];
let inboxLines: string[] = [];

test.before(async () => {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch { /* not there */ }
  inboxLines = await listener(SOCK);
});
test.after(() => {
  for (const s of servers) { try { s.close(); } catch { /* closed */ } }
  try { fs.unlinkSync(SOCK); } catch { /* already gone */ }
});

let n = 0;
/** A cartridge with an addressed inbox and NO relay socket — the case this branch exists for. */
function cartridgeWithInbox(pid: number): string {
  const id = `ag-adx5-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,
                         pending_question,inbox_pid,inbox_token)
     VALUES (?,?,?,?,?,'claude','working',?,?,'',?,?)`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, `r${id}`, new Date().toISOString(), `s-${id}`, pid, 'tok');
  return id;
}

function listener(p: string): Promise<string[]> {
  const lines: string[] = [];
  const server = net.createServer((sock) => {
    sock.on('data', (d) => { for (const l of d.toString('utf8').split('\n')) if (l) lines.push(l); });
    sock.on('error', () => {});
  });
  servers.push(server);
  return new Promise((res) => server.listen(p, () => res(lines)));
}

const rowOf = (id: string) => db.prepare('SELECT status, delivered_at FROM commands WHERE id = ?')
  .get(id) as { status: string; delivered_at: string | null };

// ── SET 1: the branch exists and is wired ──────────────────────────────────
test('send-command references the inbox client — the branch is wired, not planned', () => {
  assert.match(SRC, /postToInbox/, 'ADX-005 has not wired the inbox client into the delivery chain');
});

test('the branch sits AHEAD of the no-channel dead end', () => {
  const inbox = SRC.indexOf('postToInbox');
  const deadEnd = SRC.indexOf('NO COMMAND CHANNEL');
  assert.ok(inbox !== -1 && deadEnd !== -1, 'could not locate both branches');
  assert.ok(inbox < deadEnd,
    'the socket must be tried BEFORE giving up — placed after, it can never run');
});

test('the signature stays synchronous — 22 call sites must not have to change', () => {
  const sig = SRC.slice(SRC.indexOf('export function sendCommandToAgent'), SRC.indexOf('{', SRC.indexOf('export function sendCommandToAgent')) + 1);
  assert.ok(!/async/.test(sig), `sendCommandToAgent became async: ${sig.slice(0, 120)}`);
  assert.match(SRC, /\): Command \| null \{/, 'the return type changed — every caller is affected');
});

// ── SET 2: behaviour, driven against a real socket ─────────────────────────
test('a cartridge with an inbox and no relay socket is REACHED, not written off', async () => {
  const before = inboxLines.length;
  const id = cartridgeWithInbox(process.pid);
  const cmd = sendCommandToAgent(id, 'reach me over the socket');
  assert.ok(cmd, 'a command row must still be created');
  await new Promise((r) => setTimeout(r, 300));  // the post is async by necessity

  assert.ok(inboxLines.length > before, 'nothing arrived on the inbox socket — the branch did not fire');
  const msg = JSON.parse(inboxLines[inboxLines.length - 1]);
  assert.equal(msg.type, 'user');
  assert.match(String(msg.message.content), /reach me over the socket/);
});

test('a successful post marks the ROW delivered, since the return could not know yet', async () => {
  const id = cartridgeWithInbox(process.pid);
  const cmd = sendCommandToAgent(id, 'row should settle');
  assert.ok(cmd);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rowOf(cmd!.id).status, 'delivered', 'the row must record what the return could not');
  assert.ok(rowOf(cmd!.id).delivered_at, 'delivered_at must be stamped');
});

test('a DEAD inbox does not falsely mark the row delivered', async () => {
  const id = cartridgeWithInbox(999999);         // a pid that is not a live process
  const cmd = sendCommandToAgent(id, 'nobody home');
  assert.ok(cmd);
  await new Promise((r) => setTimeout(r, 250));
  assert.notEqual(rowOf(cmd!.id).status, 'delivered',
    'a failed post must never look like a delivery — that is the bug this epic removes');
});

test('a cartridge with NO inbox at all still reports the honest dead end', () => {
  const id = `ag-adx5-noinbox-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,'claude','working',?,?,'')`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, `r${id}`, new Date().toISOString(), `s-${id}`);
  const cmd = sendCommandToAgent(id, 'no channel anywhere');
  assert.equal(cmd?.delivered, false, 'with no relay and no inbox there is genuinely nothing');
});

test('the relay socket still WINS when both are available', async () => {
  // The relay is the established, observable path. The inbox is the rescue, not a replacement,
  // and quietly preferring it would change delivery semantics for every healthy cartridge.
  const before = inboxLines.length;
  const id = cartridgeWithInbox(process.pid);
  io.connect(id);
  io.connectSocket(`sock-${id}`);
  const cmd = sendCommandToAgent(id, 'prefer the relay');
  assert.equal(cmd?.delivered, true, 'the relay path must still report delivered');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(inboxLines.length, before, 'the inbox must not also receive it — that is a double send');
});
