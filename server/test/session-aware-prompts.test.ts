// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import agentsRouter from '../src/routes/agents.ts';
import {
  setImmediateAdvance, executorSettled as engineSettled, __setFreshSessionTimingForTests, FRESH_SESSION_AFTER_RUN_DISPATCHES,
} from '../src/lib/workflow-executor-v2.ts';
import { loopCountRequirements } from '../src/lib/workflow-loop.ts';
import { LEDGER_REFRESH_DISPATCHES, __resetLedgersForTests } from '../src/lib/session-ledger.ts';
import { startWorkflowApp, stepsOf, verified, type WorkflowApp } from './helpers/workflow-app.ts';

/**
 * A SESSION IS TOLD A THING ONCE — AND AGAIN WHENEVER IT MIGHT HAVE LOST IT.
 *
 * Every step of a run goes to the same live agent session. 53% of everything the catalogue sent
 * was text that session already had: the goal brief and memory on every step, the completion
 * contract, the agent's OWN earlier results pasted back, a loop's full instructions on every
 * iteration. Each is now sent in full once per session and referred to after that
 * (lib/session-ledger.ts).
 *
 * The other half is the one that matters for correctness: a reference is only safe while the
 * session still holds what it refers to. So the full text comes back on a new session, after a
 * reported compaction, every LEDGER_REFRESH_DISPATCHES prompts, and always for engines whose
 * compactions NeonCore cannot see — and every reference names a fetch path that really returns
 * the text. All checked on the text the cartridge actually received (the `commands` table).
 */

let app: WorkflowApp;
let agentsBase = '';
let agentsServer: Server;
const REPO = '/tmp/app-repo';

before(async () => {
  app = await startWorkflowApp('session-agent');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, status, created_at, updated_at, no_gos, invariants)
              VALUES ('g1', 'Ship self-serve refunds', 'Support issues refunds by hand.', 'tickets/week', 'active', ?, ?, 'Do not touch tax.', 'Ledger is append-only.')`).run(now, now);
  db.prepare(`INSERT INTO projects (id, goal_id, name, primary_repo, created_at, updated_at) VALUES ('p1', 'g1', 'Ledger', ?, ?, ?)`).run(REPO, now, now);
  // A realistic memory entry: long enough that a one-line reference is shorter than repeating it
  // (a tiny one is correctly repeated instead — see the "shorter" test below).
  db.prepare(`INSERT INTO agent_memory (id, agent_id, category, content, created_at) VALUES ('m1', ?, 'convention', 'Money is integer cents everywhere; use the Money class from src/money.ts, never floats.', ?)`).run(app.agent, now);
  const ex = express(); ex.use(express.json({ limit: '5mb' })); ex.use('/api/agents', agentsRouter);
  agentsBase = await new Promise<string>((r) => { agentsServer = ex.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(agentsServer.address() as { port: number }).port}`)); });
  setImmediateAdvance(true);
  __setFreshSessionTimingForTests({ settleMs: 0 });
});
after(() => { setImmediateAdvance(false); app.close(); agentsServer?.close(); });
beforeEach(() => {
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  db.prepare("UPDATE agents SET session_id = 'sess-app', agent_type = 'claude', context_compacted_at = '' WHERE id = ?").run(app.agent);
  __resetLedgersForTests();
});

/**
 * The engine settled — with the cartridge behaving as Claude does when the engine types /clear
 * into it (a long run starting a fresh session): SessionEnd reason "clear", then a new session
 * whose id arrives with the next prompt.
 */
let clearsSeen = 0;
let sessionSeq = 0;
async function executorSettled(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await engineSettled();
    // A step parked for a fresh session waits for the turn to end: the Stop hook's completion check.
    const parked = db.prepare(`SELECT 1 FROM workflow_steps WHERE status = 'running' AND INSTR(executor_config, '"_freshSession"') > 0
                                AND json_extract(executor_config, '$._freshSession.clearSentAt') IS NULL
                                AND json_extract(executor_config, '$._freshSession.dispatchedAt') IS NULL LIMIT 1`).get();
    if (parked) {
      const sid = (db.prepare('SELECT session_id FROM agents WHERE id = ?').get(app.agent) as { session_id: string }).session_id;
      const ended = await fetch(`${agentsBase}/api/agents/completion-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, agentType: 'claude', finalText: 'Done.' }),
      });
      assert.equal(ended.status, 200);
      await engineSettled();
    }
    const clears = db.prepare("SELECT rowid FROM commands WHERE agent_id = ? AND text = '/clear' AND rowid > ? ORDER BY rowid").all(app.agent, clearsSeen) as { rowid: number }[];
    if (!clears.length) return;
    for (const c of clears) {
      clearsSeen = c.rowid;
      const res = await fetch(`${agentsBase}/api/agents/session-end`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: app.agent, sessionId: 'whatever', reason: 'clear' }),
      });
      assert.equal(res.status, 200);
      await engineSettled();
      db.prepare('UPDATE agents SET session_id = ? WHERE id = ?').run(`sess-app-${++sessionSeq}`, app.agent);
    }
  }
}

/** Everything the cartridge received, oldest first, from `sinceRowid` on. */
const received = (sinceRowid = 0) => (db.prepare('SELECT rowid, text FROM commands WHERE agent_id = ? AND rowid > ? ORDER BY rowid').all(app.agent, sinceRowid) as { rowid: number; text: string }[]);
const lastRowid = () => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM commands').get() as { n: number }).n;

const GOAL_FULL = '[NeonCore goal — the work you are doing belongs to this]';
const GOAL_REF = '[NeonCore goal — unchanged since earlier in this session';
const MEMORY_FULL = '[Memory: convention: Money is integer cents everywhere; use the Money class from src/money.ts, never floats.]';
const CONTRACT_FULL = 'fill every field its schema describes';
const CONTRACT_REF = '[Completion] As before:';

/** Drive a run to completion through the webhook; every answer mentions its step. */
/** A reply of realistic length: short ones are (correctly) repeated rather than referred to. */
const realistic = (name: string) => `${name} done: the headline finding.\n${'- a supporting detail about the ledger and its tests\n'.repeat(12)}`;

async function drive(runId: string, answer: (name: string, k: number) => string = realistic, tasks = 2): Promise<string> {
  for (let guard = 0; guard < 200; guard++) {
    await executorSettled();
    const status = (db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string }).status;
    if (status !== 'running') return status;
    const all = stepsOf(runId);
    let acted = false;
    for (const s of all) {
      const cfg = JSON.parse(s.executor_config);
      if (s.status === 'completed' && !s.auto_advance && all.some((d) => d.status === 'pending' && JSON.parse(d.depends_on).includes(s.id))) {
        await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/advance`, {}); acted = true; continue;
      }
      if (s.status !== 'running' || !s.dispatched_prompt) {
        if (s.status === 'running' && s.executor_type === 'decision') {
          await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/decide`, { optionId: cfg.options[0].id }); acted = true;
        }
        continue;
      }
      acted = true;
      if (s.executor_type.endsWith('gate')) { await app.post(`/api/workflows/webhook/${s.id}/complete`, { result: 'PASS\nok', next: 'carry on' }); continue; }
      const owed = loopCountRequirements(s.name, all.map((x) => ({ name: x.name, config: JSON.parse(x.executor_config) })));
      const k = Number(cfg._currentLoop) || 1;
      const lines = [cfg.loopCountFrom ? `DONE T-${k} · ${Math.max(0, tasks - k)} remaining` : answer(s.name, k),
        ...owed.map((o) => o.pattern.replace(/\(\\d\+\)/, String(tasks)).replace(/\\s[*+]/g, ' ').replace(/(.)\?/g, '$1').replace(/\\(.)/g, '$1'))];
      const res = await app.post(`/api/workflows/webhook/${s.id}/complete`, verified(lines.join('\n'), { next: `next after ${s.name}` }));
      assert.equal(res.status, 200, JSON.stringify(res.json));
    }
    if (!acted) return 'stalled';
  }
  return 'guard';
}

async function launch(name: string, body: Record<string, unknown> = {}): Promise<string> {
  const tpl = db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { id: string };
  const res = await app.post(`/api/workflows/v2/${tpl.id}/start`, { agentId: app.agent, initialContext: 'refunds', ...body });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.workflow.id as string;
}

const count = (texts: string[], needle: string) => texts.filter((t) => t.includes(needle)).length;

// ── Once per session ───────────────────────────────────────────────────────────

test('goal brief, memory and the completion contract go in full once per session, as references after', async () => {
  const from = lastRowid();
  assert.equal(await drive(await launch('Bug Investigation')), 'completed');
  const texts = received(from).map((r) => r.text);
  assert.ok(texts.length >= 6);
  assert.equal(count(texts, GOAL_FULL), 1, 'the goal brief was sent in full more than once');
  assert.equal(count(texts, MEMORY_FULL), 1, 'memory was sent in full more than once');
  assert.equal(count(texts, CONTRACT_FULL), 1, 'the work contract was sent in full more than once');
  for (const t of texts.slice(1)) {
    assert.ok(t.includes(GOAL_REF), 'a later prompt lost the goal reference');
    assert.ok(t.includes('Do not touch') === false, 'a later prompt repeated the no-gos in full');
  }
  // The compact contract still names THIS step and where to post without MCP.
  for (const t of texts.filter((x) => x.includes(CONTRACT_REF))) {
    const id = /\[neoncore step ([^\s#\]]+)/.exec(t)![1];
    assert.ok(t.includes(`stepId: "${id}"`) && t.includes(`/api/workflows/webhook/${id}/complete`), 'the compact contract lost the step id');
  }
});

test('a result this session reported is referred to — hand-off, first line and a fetch path that returns it', async () => {
  const from = lastRowid();
  const runId = await launch('Bug Investigation');
  assert.equal(await drive(runId, (n) => `${n}: the headline finding\nlong detail ${'x'.repeat(1800)}`), 'completed');
  const root = received(from).map((r) => r.text).find((t) => t.includes('Root Cause Analysis') && t.includes('Output from previous step'))!;
  assert.match(root, /\[Output from previous step: "Reproduce the Bug" — you reported this earlier in this session\]/);
  assert.match(root, /NEXT: next after Reproduce the Bug/);
  assert.match(root, /Reproduce the Bug: the headline finding/);
  assert.doesNotMatch(root, /x{200}/, 'the full result was pasted back anyway');
  const path = /(\/api\/workflows\/steps\/[^/\s"]+\/result)/.exec(root)![1];
  const res = await fetch(`${app.base}${path}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /x{1800}/, 'the fetch path does not return the full result');
});

test('a loop iteration refers to the instructions it already has; the fetch path returns them', async () => {
  const from = lastRowid();
  assert.equal(await drive(await launch('Epic: Task by Task')), 'completed');
  const texts = received(from).map((r) => r.text);
  const loops = texts.filter((t) => t.includes('[Workflow loop — dispatch'));
  assert.ok(loops.length >= 1, 'no loop iteration was dispatched');
  // Dispatch 1 of the SAME step: the prompt carrying its marker and no loop header.
  const stepId = /\[neoncore step ([^\s#\]]+)/.exec(loops[0])![1];
  const work = texts.filter((t) => t.includes(`[neoncore step ${stepId} `) && !t.includes('[Workflow loop — dispatch'));
  assert.equal(work.length, 1);
  for (const t of loops) {
    assert.match(t, /\[Instructions for "Work Every Task": unchanged/);
    const path = /(\/api\/workflows\/steps\/[^/\s"]+\/instructions)/.exec(t)![1];
    const body = await (await fetch(`${app.base}${path}`)).text();
    assert.ok(body.length > 1000 && work[0].includes(body.slice(-400)), 'the fetched instructions are not what dispatch 1 carried');
  }
});

test('a gate retry refers to the gate instructions it already has; the fetch path returns the preset', async () => {
  const from = lastRowid();
  const runId = await launch('Bug Investigation');
  let judged = 0;
  for (let guard = 0; guard < 60; guard++) {
    await executorSettled();
    const all = stepsOf(runId);
    if ((db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string }).status !== 'running') break;
    for (const s of all) {
      if (s.status === 'completed' && !s.auto_advance && all.some((d) => d.status === 'pending' && JSON.parse(d.depends_on).includes(s.id))) await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/advance`, {});
      if (s.status !== 'running') continue;
      if (s.executor_type === 'quality-gate') {
        await app.post(`/api/workflows/webhook/${s.id}/complete`, { result: judged++ === 0 ? 'FAIL\ntests red' : 'PASS\nok' });
      } else {
        await app.post(`/api/workflows/webhook/${s.id}/complete`, verified(`${s.name} done`));
      }
    }
  }
  const gate = stepsOf(runId).find((s) => s.executor_type === 'quality-gate')!;
  const prompts = received(from).map((r) => r.text).filter((t) => t.includes(`[neoncore step ${gate.id} `));
  assert.equal(prompts.length, 2, 'the gate was not judged twice');
  assert.match(prompts[0], /You are a QA engineer\. Run the full test suite/, 'the first judgement lacked the preset');
  assert.match(prompts[1], /\[Instructions for "Verify Fix": unchanged/, 'the retry re-sent the preset instead of referring to it');
  assert.match(prompts[1], /tests red/, 'the retry lost the feedback from the failed attempt');
  const path = /(\/api\/workflows\/steps\/[^/\s"]+\/instructions)/.exec(prompts[1])![1];
  assert.match(await (await fetch(`${app.base}${path}`)).text(), /You are a QA engineer\. Run the full test suite/);
});

test('a reference is used only when it is shorter than what it stands for', async () => {
  const created = await app.post('/api/workflows/v2/create', {
    name: 'tiny', skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'a', name: 'A', executorConfig: { prompt: 'Say ok.', includeDepOutput: true } },
      { id: 'b', name: 'B', dependsOn: ['a'], executorConfig: { prompt: 'Go on.', includeDepOutput: true } },
    ],
  });
  const from = lastRowid();
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent });
  const runId = start.json.workflow.id as string;
  await executorSettled();
  const a = stepsOf(runId).find((x) => x.name === 'A')!;
  await app.post(`/api/workflows/webhook/${a.id}/complete`, { result: 'ok', scope: '1/1', verify: 'n/a → ok' });
  await executorSettled();
  const b = received(from).map((r) => r.text).find((t) => t.includes('Go on.'))!;
  assert.match(b, /\[Output from previous step: "A"\]\nok/, 'a two-character result was not forwarded as itself');
  assert.doesNotMatch(b, /you reported this earlier/, 'a result was replaced by a LONGER reference');
});

// ── …and in full again whenever the session may not have it ───────────────────

test('a new session gets everything in full again', async () => {
  const from = lastRowid();
  const runId = await launch('Bug Investigation');
  await executorSettled();
  const first = stepsOf(runId).find((s) => s.status === 'running')!;
  // The cartridge was restarted (or /clear'ed) before it reported: the next step — dispatched the
  // moment the report is accepted — goes into the NEW session.
  db.prepare("UPDATE agents SET session_id = 'sess-app-NEW' WHERE id = ?").run(app.agent);
  await app.post(`/api/workflows/webhook/${first.id}/complete`, verified('done'));
  await executorSettled();
  const texts = received(from).map((r) => r.text);
  assert.equal(count(texts, GOAL_FULL), 2, 'the new session was not given the goal brief');
  assert.equal(count(texts, CONTRACT_FULL), 2, 'the new session was not given the full contract');
  assert.doesNotMatch(texts[1], /you reported this earlier in this session/, 'a new session was told it had reported something');
});

test('a compaction reported in the transcript makes the next prompt full again', async () => {
  const from = lastRowid();
  const runId = await launch('Bug Investigation');
  await executorSettled();
  const first = stepsOf(runId).find((s) => s.status === 'running')!;
  // What agent/hooks/reporter.py ships after Claude Code compacts: the boundary, then the summary.
  const res = await fetch(`${agentsBase}/api/agents/transcript`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-app', machine: 'box', repoPath: REPO, engine: 'claude', events: [
      { seq: 901, role: 'system', content: [], compacted: true },
      { seq: 902, role: 'user', content: [{ type: 'text', text: 'This session is being continued…' }], compacted: true },
    ] }),
  });
  assert.ok(res.ok, await res.text());
  await app.post(`/api/workflows/webhook/${first.id}/complete`, verified('done'));
  await executorSettled();
  const texts = received(from).map((r) => r.text);
  assert.equal(count(texts, GOAL_FULL), 2, 'the goal brief was not re-sent after the compaction');
  assert.doesNotMatch(texts[1], /you reported this earlier in this session/);
  const stored = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'system'").get(app.agent) as { n: number };
  assert.equal(stored.n, 0, 'the compaction boundary was stored as a conversation message');
});

test(`the ledger refreshes after ${LEDGER_REFRESH_DISPATCHES} prompts even with no compaction reported`, async () => {
  const from = lastRowid();
  // 12 tasks: the loop alone crosses the refresh point. With fresh sessions turned off for the
  // loop — otherwise the run would clear the session there instead (next test).
  const runId = await launch('Epic: Task by Task');
  const loop = stepsOf(runId).find((x) => x.name === 'Work Every Task')!;
  db.prepare('UPDATE workflow_steps SET executor_config = ? WHERE id = ?')
    .run(JSON.stringify({ ...JSON.parse(loop.executor_config), freshSession: false }), loop.id);
  assert.equal(await drive(runId, realistic, 12), 'completed');
  // Load Epic + the 12 loop dispatches (the step AFTER the loop may well start a fresh session).
  const texts = received(from).map((r) => r.text).slice(0, 13);
  assert.ok(!texts.includes('/clear'), 'the session was cleared although the step opted out');
  assert.ok(texts.length > LEDGER_REFRESH_DISPATCHES, `only ${texts.length} prompts`);
  const fullAt = texts.map((t, i) => (t.includes(GOAL_FULL) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(fullAt.slice(0, 2), [0, LEDGER_REFRESH_DISPATCHES], 'full context did not come back at the refresh point');
  // After the refresh the loop instructions are sent in full once more, then referred to again.
  const full = texts.filter((t) => t.includes('[Workflow loop — dispatch') && !t.includes('[Instructions for "Work Every Task"'));
  assert.equal(full.length, 1, 'the loop instructions were not re-sent exactly once after the refresh');
  // …and so is the upstream result the loop reads: once in full after the refresh, then referred to.
  const afterRefresh = texts.slice(LEDGER_REFRESH_DISPATCHES);
  const upstreamFull = afterRefresh.filter((t) => t.includes('[Output from previous step: "Load Epic"]\n'));
  assert.equal(upstreamFull.length, 1, `after the refresh the upstream result went in full ${upstreamFull.length}×`);
  assert.ok(afterRefresh.slice(afterRefresh.indexOf(upstreamFull[0]) + 1).every((t) => !t.includes('[Workflow loop') || t.includes('"Load Epic" — given to you earlier in this session')),
    'a later iteration neither had the result nor a reference to it');
});

test(`after ${FRESH_SESSION_AFTER_RUN_DISPATCHES} prompts a run continues in a fresh session: /clear, then everything in full`, async () => {
  const from = lastRowid();
  assert.equal(await drive(await launch('Epic: Task by Task'), realistic, 12), 'completed');
  const texts = received(from).map((r) => r.text);
  const clearAt = texts.indexOf('/clear');
  assert.equal(clearAt, FRESH_SESSION_AFTER_RUN_DISPATCHES, `the session was cleared at prompt ${clearAt}`);
  assert.equal(texts.filter((t) => t === '/clear').length, 1, 'cleared more than once in a 14-prompt run');
  const next = texts[clearAt + 1];
  assert.ok(next.includes(GOAL_FULL), 'the first prompt of the new session lacked the goal brief');
  assert.ok(next.includes(CONTRACT_FULL) || next.includes('fill every field'), 'the first prompt of the new session lacked the full contract');
  assert.ok(next.includes('[Output from previous step: "Load Epic"]\n'), 'the new session was not given the upstream result');
  assert.doesNotMatch(next, /\[Instructions for "Work Every Task": unchanged/, 'the new session was referred to instructions it never had');
  assert.doesNotMatch(next, /earlier in this session/, 'the new session was told it already had something');
  // A loop iteration after the clear carries the hand-off from the one before it.
  assert.match(next, /\[Workflow loop — dispatch/);
  // …and /clear did not take the cartridge down with the session.
  const agent = db.prepare('SELECT status, recovery_status FROM agents WHERE id = ?').get(app.agent) as { status: string; recovery_status: string };
  assert.notEqual(agent.status, 'offline');
  assert.notEqual(agent.recovery_status, 'interrupted');
});

test('an engine whose compactions NeonCore cannot see always gets full prompts', async () => {
  db.prepare("UPDATE agents SET agent_type = 'codex' WHERE id = ?").run(app.agent);
  const from = lastRowid();
  assert.equal(await drive(await launch('Bug Investigation')), 'completed');
  const texts = received(from).map((r) => r.text);
  assert.equal(count(texts, GOAL_FULL), texts.length, 'a codex prompt went out with a goal reference');
  assert.equal(count(texts, GOAL_REF), 0);
  assert.ok(!texts.some((t) => t.includes('you reported this earlier in this session')));
});

// ── The whole catalogue ───────────────────────────────────────────────────────

test('no session is sent the same full block twice, and every reference resolves — every seeded template', async () => {
  const wrong: string[] = [];
  const templates = db.prepare('SELECT name FROM workflows WHERE template_id IS NULL').all() as { name: string }[];
  let references = 0;
  for (const { name } of templates) {
    if (stepsOf((db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { id: string }).id).some((s) => s.executor_type === 'confer')) continue;
    __resetLedgersForTests();
    const from = lastRowid();
    const status = await drive(await launch(name));
    if (status !== 'completed') { wrong.push(`${name}: ${status}`); continue; }
    const texts = received(from).map((r) => r.text);
    // Never more full copies than the ledger's refresh schedule allows — per SESSION: a /clear
    // (the run starting a fresh session) begins a new one, which is owed everything again.
    const sessions: string[][] = [[]];
    for (const t of texts) { if (t === '/clear') sessions.push([]); else sessions[sessions.length - 1].push(t); }
    for (const [label, needle] of [['goal brief', GOAL_FULL], ['memory', MEMORY_FULL], ['contract', CONTRACT_FULL]] as const) {
      for (const [i, session] of sessions.entries()) {
        const allowed = Math.ceil(session.length / LEDGER_REFRESH_DISPATCHES);
        const n = count(session, needle);
        if (n > allowed) wrong.push(`${name}: ${label} sent in full ${n}× over ${session.length} prompts of session ${i + 1} (allowed ${allowed})`);
      }
    }
    for (const t of texts) {
      for (const m of t.matchAll(/(\/api\/workflows\/steps\/[^/\s"]+\/(?:result|instructions))/g)) {
        references++;
        const r = await fetch(`${app.base}${m[1]}`);
        const body = await r.text();
        if (r.status !== 200 || !body.trim() || /no result yet/.test(body)) wrong.push(`${name}: ${m[1]} → ${r.status} "${body.slice(0, 40)}"`);
      }
    }
  }
  assert.ok(references > 50, `only ${references} references checked — the set is too small`);
  assert.deepEqual(wrong, []);
});
