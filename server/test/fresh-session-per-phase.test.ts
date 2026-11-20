// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import agentsRouter from '../src/routes/agents.ts';
import {
  setImmediateAdvance, executorSettled, tickWorkflowsOnce, __setFreshSessionTimingForTests,
  FRESH_SESSION_AFTER_RUN_DISPATCHES,
} from '../src/lib/workflow-executor-v2.ts';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { __resetLedgersForTests } from '../src/lib/session-ledger.ts';
import { startWorkflowApp, stepsOf, verified, type WorkflowApp } from './helpers/workflow-app.ts';

/**
 * A LONG RUN'S NEXT PHASE STARTS IN A FRESH SESSION — AND LOSES NOTHING IT NEEDS.
 *
 * Every step of a run used to go into one live session that nothing ever emptied: CE: Full
 * Delivery put ~38 prompts and everything they produced into one conversation, re-read on every
 * model call and ended by a compaction. Now, at a phase boundary (a step marked `freshSession`) or
 * once the run has typed FRESH_SESSION_AFTER_RUN_DISPATCHES prompts into the session, the engine
 * types /clear, waits for Claude to confirm the new session (SessionEnd reason "clear"), and sends
 * the step into it — with everything in full, because the new session holds nothing.
 *
 * What must hold, and is checked here on what the cartridge actually received:
 *  - /clear is typed only where it helps and cannot hurt: not before the run has put anything in
 *    the session (what is there is the user's), not for a redo, not for engines NeonCore cannot
 *    see, not when the step opts out;
 *  - the step waits for the clear and then goes exactly once, with full context;
 *  - no confirmation is not a hang: the step is sent anyway, in full;
 *  - /clear is not a death: the cartridge stays online and is not offered "resume".
 */

let app: WorkflowApp;
let agentsBase = '';
let agentsServer: Server;

before(async () => {
  app = await startWorkflowApp('fresh-agent');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, status, created_at, updated_at, no_gos, invariants)
              VALUES ('g1', 'Ship self-serve refunds', 'Support issues refunds by hand.', 'tickets/week', 'active', ?, ?, 'Do not touch tax.', 'Ledger is append-only.')`).run(now, now);
  db.prepare(`INSERT INTO projects (id, goal_id, name, primary_repo, created_at, updated_at) VALUES ('p1', 'g1', 'Ledger', '/tmp/app-repo', ?, ?)`).run(now, now);
  const ex = express(); ex.use(express.json()); ex.use('/api/agents', agentsRouter);
  agentsBase = await new Promise<string>((r) => { agentsServer = ex.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(agentsServer.address() as { port: number }).port}`)); });
  setImmediateAdvance(true);
});
after(() => { setImmediateAdvance(false); app.close(); agentsServer?.close(); });
beforeEach(() => {
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  db.prepare("UPDATE agents SET session_id = 'sess-1', agent_type = 'claude', status = 'idle', pending_question = '', recovery_status = '', interrupted_at = NULL WHERE id = ?").run(app.agent);
  __resetLedgersForTests();
  __setFreshSessionTimingForTests({ settleMs: 0, fallbackMs: 60_000 });
});

const GOAL_FULL = '[NeonCore goal — the work you are doing belongs to this]';
const GOAL_REF = '[NeonCore goal — unchanged since earlier in this session';

const received = (sinceRowid: number) => (db.prepare('SELECT text FROM commands WHERE agent_id = ? AND rowid > ? ORDER BY rowid').all(app.agent, sinceRowid) as { text: string }[]).map((r) => r.text);
const lastRowid = () => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM commands').get() as { n: number }).n;

/** What agent/hooks/reporter.py posts when Claude Code's SessionEnd hook fires. */
async function sessionEnd(reason: string): Promise<number> {
  const res = await fetch(`${agentsBase}/api/agents/session-end`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: app.agent, sessionId: 'sess-1', reason }),
  });
  return res.status;
}

/** What agent/hooks/reporter.py posts from the Stop hook at the end of a turn. */
async function turnEnds(finalText = 'Done.'): Promise<void> {
  const res = await fetch(`${agentsBase}/api/agents/completion-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: (db.prepare('SELECT session_id FROM agents WHERE id = ?').get(app.agent) as { session_id: string }).session_id, agentType: 'claude', finalText }),
  });
  assert.equal(res.status, 200);
  await executorSettled();
}

/** A → B → C on the one cartridge; `b` is B's extra config. */
async function launchThree(b: Record<string, unknown>, a: Record<string, unknown> = {}): Promise<{ runId: string; id: (name: string) => string }> {
  const created = await app.post('/api/workflows/v2/create', {
    name: `fresh ${Math.random()}`, skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'a', name: 'A', executorConfig: { prompt: 'Write the plan to docs/plan.md.', includeDepOutput: true, ...a } },
      { id: 'b', name: 'B', dependsOn: ['a'], executorConfig: { prompt: 'Implement the plan in docs/plan.md.', includeDepOutput: true, ...b } },
      { id: 'c', name: 'C', dependsOn: ['b'], executorConfig: { prompt: 'Review the change.', includeDepOutput: true } },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent, initialContext: 'refunds' });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const runId = start.json.workflow.id as string;
  await executorSettled();
  return { runId, id: (name) => stepsOf(runId).find((s) => s.name === name)!.id };
}

const statusOf = (stepId: string) => (db.prepare('SELECT status, dispatched_prompt FROM workflow_steps WHERE id = ?').get(stepId) as { status: string; dispatched_prompt: string });

async function complete(stepId: string, result = 'done — see docs/plan.md') {
  const res = await app.post(`/api/workflows/webhook/${stepId}/complete`, verified(`${result}\n${'- detail about the change\n'.repeat(10)}`));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await executorSettled();
}

// ── /clear is not a death ──────────────────────────────────────────────────────

test('SessionEnd with reason "clear" keeps the cartridge online and un-interrupted; any other reason still ends it', async () => {
  db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(app.agent);
  assert.equal(await sessionEnd('clear'), 200);
  let row = db.prepare('SELECT status, recovery_status FROM agents WHERE id = ?').get(app.agent) as { status: string; recovery_status: string };
  assert.equal(row.status, 'working', '/clear marked a live cartridge offline');
  assert.notEqual(row.recovery_status, 'interrupted', '/clear offered to "resume" a cartridge that never stopped');

  assert.equal(await sessionEnd('prompt_input_exit'), 200);
  row = db.prepare('SELECT status, recovery_status FROM agents WHERE id = ?').get(app.agent) as { status: string; recovery_status: string };
  assert.equal(row.status, 'offline', 'quitting no longer marks the cartridge offline');
});

test('after a /clear the next prompt carries everything in full again — the cleared session holds nothing', async () => {
  const from = lastRowid();
  sendCommandToAgent(app.agent, 'Look into the refund totals please, they look off by a cent.', false);
  sendCommandToAgent(app.agent, 'Now check the ledger entries for the same orders as well.', false);
  assert.equal(await sessionEnd('clear'), 200);
  sendCommandToAgent(app.agent, 'And compare them against last week for the same report.', false);
  const texts = received(from);
  assert.ok(texts[0].includes(GOAL_FULL) && texts[1].includes(GOAL_REF), 'precondition: the goal goes once, then as a reference');
  assert.ok(texts[2].includes(GOAL_FULL), 'the first prompt after /clear referred to a goal the new session never saw');
});

// ── When the engine starts one ─────────────────────────────────────────────────

test('a phase-opening step: /clear once the turn is over, the step waits for the new session, then goes once with its full context', async () => {
  const { id } = await launchThree({ freshSession: true });
  let from = lastRowid();
  await complete(id('A'), 'A: plan written');
  // A reported from inside its turn: nothing may be typed until the turn ends.
  assert.deepEqual(received(from), [], '/clear was typed into a cartridge still in its turn');
  await turnEnds();
  assert.deepEqual(received(from), ['/clear'], 'B was not preceded by /clear alone');
  assert.equal(statusOf(id('B')).status, 'running', 'B does not hold the cartridge while the session clears');
  assert.equal(statusOf(id('B')).dispatched_prompt, '', 'B was dispatched before the session was cleared');

  from = lastRowid();
  assert.equal(await sessionEnd('clear'), 200);
  await executorSettled();
  const sent = received(from);
  assert.equal(sent.length, 1, `B went ${sent.length}× into the new session`);
  assert.ok(sent[0].includes('Implement the plan in docs/plan.md.'));
  assert.ok(sent[0].includes(GOAL_FULL), 'the new session was not given the goal brief');
  assert.ok(sent[0].includes('[Output from previous step: "A"]\nA: plan written'), 'the new session was not handed A\'s result');
  assert.doesNotMatch(sent[0], /earlier in this session/, 'the new session was told it already had something');
  assert.ok(statusOf(id('B')).dispatched_prompt.includes('Implement the plan'), 'B\'s dispatch was not recorded for the session guard');

  // C follows in the SAME new session — its id arrives with B's prompt — and is referred to what
  // B's prompt just gave it.
  db.prepare("UPDATE agents SET session_id = 'sess-2' WHERE id = ?").run(app.agent);
  from = lastRowid();
  await complete(id('B'), 'B: implemented');
  const c = received(from);
  assert.equal(c.length, 1);
  assert.ok(c[0].includes(GOAL_REF), 'C was not recognised as the same (new) session');

  // Another SessionEnd "clear" once B has been sent (a duplicate hook, or the user clearing by
  // hand) re-sends nothing.
  from = lastRowid();
  await sessionEnd('clear');
  await executorSettled();
  assert.deepEqual(received(from), [], 'a later SessionEnd re-sent the step');
});

test('never before the run has put anything in the session — what is there is the user\'s own conversation', async () => {
  const from = lastRowid();
  const { id } = await launchThree({}, { freshSession: true });
  const sent = received(from);
  assert.ok(!sent.includes('/clear'), 'the first step of a run cleared the user\'s session');
  assert.ok(statusOf(id('A')).dispatched_prompt.includes('Write the plan'));
});

test('never for an engine whose session NeonCore cannot see (Codex)', async () => {
  db.prepare("UPDATE agents SET agent_type = 'codex' WHERE id = ?").run(app.agent);
  const { id } = await launchThree({ freshSession: true });
  const from = lastRowid();
  await complete(id('A'));
  const sent = received(from);
  assert.ok(!sent.includes('/clear'), '/clear was typed into a codex session');
  assert.equal(sent.length, 1);
});

test('never when the step opts out (freshSession: false), even past the automatic threshold', async () => {
  const steps = Array.from({ length: FRESH_SESSION_AFTER_RUN_DISPATCHES + 2 }, (_, i) => ({
    id: `s${i}`, name: `S${i}`, ...(i ? { dependsOn: [`s${i - 1}`] } : {}),
    executorConfig: { prompt: `Do part ${i}.`, includeDepOutput: true, freshSession: false },
  }));
  const created = await app.post('/api/workflows/v2/create', { name: 'opt out', skipStandardGate: true, skipReportStep: true, steps });
  const from = lastRowid();
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  const runId = start.json.workflow.id as string;
  await executorSettled();
  for (let i = 0; i < steps.length; i++) {
    const running = stepsOf(runId).find((s) => s.status === 'running');
    if (!running) break;
    await complete(running.id);
  }
  assert.ok(!received(from).includes('/clear'));
});

test(`automatically, once a run has typed ${FRESH_SESSION_AFTER_RUN_DISPATCHES} prompts into the session — and only then`, async () => {
  const steps = Array.from({ length: FRESH_SESSION_AFTER_RUN_DISPATCHES + 2 }, (_, i) => ({
    id: `s${i}`, name: `S${i}`, ...(i ? { dependsOn: [`s${i - 1}`] } : {}),
    executorConfig: { prompt: `Do part ${i}.`, includeDepOutput: true },
  }));
  const created = await app.post('/api/workflows/v2/create', { name: 'long', skipStandardGate: true, skipReportStep: true, steps });
  const from = lastRowid();
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  const runId = start.json.workflow.id as string;
  await executorSettled();
  for (let i = 0; i < steps.length; i++) {
    await turnEnds();
    if (received(from).at(-1) === '/clear') { await sessionEnd('clear'); await executorSettled(); }
    const running = stepsOf(runId).find((s) => s.status === 'running');
    if (!running) break;
    await complete(running.id);
  }
  const texts = received(from);
  assert.equal(texts.indexOf('/clear'), FRESH_SESSION_AFTER_RUN_DISPATCHES, `cleared at prompt ${texts.indexOf('/clear')}`);
  assert.equal(texts.filter((t) => t === '/clear').length, 1);
  assert.ok(texts[FRESH_SESSION_AFTER_RUN_DISPATCHES + 1].includes(GOAL_FULL));
  assert.equal((db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string }).status, 'completed');
});

test('never for a redo: a gate retry and the step it resets stay in the session that did the work', async () => {
  const created = await app.post('/api/workflows/v2/create', {
    name: 'gate redo', skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'w', name: 'Work', executorConfig: { prompt: 'Implement it.', includeDepOutput: true } },
      { id: 'g', name: 'Gate', executorType: 'quality-gate', dependsOn: ['w'], executorConfig: { gateType: 'test', includeDepOutput: true, maxRetries: 2, freshSession: true } },
    ],
  });
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  const runId = start.json.workflow.id as string;
  await executorSettled();
  const id = (n: string) => stepsOf(runId).find((s) => s.name === n)!.id;
  await complete(id('Work'));
  // The gate opens a phase: cleared once for its first judgement.
  await turnEnds();
  assert.equal(await sessionEnd('clear'), 200);
  await executorSettled();
  const from = lastRowid();
  await app.post(`/api/workflows/webhook/${id('Gate')}/complete`, { result: 'FAIL\ntests red' });
  await executorSettled();
  await turnEnds();
  await complete(id('Work'), 'fixed');
  await turnEnds();
  const texts = received(from);
  assert.ok(!texts.includes('/clear'), 'a retry cleared the session that has the failed attempt in it');
  assert.ok(statusOf(id('Gate')).dispatched_prompt.includes('tests red') || texts.some((t) => t.includes('tests red')), 'the retry lost its feedback');
});

// ── Never typed into a busy cartridge ──────────────────────────────────────────

test('a turn that never ends (no Stop allowed): no /clear at all — the step goes into the current session', async () => {
  __setFreshSessionTimingForTests({ settleMs: 0, idleWaitMs: 0 });
  const { id } = await launchThree({ freshSession: true });
  const from = lastRowid();
  await complete(id('A'));
  tickWorkflowsOnce(); // the poll: the wait for the turn to end has passed
  await executorSettled();
  const sent = received(from);
  assert.ok(!sent.includes('/clear'), '/clear was typed into a cartridge whose turn never ended');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('Implement the plan'));
});

test('a turn that ended on a question to a person is not cleared — the question is not thrown away', async () => {
  __setFreshSessionTimingForTests({ settleMs: 0, idleWaitMs: 60_000 });
  const { id } = await launchThree({ freshSession: true });
  const from = lastRowid();
  await complete(id('A'));
  await turnEnds('I wrote the plan. Should the refunds go to the original card or to store credit?');
  assert.ok(!received(from).includes('/clear'), 'the session was cleared with a question to the user open in it');
});

test('the turn already over when the step becomes ready (a person advanced it later): /clear goes at once', async () => {
  const { runId, id } = await launchThree({ freshSession: true }, { });
  db.prepare('UPDATE workflow_steps SET auto_advance = 0 WHERE id = ?').run(id('A'));
  await complete(id('A'));
  await turnEnds();
  const from = lastRowid();
  await app.post(`/api/workflows/v2/${runId}/steps/${id('A')}/advance`, {});
  await executorSettled();
  assert.deepEqual(received(from), ['/clear']);
});

// ── No confirmation is not a hang ──────────────────────────────────────────────

test('no confirmation that the session cleared: the step is sent anyway, in full, when the window passes', async () => {
  __setFreshSessionTimingForTests({ settleMs: 0, fallbackMs: 0 });
  const { id } = await launchThree({ freshSession: true });
  await complete(id('A'));
  await turnEnds();
  assert.equal(statusOf(id('B')).dispatched_prompt, '');
  const from = lastRowid();
  tickWorkflowsOnce(); // the poll: the window has passed
  await executorSettled();
  const sent = received(from);
  assert.equal(sent.length, 1, 'the step was not sent after the window');
  assert.ok(sent[0].includes(GOAL_FULL), 'an unconfirmed clear was treated as a session that still has the goal');
  // Sent exactly once, however many polls follow.
  tickWorkflowsOnce();
  await executorSettled();
  assert.equal(received(from).length, 1);
});

test('the server restarting between /clear and the dispatch loses nothing: the poll sends the step', async () => {
  const { id } = await launchThree({ freshSession: true });
  await complete(id('A'));
  await turnEnds();
  __resetLedgersForTests(); // the in-memory ledger is gone; the mark on the step is in the database
  __setFreshSessionTimingForTests({ settleMs: 0, fallbackMs: 0 });
  const from = lastRowid();
  tickWorkflowsOnce();
  await executorSettled();
  const sent = received(from);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('Implement the plan') && sent[0].includes(GOAL_FULL));
});
