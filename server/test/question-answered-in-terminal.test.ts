/**
 * A QUESTION ANSWERED IN THE TERMINAL MUST CLOSE IN THE APP.
 *
 * THE BUG. An agent asks something, NeonCore opens a `permissions` row and the approvals
 * inbox lights up on the dashboard and the phone. The human is sitting at the terminal, so
 * they answer it THERE. Nothing ever told the server, so the row sat `pending` until a
 * 15-minute TTL swept it to `expired` — a quarter of an hour during which the app shows a
 * question that has already been answered, the cartridge wears a stale ❓ banner, and the
 * queue counts it as busy because `waiting` means busy (lib/queue-runner.ts).
 *
 * WHY THE SIGNAL IS `statusFromActivity`, NOT A NEW LIST. lib/activity-status.ts already
 * owns the registry of what an event says about a cartridge: WORKING_EVENTS is "unambiguous
 * evidence the cartridge is executing", ASKING_EVENTS and the blocked notification patterns
 * are "blocked on a human". A cartridge that is executing is not waiting on an answer, so
 * the rule is one line of meaning: `statusFromActivity(...) === 'working'` closes the
 * question. A second hand-maintained list of event names would drift from that one exactly
 * the way KNOWN_ENGINES drifted from AgentType and the escalation ladder drifted from
 * rollup() — so this test iterates the REGISTRY, and a new working event is covered the day
 * it is added.
 *
 * WHY BOTH NEGATIVE SETS MATTER. `ask_user` IS the question — closing on it would mean the
 * second of two Codex async forms wipes out the first. And Claude Code's `notification`
 * hook fires for both "Claude is waiting for your input" and for the fleet's own status
 * reports; only the payload separates them. Both are asserted, because either one closing a
 * live question loses a human's answer.
 *
 * WHY THE "STILL BLOCKED" GUARD IS TESTED SEPARATELY. The failure mode that would make this
 * feature worse than the bug is closing a question the agent is genuinely still waiting on:
 * the hook keeps long-polling, gets nothing, and the human's answer goes nowhere. Two
 * independent guards are asserted — the created_at ordering the hooks already produce, and
 * a live entry in pendingPolls.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import activityRouter from '../src/routes/activity.ts';
import agentsRouter from '../src/routes/agents.ts';
import permissionsRouter, {
  closeQuestionsAnsweredElsewhere,
  __pendingPollsForTests,
} from '../src/routes/permissions.ts';
import { WORKING_EVENTS, ASKING_EVENTS, BLOCKED_PATTERNS, statusFromActivity } from '../src/lib/activity-status.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();

const SESSION = 'terminal-answer-session';
const REPO = '/tmp/terminal-answer-repo';
let base = '';
let server: Server;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', activityRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/permissions', permissionsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

test.after(() => server?.close());

let n = 0;

/** A registered cartridge with an open question, exactly as the hooks leave it. */
function cartridgeWithOpenQuestion(): { agentId: string; permissionId: string } {
  const agentId = `ta-agent-${++n}`;
  const permissionId = `ta-perm-${n}`;
  const past = new Date(Date.now() - 60_000).toISOString();
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,'test',?,'repo','claude','waiting',?,?,?)`,
  ).run(agentId, agentId, `${REPO}-${n}`, past, `${SESSION}-${n}`, '{"questions":[{"question":"Which model?"}]}');
  db.prepare(
    `INSERT INTO permissions (id, agent_id, tool_name, tool_input, description, status, created_at)
     VALUES (?, ?, 'AskUserQuestion', '{"questions":[{"question":"Which model?"}]}', 'Which model?', 'pending', ?)`,
  ).run(permissionId, agentId, past);
  io.connect(agentId);
  return { agentId, permissionId };
}

const statusOf = (id: string) =>
  (db.prepare('SELECT status FROM permissions WHERE id = ?').get(id) as { status: string }).status;
const bannerOf = (id: string) =>
  (db.prepare('SELECT pending_question FROM agents WHERE id = ?').get(id) as { pending_question: string }).pending_question;

async function postActivity(agentId: string, eventType: string, toolInput: unknown = {}) {
  const res = await fetch(`${base}/api/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, eventType, toolName: 'Bash', toolInput }),
  });
  assert.equal(res.status, 201, `activity ${eventType} was not accepted`);
}

// ── The set: every event that means "this cartridge is executing" ──────────────────────

test('EVERY working event closes a question the terminal already answered', async () => {
  const events = [...WORKING_EVENTS];
  assert.ok(events.length > 0, 'WORKING_EVENTS is empty — the registry moved');

  for (const eventType of events) {
    const { agentId, permissionId } = cartridgeWithOpenQuestion();
    assert.equal(statusFromActivity(eventType, '{}'), 'working',
      `${eventType} is in WORKING_EVENTS but does not imply working`);

    await postActivity(agentId, eventType);

    assert.equal(statusOf(permissionId), 'answered_elsewhere',
      `"${eventType}" left the question open in the app`);
    assert.equal(bannerOf(agentId), '',
      `"${eventType}" left a stale question banner on the cartridge`);
  }
  console.log(`[set] ${events.length}/${events.length} working events close an open question`);
});

test('NO event that means "blocked on a human" closes a question', async () => {
  const cases: { eventType: string; toolInput: unknown; why: string }[] = [
    ...[...ASKING_EVENTS].map((eventType) => ({
      eventType, toolInput: {}, why: 'this event IS the question',
    })),
    ...BLOCKED_PATTERNS.map((p, i) => ({
      eventType: 'notification',
      toolInput: ['Claude is waiting for your input', 'Claude needs your permission',
                  'waiting for your input', 'needs your permission'][i],
      why: 'a notification that says the agent is blocked',
    })),
    { eventType: 'plan_mode', toolInput: {}, why: 'the plan review is the thing being asked' },
    { eventType: 'some_future_hook', toolInput: {}, why: 'an unknown event says nothing' },
  ];
  assert.ok(cases.length >= 1 + BLOCKED_PATTERNS.length + 2);

  for (const c of cases) {
    const { agentId, permissionId } = cartridgeWithOpenQuestion();
    await postActivity(agentId, c.eventType, c.toolInput);
    assert.equal(statusOf(permissionId), 'pending',
      `"${c.eventType}" closed a live question — ${c.why}`);
  }
  console.log(`[set] ${cases.length}/${cases.length} waiting/unknown events leave the question open`);
});

// ── The guards against closing a question that is still live ──────────────────────────

test('a question created AFTER the event is never closed — it is the one blocking now', async () => {
  const { agentId } = cartridgeWithOpenQuestion();
  await postActivity(agentId, 'PostToolUse');

  // The hook posts its activity and THEN requests permission (permission-proxy.py:243→255).
  // That newer row is what the agent is blocked on right now.
  const fresh = `ta-perm-fresh-${n}`;
  db.prepare(
    `INSERT INTO permissions (id, agent_id, tool_name, tool_input, description, status, created_at)
     VALUES (?, ?, 'Bash', '{}', 'rm -rf build', 'pending', ?)`,
  ).run(fresh, agentId, new Date(Date.now() + 1000).toISOString());

  await postActivity(agentId, 'PostToolUse');
  assert.equal(statusOf(fresh), 'pending', 'closed the question the agent is currently blocked on');
});

test('a question with a live long-poll is never closed — a hook is still waiting on it', async () => {
  const { agentId, permissionId } = cartridgeWithOpenQuestion();
  let resolved = false;
  __pendingPollsForTests.set(permissionId, {
    resolve: () => { resolved = true; },
    timer: setTimeout(() => {}, 0),
  });
  try {
    await postActivity(agentId, 'PostToolUse');
    assert.equal(statusOf(permissionId), 'pending',
      'closed a question a hook is actively long-polling — the human answer would go nowhere');
    assert.equal(resolved, false);
  } finally {
    clearTimeout(__pendingPollsForTests.get(permissionId)!.timer);
    __pendingPollsForTests.delete(permissionId);
  }
});

// ── The other ingest point ────────────────────────────────────────────────────────────

test('ending the terminal session closes everything it had open', async () => {
  const { agentId, permissionId } = cartridgeWithOpenQuestion();
  const second = `ta-perm-second-${n}`;
  db.prepare(
    `INSERT INTO permissions (id, agent_id, tool_name, tool_input, description, status, created_at)
     VALUES (?, ?, 'Bash', '{}', 'ls', 'pending', ?)`,
  ).run(second, agentId, new Date(Date.now() - 30_000).toISOString());

  const res = await fetch(`${base}/api/agents/session-end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, reason: 'quit' }),
  });
  assert.equal(res.status, 200);

  assert.equal(statusOf(permissionId), 'answered_elsewhere');
  assert.equal(statusOf(second), 'answered_elsewhere', 'a session that is gone answers nothing');
  assert.equal(bannerOf(agentId), '');
});

// ── What the app actually sees ────────────────────────────────────────────────────────

test('the app is told, so the inbox empties without a refresh', async () => {
  const { agentId, permissionId } = cartridgeWithOpenQuestion();
  const before = io.emissions.length;
  await postActivity(agentId, 'PostToolUse');

  const decided = io.emissions.slice(before)
    .filter((e) => e.event === 'permission_decided')
    .map((e) => e.payload as { id: string; status: string });
  assert.ok(decided.some((p) => p.id === permissionId && p.status === 'answered_elsewhere'),
    'no permission_decided emitted — the dashboard and phone keep showing the question');

  const pending = await (await fetch(`${base}/api/permissions/pending`)).json() as { id: string }[];
  assert.ok(!pending.some((p) => p.id === permissionId), 'still listed in the approvals inbox');
});

test('closing is idempotent and never re-closes a decided question', async () => {
  const { agentId, permissionId } = cartridgeWithOpenQuestion();
  db.prepare("UPDATE permissions SET status = 'allowed', decided_at = ? WHERE id = ?")
    .run(new Date().toISOString(), permissionId);

  const closed = closeQuestionsAnsweredElsewhere(agentId, { before: new Date().toISOString() });
  assert.equal(closed.length, 0, 'an already-decided question was touched');
  assert.equal(statusOf(permissionId), 'allowed', 'overwrote a real human decision');
});

test('an agent with nothing open is a no-op, not an error', () => {
  const agentId = `ta-quiet-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,'test',?,'repo','claude','working',?,?)`,
  ).run(agentId, agentId, `${REPO}-quiet-${n}`, new Date().toISOString(), `${SESSION}-quiet-${n}`);
  assert.deepEqual(closeQuestionsAnsweredElsewhere(agentId, { before: new Date().toISOString() }), []);
});
