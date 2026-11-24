/**
 * BACKGROUND WORK IS A STATUS, NOT SILENCE (docs/plans/epic-qa-any-project.md, part 6).
 *
 * REPORTED: "when something is running in the background this status should be reported to neoncore
 * VS looking like nothing is happening". Ravinia Prep, 2026-11-23 22:01: the cartridge started its
 * gateway suite under Monitor (taskId bdumdar5v, timeoutMs 1800000), ended its turn, and NeonCore
 * showed "Claude is waiting for your input" → waiting, for a suite that ran 10+ minutes.
 *
 * THE SET — every way background work starts × everything that can happen while it runs:
 *   start kinds: Bash `backgroundTaskId`, Monitor `taskId`+`timeoutMs`, and the Stop hook's
 *                `background_tasks` alone (subagent, workflow)
 *   × Stop · idle_prompt notification · the work-standard stop gate · later tool use ·
 *     a Stop that no longer lists it · the deadline
 * and the busy/alive readers: the queue, the request-silence checks, the reaper, recovery.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import '../src/lib/roadmap.ts';   // creates `epics`, which the agents router reaches at import
import activityRouter from '../src/routes/activity.ts';
import agentsRouter from '../src/routes/agents.ts';
import { isCartridgeBusy, busyRepoSiblings } from '../src/lib/queue-runner.ts';
import { findZombies } from '../src/lib/zombie-reaper.ts';
import { findDeadInboxes } from '../src/lib/dead-inbox.ts';
import {
  openBackgroundTasks, sweepBackgroundDeadlines, BACKGROUND_DEFAULT_MS, BACKGROUND_GRACE_MS,
  sweepQuietWorking, IDLE_THRESHOLD_MS, recordBackgroundStart, syncBackgroundTasks,
} from '../src/lib/background-tasks.ts';
import { BUSY_STATUSES } from '../src/lib/activity-status.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();
let base = '';
let server: Server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', activityRouter);
  app.use('/api/agents', agentsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); });
  });
});
test.after(() => server?.close());

let n = 0;
/** A cartridge mid-objective under the work standard: the stop gate would block a bare stop. */
function cartridge(): { id: string; session: string } {
  const id = `bg-agent-${++n}`;
  const session = `bg-session-${n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,
                                  active_objective,standard_armed,standard_blocks,standard_state)
              VALUES (?,?,'test',?,'repo','claude','working',?,?,'Fix the gateway suite',1,0,'')`)
    .run(id, id, `/tmp/bg-repo-${n}`, new Date().toISOString(), session);
  io.connect(id);
  return { id, session };
}
const row = (id: string) => db.prepare('SELECT status, standard_blocks, standard_state, turn_ended_at, active_objective FROM agents WHERE id = ?')
  .get(id) as { status: string; standard_blocks: number; standard_state: string; turn_ended_at: string | null; active_objective: string };

async function activity(agentId: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, toolName: '', toolInput: {}, ...body }),
  });
  assert.equal(res.status, 201, `activity ${String(body.eventType)} was not accepted`);
}
async function stopGate(session: string, finalText = 'Waiting for the suite; I will report when it is green.') {
  const res = await fetch(`${base}/api/agents/completion-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session, agentType: 'claude', finalText, stopHookActive: false }),
  });
  return res.json() as Promise<{ decision: string; cleared?: boolean }>;
}
async function agentApi(id: string) {
  const res = await fetch(`${base}/api/agents/${id}`);
  return res.json() as Promise<{ status: string; background?: { taskId: string; kind: string; description: string; startedAt: string; deadlineAt: string }[] }>;
}

interface StartKind {
  name: string;
  taskId: string;
  kind: string;
  description: string;
  /** The PostToolUse that starts it, if this kind has one (undocumented, never relied on alone). */
  start?: Record<string, unknown>;
  /** The deadline the start implies, ms after it. */
  deadlineMs: number;
}
const KINDS: StartKind[] = [
  {
    name: 'Bash run_in_background', taskId: 'bdq5jiquv', kind: 'shell', description: 'cargo test gateway',
    start: { eventType: 'PostToolUse', toolName: 'Bash', toolInput: { command: 'cargo test', run_in_background: true, description: 'cargo test gateway' },
             toolResult: { stdout: '', stderr: '', backgroundTaskId: 'bdq5jiquv' } },
    deadlineMs: BACKGROUND_DEFAULT_MS,
  },
  {
    name: 'Monitor', taskId: 'bdumdar5v', kind: 'monitor', description: 'final G1 suite + Postgres tests',
    start: { eventType: 'PostToolUse', toolName: 'Monitor', toolInput: { description: 'final G1 suite + Postgres tests', timeout_ms: 1_800_000 },
             toolResult: { taskId: 'bdumdar5v', timeoutMs: 1_800_000, persistent: false } },
    deadlineMs: 1_800_000 + BACKGROUND_GRACE_MS,
  },
  { name: 'background subagent (Stop list only)', taskId: 'agent-7f2', kind: 'subagent', description: 'Explore the routing tables', deadlineMs: BACKGROUND_DEFAULT_MS },
  { name: 'workflow (Stop list only)', taskId: 'wf-91c', kind: 'workflow', description: 'review-changes', deadlineMs: BACKGROUND_DEFAULT_MS },
];
const listed = (k: StartKind) => [{ id: k.taskId, type: k.kind, status: 'running', description: k.description }];

test('the busy set includes background, and every kind is in the set under test', () => {
  assert.ok(BUSY_STATUSES.has('working') && BUSY_STATUSES.has('background'));
  assert.deepEqual(new Set(KINDS.map((k) => k.kind)), new Set(['shell', 'monitor', 'subagent', 'workflow']));
});

for (const k of KINDS) {
  test(`${k.name}: Stop → background · idle_prompt keeps it · the gate allows without a block · tool use → working · unlisted → finished`, async () => {
    const { id, session } = cartridge();
    const t0 = Date.now();
    if (k.start) await activity(id, k.start);

    // Stop listing the work: the turn ended, the work did not.
    await activity(id, { eventType: 'Stop', backgroundTasks: listed(k) });
    assert.equal(row(id).status, 'background', 'a Stop with open background work must say background');
    const open = openBackgroundTasks(id);
    assert.equal(open.length, 1);
    assert.equal(open[0].taskId, k.taskId);
    assert.equal(open[0].kind, k.kind);
    assert.equal(open[0].description, k.description);
    const deadline = Date.parse(open[0].deadlineAt) - Date.parse(open[0].startedAt);
    assert.ok(Math.abs(deadline - k.deadlineMs) < 5_000, `deadline ${deadline}ms, expected ~${k.deadlineMs}ms`);
    assert.ok(Date.parse(open[0].startedAt) >= t0 - 1000);

    // The API (and so the socket's normalizeAgent) carries it.
    const api = await agentApi(id);
    assert.equal(api.status, 'background');
    assert.deepEqual(api.background?.map((b) => [b.taskId, b.kind, b.description]), [[k.taskId, k.kind, k.description]]);

    // Busy: nothing new is typed into a cartridge whose work is still running.
    assert.equal(isCartridgeBusy(id), true, 'background must count as busy');

    // The work-standard gate: no report yet, but the agent is not finished — it is paused on its
    // own work. Allowed, never counted as a refusal, and the turn is NOT over.
    const before = row(id);
    const decision = await stopGate(session);
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.cleared, false);
    const after = row(id);
    assert.equal(after.standard_blocks, before.standard_blocks, 'a background stop must not count as a block');
    assert.notEqual(after.standard_state, 'needs_review');
    assert.equal(after.active_objective, 'Fix the gateway suite', 'the objective stays open');
    assert.equal(after.turn_ended_at, before.turn_ended_at, 'the turn is not over: turnEnded must not run');
    assert.equal(after.status, 'background');

    // ~60 s later Claude Code says "waiting for your input": not while the work runs.
    await activity(id, { eventType: 'notification', toolInput: 'Claude is waiting for your input' });
    assert.equal(row(id).status, 'background', 'idle_prompt must not turn background into waiting');

    // The agent is re-invoked and uses a tool: working.
    await activity(id, { eventType: 'PostToolUse', toolName: 'Read', toolInput: { file_path: 'x' }, toolResult: {} });
    assert.equal(row(id).status, 'working');

    // It ends its turn again with nothing in flight: the task closed as finished.
    await activity(id, { eventType: 'Stop', backgroundTasks: [] });
    assert.equal(openBackgroundTasks(id).length, 0);
    const closed = db.prepare('SELECT end_reason FROM agent_background_tasks WHERE agent_id = ? AND task_id = ?').get(id, k.taskId) as { end_reason: string };
    assert.equal(closed.end_reason, 'finished');
    assert.notEqual(row(id).status, 'background');
    assert.equal((await agentApi(id)).background?.length ?? 0, 0);
  });

  test(`${k.name}: past its deadline the task overran — idle again, and an alert`, async () => {
    const { id } = cartridge();
    if (k.start) await activity(id, k.start);
    await activity(id, { eventType: 'Stop', backgroundTasks: listed(k) });
    const [task] = openBackgroundTasks(id);

    // Before the deadline: nothing happens.
    assert.deepEqual(sweepBackgroundDeadlines(Date.parse(task.deadlineAt) - 1000).filter((a) => a === id), []);
    assert.equal(row(id).status, 'background');

    io.emissions.length = 0;
    const overran = sweepBackgroundDeadlines(Date.parse(task.deadlineAt) + 1000);
    assert.ok(overran.includes(id));
    const closed = db.prepare('SELECT end_reason FROM agent_background_tasks WHERE agent_id = ? AND task_id = ?').get(id, k.taskId) as { end_reason: string };
    assert.equal(closed.end_reason, 'overran');
    assert.equal(row(id).status, 'idle', 'an overrun releases the cartridge to the normal sweeps');
    const alert = io.emissions.find((e) => e.event === 'agent_stuck' && (e.payload as { agentId: string }).agentId === id);
    assert.ok(alert, 'an overrun raises an alert on the agent');
    assert.match((alert!.payload as { pattern: string }).pattern, new RegExp(k.description.replace(/[+]/g, '\\+')));
  });
}

test('a permission notification still means waiting, background or not', async () => {
  const { id } = cartridge();
  await activity(id, { eventType: 'Stop', backgroundTasks: listed(KINDS[0]) });
  await activity(id, { eventType: 'notification', toolInput: 'Claude needs your permission to use Bash' });
  assert.equal(row(id).status, 'waiting');
});

test('a Stop without the field (older Claude Code) leaves recorded tasks alone', async () => {
  const { id } = cartridge();
  await activity(id, { eventType: 'Stop', backgroundTasks: listed(KINDS[1]) });
  await activity(id, { eventType: 'PostToolUse', toolName: 'Read', toolInput: {}, toolResult: {} });
  await activity(id, { eventType: 'Stop' });
  assert.equal(openBackgroundTasks(id).length, 1, 'no field is not an empty list');
});

test('SubagentStop carries the same list and reconciles it', async () => {
  const { id } = cartridge();
  await activity(id, { eventType: 'Stop', backgroundTasks: listed(KINDS[2]) });
  await activity(id, { eventType: 'SubagentStop', backgroundTasks: [] });
  assert.equal(openBackgroundTasks(id).length, 0);
});

test('a filed report still closes the objective, and the cartridge stays background while work runs', async () => {
  const { id, session } = cartridge();
  await activity(id, { eventType: 'Stop', backgroundTasks: listed(KINDS[0]) });
  const report = 'Done.\nNEONCORE-DONE\nscope: 1/1 — the suite\nverify: cargo test → 12 passed\ndeferred: none';
  const d = await stopGate(session, report);
  assert.equal(d.decision, 'allow');
  assert.equal(d.cleared, true);
  assert.equal(row(id).active_objective, '');
  assert.equal(row(id).status, 'background');
});

test('busy and alive readers: queue siblings, reaper and dead-inbox treat background as live work', async () => {
  const { id } = cartridge();
  await activity(id, { eventType: 'Stop', backgroundTasks: listed(KINDS[0]) });
  // A sibling cartridge in the same checkout sees it as busy.
  const sib = `bg-sib-${++n}`;
  const repo = (db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(id) as { repo_path: string }).repo_path;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id) VALUES (?,?,'test',?,'repo','claude','idle',?,?)`)
    .run(sib, sib, repo, new Date().toISOString(), `${sib}-s`);
  assert.deepEqual(busyRepoSiblings([sib], []), [id]);

  // Quiet for a day: the reaper leaves a background cartridge to its deadline sweep.
  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86_400_000).toISOString(), id);
  assert.ok(!findZombies(db, { hasActiveSocket: () => false }).some((z) => z.id === id));

  // But a dead inbox is dead whatever the status says.
  db.prepare('UPDATE agents SET inbox_pid = 999999 WHERE id = ?').run(id);
  db.prepare("UPDATE agents SET machine = ? WHERE id = ?").run((await import('node:os')).hostname(), id);
  if (process.platform !== 'win32') {
    assert.ok(findDeadInboxes(db, { hasActiveSocket: () => false, pidAlive: () => false }).includes(id));
  }
});

/**
 * QUIET MID-TURN IS NOT IDLE WHEN BACKGROUND WORK IS OPEN. Found live, Ravinia Prep 23:16: the
 * cartridge started G3's suite in the background (bj8wm2d88), kept its turn open with no further
 * hook events, and the working → idle silence sweep (index.ts) aged it to `idle` while the suite ran.
 * The sweep now lives in lib/background-tasks.ts (`sweepQuietWorking`) so this can drive it.
 * SET: every start kind × silent past the idle threshold → background; controls: no open work → idle,
 * recent activity → untouched.
 */
test('the silence sweep sends a quiet cartridge with open background work to background, not idle', () => {
  const now = Date.now();
  const old = new Date(now - IDLE_THRESHOLD_MS - 60_000).toISOString();
  const quiet = () => { const c = cartridge(); db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(old, c.id); return c.id; };

  const shell = quiet();
  recordBackgroundStart(shell, 'Bash', { command: 'cargo test' }, { backgroundTaskId: 'q-sh' }, old);
  const monitor = quiet();
  recordBackgroundStart(monitor, 'Monitor', { description: 'suite' }, { taskId: 'q-mon', timeoutMs: 1_800_000 }, old);
  const subagent = quiet();
  syncBackgroundTasks(subagent, [{ id: 'q-sub', type: 'subagent', status: 'running', description: 'review' }], old);
  db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(subagent);
  const workflow = quiet();
  syncBackgroundTasks(workflow, [{ id: 'q-wf', type: 'workflow', status: 'running', description: 'fan-out' }], old);
  db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(workflow);
  const nothing = quiet();
  const recent = cartridge().id;
  recordBackgroundStart(recent, 'Bash', { command: 'x' }, { backgroundTaskId: 'q-recent' }, new Date(now).toISOString());

  const changed = sweepQuietWorking(now);
  for (const id of [shell, monitor, subagent, workflow]) assert.equal(row(id).status, 'background', id);
  assert.equal(row(nothing).status, 'idle');
  assert.equal(row(recent).status, 'working');
  assert.deepEqual([...changed].sort(), [shell, monitor, subagent, workflow, nothing].sort());
});
