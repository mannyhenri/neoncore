/**
 * ADX-007 — `deliverNow`: reach a cartridge that is already working.
 *
 * The epic's original request. Today a prompt aimed at a busy cartridge is
 * QUEUED, which is correct as a default and is not always what the operator
 * wants: sometimes the thing you need to say is "stop what you are doing and
 * look at this", and the addressed inbox can deliver it BETWEEN tool calls
 * without interrupting the running tool.
 *
 * TWO SEPARATE BEHAVIOURS, and conflating them is the easy mistake:
 *   · SKIP THE QUEUE — a route-level decision, whether guardBusy is consulted.
 *   · PREFER THE SOCKET — a delivery-order decision inside sendCommandToAgent.
 * Skipping the queue without preferring the socket just lands a bracketed paste
 * on top of a running turn, which is the paste collision this epic exists to
 * remove. Preferring the socket without skipping the queue never runs at all,
 * because the dispatch is parked before delivery is reached. Both are asserted.
 *
 * WHY THE DEFAULT MUST BE PROVEN UNCHANGED, not merely left alone. guardBusy has
 * SEVEN call sites across six files and a long comment explaining that three
 * earlier implementations of one rule produced three different behaviours. An
 * option that quietly changed the default for prompts would be a fourth.
 *
 * OPEN QUESTION 4 IS ANSWERED HERE RATHER THAN ASSUMED. A socket message landing
 * mid-turn means the cartridge is working on two things — that is the point —
 * but `isCartridgeBusy` must NOT start reporting busy because of it, or ordinary
 * queued work would be held behind a message deliberately sent out of band.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { inboxPathFor } from '../src/lib/inbox-client.ts';
import { isCartridgeBusy } from '../src/lib/queue-runner.ts';
import commandsRouter from '../src/routes/commands.ts';

const io = installStubIO();
const ROOT = path.join(import.meta.dirname, '..', '..');
const SOCK = inboxPathFor(process.pid);
const servers: net.Server[] = [];

test.before(async () => {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch { /* not there */ }
  await new Promise<void>((res) => {
    const s = net.createServer((c) => { c.on('data', () => {}); c.on('error', () => {}); });
    servers.push(s); s.listen(SOCK, () => res());
  });
});
test.after(() => {
  for (const s of servers) { try { s.close(); } catch { /* */ } }
  try { fs.unlinkSync(SOCK); } catch { /* */ }
});

let n = 0;
function cartridge(o: { inbox?: boolean; busy?: boolean } = {}): string {
  const id = `ag-adx7-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,
                         session_id,pending_question,inbox_pid,inbox_token)
     VALUES (?,?,?,?,?,'claude',?,?,?,'',?,?)`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, `r${id}`, o.busy ? 'working' : 'idle',
        new Date().toISOString(), `s-${id}`, o.inbox ? process.pid : 0, o.inbox ? 'tok' : '');
  return id;
}
const transportOf = (c: unknown) => (c as Record<string, unknown> | null)?.transport;

/* ── The preference matrix ───────────────────────────────────────────────── */

const MATRIX: {
  label: string; deliverNow: boolean; inbox: boolean; relay: boolean; expect: string; why: string;
}[] = [
  {
    label: 'default with a relay connected', deliverNow: false, inbox: true, relay: true,
    expect: 'agent-room',
    why: 'the relay is the path a user watches in their terminal; the default must not move',
  },
  {
    label: 'deliverNow with a relay connected', deliverNow: true, inbox: true, relay: true,
    expect: 'inbox-socket',
    why: 'the whole point — a paste would land behind the running turn, the socket does not',
  },
  {
    label: 'deliverNow with NO inbox', deliverNow: true, inbox: false, relay: true,
    expect: 'agent-room',
    why: 'a preference is not a requirement; with no socket it must fall back, not fail',
  },
  {
    label: 'default with no relay', deliverNow: false, inbox: true, relay: false,
    expect: 'inbox-socket',
    why: 'ADX-005 behaviour, unchanged: the socket already rescues the dead end',
  },
  {
    label: 'deliverNow with nothing at all', deliverNow: true, inbox: false, relay: false,
    expect: 'no-channel',
    why: 'deliverNow cannot invent a channel, and must not claim one',
  },
];

for (const m of MATRIX) {
  test(`${m.label} → ${m.expect} — ${m.why}`, () => {
    const id = cartridge({ inbox: m.inbox });
    if (m.relay) io.connect(id);
    const c = sendCommandToAgent(id, 'x', false, undefined,
      m.deliverNow ? { deliverNow: true } : {});
    assert.equal(transportOf(c), m.expect,
      `expected ${m.expect}, got ${JSON.stringify(transportOf(c))}`);
  });
}

/* ── Skipping the queue, and NOT changing the default ────────────────────── */

let base = ''; let server: Server;
function boot(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/commands', commandsRouter);
  return new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r();
    });
  });
}
const send = (agentId: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/commands/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, text: 'x', ...body }),
  });

test('a BUSY cartridge still queues by default — the existing behaviour, unchanged', async () => {
  await boot();
  const id = cartridge({ inbox: true, busy: true });
  const res = await send(id, { queueIfBusy: true });
  assert.equal(res.status, 202, 'a busy cartridge no longer queues — the default moved');
  assert.equal((await res.json()).queued, true);
  server.close();
});

test('deliverNow skips the queue on a BUSY cartridge and delivers over the socket', async () => {
  await boot();
  const id = cartridge({ inbox: true, busy: true });
  /*
   * A RELAY IS CONNECTED, and that is load-bearing. Without it the ordinary
   * chain reaches the inbox anyway as its last resort (ADX-005), so asserting
   * `transport === 'inbox-socket'` could not tell "deliverNow preferred the
   * socket" from "the socket was the only road left" — a mutation removing
   * deliverNow from the delivery call survived exactly that gap. With a relay
   * present, the default answer is agent-room, so inbox-socket can only mean the
   * preference fired.
   */
  io.connect(id);
  const res = await send(id, { queueIfBusy: true, deliverNow: true });
  assert.equal(res.status, 201, `deliverNow was queued anyway (status ${res.status})`);
  const body = await res.json();
  assert.equal(body.queued, undefined, 'deliverNow produced a queue item');
  assert.equal(body.transport, 'inbox-socket',
    `deliverNow skipped the queue but did not prefer the socket (got ${body.transport})`);
  server.close();
});

test('deliverNow on a busy cartridge with NO inbox still refuses to interrupt by paste', async () => {
  /*
   * The dangerous half. Skipping the queue without a socket to deliver over
   * means a bracketed paste into a running turn — the collision this epic
   * exists to remove. With no inbox, deliverNow must not silently become
   * "interrupt anyway".
   */
  await boot();
  const id = cartridge({ inbox: false, busy: true });
  io.connect(id);
  const res = await send(id, { queueIfBusy: true, deliverNow: true });
  const body = await res.json();
  assert.notEqual(body.transport, 'inbox-socket', 'claimed a socket that does not exist');
  assert.equal(res.status, 202,
    'deliverNow with no addressed socket must fall back to queueing rather than pasting '
    + `into a running turn (status ${res.status}, transport ${body.transport})`);
  server.close();
});

/* ── guardBusy itself is untouched ───────────────────────────────────────── */

test('the bypass is a guardBusy OPTION, and it cannot drop work', () => {
  /*
   * My first version of this asserted guardBusy must know NOTHING about
   * deliverNow — that the caller should skip the guard entirely. That was my
   * design opinion dressed as a requirement, and the concurrently-written
   * implementation is better: guardBusy is the ONE place seven call sites share,
   * and its own header records that three earlier implementations of that rule
   * gave three different answers. A caller that skips the guard is a fourth.
   *
   * What actually matters is the invariant the task states — the default is
   * unchanged, and the bypass can never DROP work. So that is what is checked:
   * the option exists on the spec, and it only skips the queue when every busy
   * target can genuinely be reached mid-turn.
   */
  const src = fs.readFileSync(path.join(ROOT, 'server', 'src', 'lib', 'queue-if-busy.ts'), 'utf8');
  assert.match(src, /deliverNow\?:\s*boolean/, 'guardBusy has no deliverNow option');
  assert.match(src, /spec\.deliverNow && busy\.every\(/,
    'the bypass does not require EVERY busy target to be reachable — a dispatch that reached '
    + 'two cartridges and silently dropped the third would be worse than one that waited');
});

test('deliverNow on a cartridge whose SESSION HAS EXITED does not claim the inbox', () => {
  /*
   * MEASURED against the first implementation of this branch, which tested
   * `inbox_pid > 0`. That column is written once when the relay starts and is
   * never cleared when the session exits, so a stored pid proves a cartridge
   * ONCE had an inbox, not that it has one now. With a stale pid the branch
   * claimed 'inbox-socket', skipped a relay that WAS connected and could have
   * carried the message, and the dispatch was silently lost — the exact failure
   * this epic exists to remove, reintroduced by the option that was meant to help.
   */
  const id = cartridge();
  db.prepare('UPDATE agents SET inbox_pid = 999999, inbox_token = ? WHERE id = ?').run('tok', id);
  io.connect(id);
  const c = sendCommandToAgent(id, 'x', false, undefined, { deliverNow: true });
  assert.notEqual(transportOf(c), 'inbox-socket',
    'claimed an inbox for a pid with no socket, and bypassed the relay that could have carried it');
  assert.equal(transportOf(c), 'agent-room', 'it should fall back to the transport that works');
});

test('all seven guardBusy call sites are still there', () => {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  let sites = 0;
  for (const f of walk(path.join(ROOT, 'server', 'src'))) {
    if (f.endsWith('queue-if-busy.ts')) continue;
    sites += [...fs.readFileSync(f, 'utf8').matchAll(/guardBusy\(/g)].length;
  }
  assert.equal(sites, 7, `expected 7 guardBusy call sites, found ${sites}`);
});

/* ── Open question 4 ─────────────────────────────────────────────────────── */

test('an inbox delivery does NOT make the cartridge report busy', () => {
  /*
   * OPEN QUESTION 4, answered rather than assumed. A socket message landing
   * mid-turn does mean the cartridge is working on two things — that is the
   * point of the feature — but if `isCartridgeBusy` started reporting busy
   * because of it, ordinary QUEUED work would be held behind a message that was
   * deliberately sent out of band. The queue's notion of busy is about what the
   * cartridge was ASKED to do through the queue, not about every byte it receives.
   */
  const id = cartridge({ inbox: true });
  assert.equal(isCartridgeBusy(id), false, 'precondition: an idle cartridge is not busy');
  sendCommandToAgent(id, 'x', false, undefined, { deliverNow: true });
  assert.equal(isCartridgeBusy(id), false,
    'an out-of-band inbox delivery marked the cartridge busy — queued work would now be held '
    + 'behind a message that deliberately bypassed the queue');
});
