/**
 * ONE COMPLETION CONTRACT PER DISPATCH.
 *
 * Every workflow step used to carry TWO: the step's completion instruction (call
 * neoncore_report_step_done with scope + verify) AND the 1,105-char work-standard block
 * (end your message with NEONCORE-DONE + scope + verify). The second was load-bearing: no
 * completion endpoint cleared the stop gate, so an agent that edited files and reported through
 * the tool was still blocked at Stop until it printed the block too. 76 of 86 step dispatches
 * carried both, and agents filled in both.
 *
 * Now an ACCEPTED completion closes the agent's objective and disarms the gate, so the step
 * dispatch can carry the contract silently (offered, no text) and the tool call alone is enough.
 * SET-BASED over every endpoint that accepts a completion.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import tasksRouter from '../src/routes/tasks.ts';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { evaluateStop, WORK_STANDARD_SHORT } from '../src/lib/work-standard.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();
let base = '';
let server: Server;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/tasks', tasksRouter);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r();
  }); });
});
test.after(() => server?.close());

let n = 0;
const iso = () => new Date().toISOString();

/** A cartridge mid-task that has edited files: offered, armed, objective set. */
function armedAgent(): string {
  const id = `occ-ag-${++n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,
              active_objective, standard_offered, standard_armed, standard_blocks)
              VALUES (?,?,'m',?,?,'claude','working',?,?, 'build the thing', 1, 1, 0)`)
    .run(id, id, `/r/${id}`, `r${id}`, iso(), `sess-${id}`);
  io.connect(id);
  return id;
}
function runningStep(agentId: string, executorType: string, config: Record<string, unknown> = {}): string {
  const id = `occ-s-${++n}`;
  db.prepare(`INSERT INTO workflows (id, name, status, template_id, created_at) VALUES (?, 'run', 'running', 'tpl', ?)`).run(`w-${id}`, iso());
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config,
              position_x, position_y, created_at, started_at, dispatch_agent_id)
              VALUES (?,?,?,'running',?,?,?,0,0,?,?,?)`)
    .run(id, `w-${id}`, 'step', executorType, agentId, JSON.stringify(config), iso(), iso(), agentId);
  return id;
}
function claimedTask(agentId: string): string {
  const id = `occ-t-${++n}`;
  db.prepare(`INSERT INTO tasks (id, title, prompt, status, priority, created_at, assigned_agent_id)
              VALUES (?, 't', 'p', 'in_progress', 0, ?, ?)`).run(id, iso(), agentId);
  return id;
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const gate = (id: string) => db.prepare(
  'SELECT active_objective, standard_armed, standard_offered FROM agents WHERE id = ?',
).get(id) as { active_objective: string; standard_armed: number; standard_offered: number };

const VERIFIED = { result: 'done', scope: '3/3 sites', verify: 'npm test → 3 passed', deferred: 'none' };

const ENDPOINTS: { name: string; accept: (agentId: string) => Promise<Response>; reject?: (agentId: string) => Promise<Response> }[] = [
  {
    name: 'work step — /webhook/:stepId/complete (what neoncore_report_step_done posts)',
    accept: (a) => post(`/api/workflows/webhook/${runningStep(a, 'claude-code')}/complete`, VERIFIED),
    reject: (a) => post(`/api/workflows/webhook/${runningStep(a, 'claude-code')}/complete`, { result: 'done' }),
  },
  {
    name: 'gate step — /webhook/:stepId/complete with a verdict',
    accept: (a) => post(`/api/workflows/webhook/${runningStep(a, 'review-gate')}/complete`, { result: 'PASS\nlooks right' }),
  },
  {
    name: 'panel member — /webhook/:stepId/panel/:agentId/complete',
    accept: (a) => post(`/api/workflows/webhook/${runningStep(a, 'deliberation', {
      deliberationPhase: 'collecting', panelAgentIds: [a, 'someone-else'],
    })}/panel/${a}/complete`, { result: 'my view' }),
  },
  {
    name: 'task — /api/tasks/:id/complete',
    accept: (a) => post(`/api/tasks/${claimedTask(a)}/complete`, { agentId: a, ...VERIFIED }),
    reject: (a) => post(`/api/tasks/${claimedTask(a)}/complete`, { agentId: a, result: 'done' }),
  },
];

test('EVERY accepted completion closes the objective and disarms the stop gate', async () => {
  const wrong: string[] = [];
  for (const ep of ENDPOINTS) {
    const a = armedAgent();
    const res = await ep.accept(a);
    if (!res.ok) { wrong.push(`${ep.name}: HTTP ${res.status} ${await res.text()}`); continue; }
    const g = gate(a);
    if (g.standard_armed || g.standard_offered || g.active_objective) wrong.push(`${ep.name}: still armed ${JSON.stringify(g)}`);
    const stop = evaluateStop(db, { sessionId: `sess-${a}`, finalText: 'All done.' });
    if (stop.decision !== 'allow') wrong.push(`${ep.name}: Stop still demands a NEONCORE-DONE block after the tool report`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('a REJECTED completion leaves the gate armed', async () => {
  const wrong: string[] = [];
  for (const ep of ENDPOINTS.filter((e) => e.reject)) {
    const a = armedAgent();
    const res = await ep.reject!(a);
    if (res.ok) { wrong.push(`${ep.name}: an unverified completion was accepted`); continue; }
    if (!gate(a).standard_armed) wrong.push(`${ep.name}: an unverified claim released the gate`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test("standard: 'silent' offers the contract without the text", () => {
  const a = armedAgent();
  db.prepare(`UPDATE agents SET standard_offered = 0, standard_armed = 0, active_objective = '' WHERE id = ?`).run(a);
  const cmd = sendCommandToAgent(a, 'Map the architecture of the prompt pipeline in detail.', false, undefined, { standard: 'silent' });
  assert.ok(cmd);
  assert.ok(!cmd!.text.includes('[NeonCore work standard'), 'the block was injected anyway');
  assert.equal(gate(a).standard_offered, 1, 'the gate was not offered, so a later edit could never arm it');
});

test('the full standard is still injected for ordinary dispatches', () => {
  const a = armedAgent();
  const cmd = sendCommandToAgent(a, 'Fix the login redirect bug on the settings page.', false);
  assert.ok(cmd!.text.endsWith(WORK_STANDARD_SHORT));
});

test('EVERY workflow step dispatch uses the silent standard', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/workflow-executor-v2.ts'), 'utf8');
  const fn = src.slice(src.indexOf('function dispatchStepCommand('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const calls = [...body.matchAll(/sendCommandToAgent\(([^;]*)\);/g)];
  assert.ok(calls.length >= 1, 'dispatchStepCommand no longer calls sendCommandToAgent');
  for (const c of calls) assert.match(c[1], /standard:\s*'silent'/, `a step dispatch still injects the full block: ${c[0]}`);
  // and every step executor dispatches through it, not around it
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const direct = [...code.matchAll(/sendCommandToAgent\(/g)].length;
  assert.equal(direct, calls.length, 'a step executor calls sendCommandToAgent directly, bypassing the silent standard');
});
