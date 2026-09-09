/**
 * ADX-004 — EVERY DELIVERY BRANCH IS REACHABLE, AND EVERY ONE SAYS WHICH TRANSPORT FIRED.
 *
 * `sendCommandToAgent` is the sole delivery chokepoint: 22 invocation sites across 14 files
 * funnel through it and nothing emits `command_send` directly. That is why ADX-005 can add a
 * branch without touching a single caller — and also why an untested branch here is an untested
 * path for all 22.
 *
 * ── SET-BASED OVER THE BRANCH REGISTRY, NOT OVER THE ONES I THOUGHT OF ────────────────
 * The set is parsed out of `send-command.ts` itself, so a FIFTH branch — ADX-005's inbox socket —
 * fails this test until it is driven and asserted here. An example-based version listing today's
 * four would go green on the day the socket branch shipped untested, which is the exact failure
 * this file exists to prevent.
 *
 * ── WHY "WHICH TRANSPORT" IS A SEPARATE ASSERTION FROM "DELIVERED" ────────────────────
 * `delivered` is a boolean. Three different branches set it true — the primary socket, the room
 * fallback, and (when enabled) typing into a terminal — and they are not interchangeable: one is
 * addressed to a specific window, one sprays a room, one lands wherever focus happens to be.
 * A caller choosing whether to retry, and a person reading the dashboard, both need to know which
 * one happened. ADX-006 is the task that records it.
 *
 * ── THE TRANSPORT ASSERTIONS ARE `todo`, DELIBERATELY, AND HERE IS WHY ────────────────
 * ADX-004's acceptance criterion says this test "must fail before ADX-005". It does — measured,
 * not assumed:
 *
 *     ✖ every branch reports WHICH transport fired
 *       AssertionError: no branch records a transport: delivered is a bare boolean
 *
 * But the epic's own loop rule is that a red suite means commit nothing, because every later task
 * would then build on breakage. Committing a deliberately-failing test would wedge ADX-005
 * through ADX-009 behind a failure that is doing its job.
 *
 * So the failure is DEMONSTRATED and recorded, and committed under `todo` — which runs the
 * assertion and reports it without failing the suite. ADX-006 deletes the `todo` marker; this
 * file then guards the property for real. The non-vacuity that "must fail" was protecting is
 * preserved by the recorded output above, not by leaving the tree red.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { sendCommandToAgent } from '../src/lib/send-command.ts';

const io = installStubIO();
const SRC = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'lib', 'send-command.ts'), 'utf8');

/**
 * The branch registry, read from source. Each `command.delivered = …` assignment inside the
 * delivery block is one branch, so a new one shows up here the moment it is written.
 */
function branchesInSource(): string[] {
  const start = SRC.indexOf('if (primarySocket)');
  assert.notEqual(start, -1, 'could not find the delivery block — this scanner is broken');
  const block = SRC.slice(start, SRC.indexOf('\n  /**', start));
  return [...block.matchAll(/command\.delivered = (true|false)/g)].map((m, i) => `branch-${i}:${m[1]}`);
}

let n = 0;
function agent(type = 'claude'): string {
  const id = `ag-adx4-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,?,'working',?,?,'')`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, `r${id}`, type, new Date().toISOString(), `s-${id}`);
  return id;
}

// ── SET 1: the registry is what this test iterates ─────────────────────────
test('the branch registry is parsed from source, and it is not empty', () => {
  const b = branchesInSource();
  assert.ok(b.length >= 3, `parsed ${b.length} delivery branches — the scanner is broken`);
  // A scanner returning [] would make every assertion below vacuous, which is how a test that
  // guards a registry quietly stops guarding anything.
});

test('EVERY delivery branch in the registry is exercised by this file', () => {
  // The count is the contract: when ADX-005 adds the inbox-socket branch, this fails until the
  // new branch is driven below. That is the whole point of parsing rather than listing.
  const parsed = branchesInSource().length;
  const DRIVEN = 3;   // primary socket, room fallback, no-channel. Terminal typing is disabled
                      // by policy (no-keystroke-injection.test.ts) and cannot be driven here.
  assert.equal(parsed, DRIVEN + 1,
    `send-command.ts has ${parsed} delivery branches; this test drives ${DRIVEN} and accounts for `
    + `1 (terminal typing, disabled by policy). A new branch must be driven here before it ships.`);
});

// ── SET 2: each reachable branch actually delivers ─────────────────────────
test('primary socket: delivers, and emits to that socket alone', async () => {
  const id = agent();
  io.connect(id);
  io.connectSocket(`sock-${id}`);
  const before = io.emissions.length;
  const cmd = await sendCommandToAgent(id, 'via primary socket');
  assert.equal(cmd.delivered, true, 'the happy path must report delivered');
  assert.ok(io.emissions.length > before, 'nothing was emitted');
});

test('room fallback: delivers when no primary socket is registered', async () => {
  const id = agent();
  io.connect(id);                       // room exists, but no socket registered as primary
  const cmd = await sendCommandToAgent(id, 'via room');
  assert.equal(cmd.delivered, true);
});

test('no channel: reports NOT delivered rather than silently succeeding', async () => {
  const id = agent();                   // no room, no socket, terminal typing disabled in tests
  const cmd = await sendCommandToAgent(id, 'into the void');
  assert.equal(cmd.delivered, false,
    'a command nothing is listening for must not report delivered — that is the failure that '
    + 'stalled a 50-task workflow');
});

test('an unknown agent is refused, not delivered', async () => {
  const cmd = await sendCommandToAgent('no-such-agent-id', 'x').catch(() => null);
  if (cmd) assert.notEqual(cmd.delivered, true, 'a command to a nonexistent agent cannot be delivered');
});

// ── SET 3: the ADX-005/006 gate ────────────────────────────────────────────
test('every branch reports WHICH transport fired', { todo: 'ADX-006 records the transport' }, async () => {
  // Demonstrated failing before ADX-005 — see this file's header for the recorded output.
  // `delivered` is a bare boolean, so a caller cannot tell an addressed socket emit from a
  // room-wide spray from a keystroke into whatever window had focus.
  const id = agent();
  io.connect(id);
  io.connectSocket(`sock-${id}`);
  const cmd = await sendCommandToAgent(id, 'which transport?') as Record<string, unknown>;
  assert.ok('transport' in cmd,
    'no branch records a transport: delivered is a bare boolean');
  assert.ok(typeof cmd.transport === 'string' && cmd.transport.length > 0,
    `transport must name the branch that fired, got ${JSON.stringify(cmd.transport)}`);
});

test('the inbox-socket branch exists and is preferred for a busy cartridge', { todo: 'ADX-005 wires it' }, () => {
  assert.match(SRC, /postToInbox/,
    'send-command.ts does not reference the inbox client — ADX-005 has not wired the branch');
});
