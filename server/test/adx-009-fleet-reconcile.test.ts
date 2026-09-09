/**
 * ADX-009 — THE DASHBOARD MUST NOT IMPLY IT SEES A FLEET IT ONLY PARTLY SEES.
 *
 * Two registries describe the same machine. NeonCore's `agents` table holds the cartridges it
 * launched and relays for. `claude agents --json` holds every Claude Code session running here,
 * including BACKGROUND sessions started outside NeonCore entirely — `claude --bg`, agent view,
 * `/bg` from inside a session.
 *
 * Measured while writing this: 12 sessions visible to the CLI, 9 non-offline rows in NeonCore.
 * The difference is not noise, it is work in flight that the dashboard silently omits. A person
 * reading "9 cartridges" reasonably concludes that is the whole machine. It is not, and nothing
 * on screen says so.
 *
 * ── WHY THIS IS RECONCILIATION AND NOT A SECOND AGENT LIST ────────────────────────────
 * The fix is deliberately NOT to import background sessions as cartridges. NeonCore cannot
 * dispatch to them, cannot recover them, and does not own their lifecycle — listing them as
 * cartridges would promise capabilities that do not exist. What it CAN honestly say is: "there
 * are N sessions on this machine I do not manage". That is a delta, and a delta is the whole
 * deliverable.
 *
 * ── MATCHED ON SESSION ID, AND THIS FILE ORIGINALLY GOT THAT WRONG ────────────────────
 * The first version of these tests asserted matching on WORKING DIRECTORY. The implementation
 * satisfied them and was then falsified by live data on the first run: 12 managed, 0 unmanaged,
 * on a machine that demonstrably has 3 background sessions NeonCore never launched. Those
 * sessions run inside repos that ALSO hold a cartridge, so a directory match absorbed precisely
 * the rows this exists to surface.
 *
 * `agents.session_id` and the CLI's `sessionId` are the same value for a managed cartridge, so
 * the join is exact — 12 sessions, 9 matched, 3 unmanaged, all background. The tests below were
 * rewritten to assert the correct rule rather than the one that happened to pass.
 *
 * ── THE CLI IS ALLOWED TO BE ABSENT ───────────────────────────────────────────────────
 * Not every deployment has the `claude` binary on PATH — a NeonCore server on a machine that only
 * relays, a container, CI. An unavailable CLI must degrade to "cannot tell" and never to "zero
 * unmanaged sessions", because a confident zero is exactly the false completeness this task
 * exists to remove.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { reconcileFleet, type CliSession } from '../src/lib/fleet-reconcile.ts';

installStubIO();

let n = 0;
function cartridge(repoPath: string, status = 'working'): string {
  const id = `ag-adx9-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,'claude',?,?,?,'')`,
  ).run(id, `Mannys-Mac-Pro.local/${repoPath.split('/').pop()}`, 'Mannys-Mac-Pro.local',
        repoPath, repoPath.split('/').pop(), status, new Date().toISOString(), `s-${id}`);
  return id;
}

const cli = (cwd: string, kind: 'interactive' | 'background', name = 'x', sessionId?: string): CliSession =>
  ({ id: `c-${++n}`, cwd, kind, name, state: 'working', sessionId: sessionId ?? `sess-${n}`, startedAt: Date.now() });

/** The session id NeonCore stored for a cartridge, so a test can present the matching CLI row. */
const sessionOf = (agentId: string) =>
  (db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agentId) as { session_id: string }).session_id;

// ── SET 1: the delta itself ────────────────────────────────────────────────
test('a session NeonCore has no row for is reported unmanaged', () => {
  const a = cartridge('/Users/x/code/neoncore');
  const r = reconcileFleet([
    cli('/Users/x/code/neoncore', 'interactive', 'x', sessionOf(a)),
    cli('/Users/x/code/film-engine', 'background'),
  ]);
  assert.equal(r.available, true);
  assert.equal(r.unmanaged.length, 1, `expected 1 unmanaged, got ${JSON.stringify(r.unmanaged)}`);
  assert.equal(r.unmanaged[0].cwd, '/Users/x/code/film-engine');
});

test('a BACKGROUND session inside a managed repo is still unmanaged — the bug live data caught', () => {
  // `claude --bg` started inside a repo NeonCore already relays. Same directory, different
  // session, and NeonCore can neither dispatch to it nor recover it. Directory matching called
  // this managed and reported 0 unmanaged on a machine that had 3.
  const a = cartridge('/Users/x/code/neoncore');
  const r = reconcileFleet([
    cli('/Users/x/code/neoncore', 'interactive', 'the cartridge', sessionOf(a)),
    cli('/Users/x/code/neoncore', 'background', 'someone else\'s --bg'),
  ]);
  assert.equal(r.unmanaged.length, 1, 'a background session sharing a repo with a cartridge is NOT that cartridge');
  assert.equal(r.unmanaged[0].kind, 'background');
});

test('a cartridge and its CLI session are matched on SESSION ID, not on name', () => {
  // Names never match by construction: `Mannys-Mac-Pro.local/gl-dev` versus `gl-dev-4f`.
  // The session id is the one value both sides genuinely share.
  const a = cartridge('/Users/x/code/gl-dev');
  const r = reconcileFleet([cli('/Users/x/code/gl-dev', 'interactive', 'gl-dev-4f', sessionOf(a))]);
  assert.deepEqual(r.unmanaged, [], 'a managed cartridge was reported as unmanaged');
  assert.equal(r.managed, 1);
});

test('the directory fallback normalises trailing slashes, for sessions carrying no id', () => {
  // Only reachable when a session has no sessionId — then the directory is all there is, and a
  // trailing slash must not split one directory into two.
  cartridge('/Users/x/code/baseback');
  const noId = { ...cli('/Users/x/code/baseback/', 'background'), sessionId: undefined };
  assert.deepEqual(reconcileFleet([noId]).unmanaged, [], 'a trailing slash split one directory into two');
});

test('an OFFLINE cartridge does not claim a live session', () => {
  // An offline row is a cartridge NeonCore is not currently running, so even its OWN session id
  // must not mark a live session managed — that would hide running work behind a stopped row.
  const a = cartridge('/Users/x/code/website', 'offline');
  const sid = (db.prepare('SELECT session_id FROM agents WHERE id = ?').get(a) as { session_id: string }).session_id;
  const r = reconcileFleet([cli('/Users/x/code/website', 'background', 'x', sid)]);
  assert.equal(r.unmanaged.length, 1, 'an offline row must not absorb a live session');
});

// ── SET 2: honest degradation ──────────────────────────────────────────────
test('an unavailable CLI reports "cannot tell", never a confident zero', () => {
  const r = reconcileFleet(null);
  assert.equal(r.available, false);
  assert.deepEqual(r.unmanaged, []);
  assert.match(r.detail, /unavailable|cannot/i,
    'the reason must be stated — a silent empty list reads as "nothing unmanaged"');
});

test('no sessions at all is a real zero, and is distinguishable from cannot-tell', () => {
  const r = reconcileFleet([]);
  assert.equal(r.available, true, 'an empty list is an ANSWER; absence of the CLI is not');
  assert.deepEqual(r.unmanaged, []);
});

// ── SET 3: the set is every session kind the CLI reports ───────────────────
test('EVERY session kind is classified — none silently dropped', () => {
  const a = cartridge('/Users/x/code/managed');
  const sessions = [
    cli('/Users/x/code/managed', 'interactive', 'x', sessionOf(a)),
    cli('/Users/x/code/loose-1', 'background'),
    cli('/Users/x/code/loose-2', 'interactive'),
  ];
  const r = reconcileFleet(sessions);
  assert.equal(r.managed + r.unmanaged.length, sessions.length,
    'a session was neither matched nor reported — reconciliation must account for all of them');
});

test('the unmanaged rows carry what a person needs to act', () => {
  const r = reconcileFleet([cli('/Users/x/code/orphan', 'background', 'flaky-test-fix')]);
  const row = r.unmanaged[0];
  for (const field of ['cwd', 'kind', 'name']) {
    assert.ok(field in row, `unmanaged row is missing '${field}' — not actionable without it`);
  }
  assert.equal(row.kind, 'background', 'the kind is how you know NeonCore never launched it');
});
