/**
 * A CONFER STARTS WITH ITS WHOLE TEAM — on EVERY path that can start one.
 *
 * Reported as: "if we use a goal and inside this goal there is a confer that will go through a
 * full list of tasks from Jira, will the flow continue to the next workflows?" Measured before the
 * fix: it never got that far. Every path but the Run button created the run through
 * cloneTemplateAsRun with ONE cartridge, and a confer step with no roster refuses at dispatch —
 * "needs at least 2 participants; got 0" — so a Confer in a goal, on a schedule, or reached by a
 * Continue step failed at its first real step.
 *
 * SET-BASED OVER THE PATHS, because the class is "a way to create a run that forgets the team":
 *   Run button (HTTP start) · schedule (heartbeat) · Goal Pilot stage · Continue to Workflow.
 * A fifth path must be added here, and fail, before it ships.
 *
 * Then the goal question end to end: a Confer stage staffed with two repos gets the Jira epic
 * from its focus, runs as a confer, and when it finishes the pipeline moves to the next stage.
 */
import './helpers/isolated-db.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import heartbeatsRouter from '../src/routes/heartbeats.ts';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import { fireHeartbeat } from '../src/lib/heartbeat-scheduler.ts';
import { stagesOf } from '../src/lib/goal-pilot.ts';
import { sweepPilots, stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';
import { emitRunFinished } from '../src/lib/run-events.ts';
import { continueIntoWorkflow } from '../src/lib/workflow-continue.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';

const io = installStubIO();
const app = express();
app.use(express.json());
app.use('/api/workflows', workflowsRouter);
app.use('/api/heartbeats', heartbeatsRouter);
app.use('/api/goal-pilots', goalPilotsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => { server.close(); stopGoalPilotRunner(); });

async function post(route: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: text }; }
}

let n = 0;
const iso = () => new Date().toISOString();
function cartridge(repo: string): string {
  const id = `team-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type, active_queue_item_id)
              VALUES (?, ?, 'box', ?, ?, 'idle', ?, ?, 'claude', '')`)
    .run(id, `box/${repo.split('/').pop()}`, repo, repo.split('/').pop(), iso(), `sess-${id}`);
  io.connect(id);
  return id;
}
const conferTemplate = () => (db.prepare("SELECT id FROM workflows WHERE name = 'Confer' AND template_id IS NULL").get() as { id: string }).id;

/** What a run's confer step will start with. */
function rosterOf(runId: string): string[] {
  const row = db.prepare("SELECT executor_config FROM workflow_steps WHERE workflow_id = ? AND name = 'Confer & Build'").get(runId) as { executor_config: string };
  return (JSON.parse(row.executor_config).conferAgentIds ?? []) as string[];
}
/** Who runs the one-cartridge steps of that run. */
const scopeOwner = (runId: string) =>
  (db.prepare("SELECT executor_id FROM workflow_steps WHERE workflow_id = ? AND name = 'Scope the Work'").get(runId) as { executor_id: string }).executor_id;
const quiet = (runId: string) => db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);

// ── Every path ─────────────────────────────────────────────────────────────────────────

const PATHS: { name: string; start: (team: string[]) => Promise<string> }[] = [
  {
    name: 'the Run button ("Run on" with two cartridges)',
    start: async (team) => {
      const r = await post(`/api/workflows/v2/${conferTemplate()}/start`, { conferAllSteps: team, initialContext: 'Add refunds', queueIfBusy: false });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json.workflow.id as string;
    },
  },
  {
    name: 'a schedule',
    start: async (team) => {
      const r = await post('/api/heartbeats', {
        templateId: conferTemplate(), agentId: team[0], conferAgentIds: team, initialContext: 'JIRA EPIC: GRD-1712',
        schedule: { type: 'once' },
      });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.deepEqual(r.json.conferAgentIds, team, 'the schedule did not keep its team');
      const fired = fireHeartbeat(r.json.id);
      assert.ok('runId' in fired, JSON.stringify(fired));
      return (fired as { runId: string }).runId;
    },
  },
  {
    name: 'a Continue to Workflow step on a confer run',
    start: async (team) => {
      // A run that WAS a confer continuing into Confer: the team carries over.
      const parent = cloneTemplateAsRun(conferTemplate(), null, 'round one', { agentId: team[0], confer: { agentIds: team } })!;
      db.prepare(`UPDATE workflow_steps SET status = 'completed', completed_at = ? WHERE workflow_id = ?`).run(iso(), parent);
      const step = { id: `cont-${++n}`, workflowId: parent, executorConfig: { templateName: 'Confer' } };
      db.prepare(`UPDATE workflows SET name = 'Confer round one' WHERE id = ?`).run(parent);
      const out = continueIntoWorkflow(step);
      assert.equal(out.kind, 'launched');
      quiet(parent);
      return (out as { runId: string }).runId;
    },
  },
];

for (const p of PATHS) {
  test(`${p.name}: the confer starts with its whole team`, async () => {
    const team = [cartridge(`/tmp/ledger-${n}`), cartridge(`/tmp/frontdesk-${n}`)];
    const runId = await p.start(team);
    assert.deepEqual([...rosterOf(runId)].sort(), [...team].sort(), 'the confer step would start without its team');
    assert.ok(team.includes(scopeOwner(runId)), 'the one-cartridge steps have no cartridge from the team');
    quiet(runId);
  });
}

test('a Confer cannot be scheduled on one cartridge — refused while someone is watching', async () => {
  const a = cartridge('/tmp/solo-schedule');
  const r = await post('/api/heartbeats', { templateId: conferTemplate(), agentId: a, schedule: { type: 'daily', time: '09:00' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /two or more cartridges/);
});

test('a Continue step into Confer from a run that was not a confer fails loudly', () => {
  const a = cartridge('/tmp/solo-continue');
  const tpl = (db.prepare("SELECT id FROM workflows WHERE name = 'Bug Hunter' AND template_id IS NULL").get() as { id: string }).id;
  const parent = cloneTemplateAsRun(tpl, null, '', { agentId: a })!;
  db.prepare(`UPDATE workflow_steps SET status = 'completed', completed_at = ? WHERE workflow_id = ?`).run(iso(), parent);
  assert.throws(() => continueIntoWorkflow({ id: 'x', workflowId: parent, executorConfig: { templateName: 'Confer' } }), /needs two or more cartridges/);
  quiet(parent);
});

// ── The goal question, end to end ──────────────────────────────────────────────────────

/** A pilot in `staffing` with this pipeline, inserted directly — the planner conversation has its own suite. */
function stagedPilot(stages: { template: string; focus: string }[]): string {
  const goalId = `team-goal-${++n}`, pilotId = `team-pilot-${n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, status, created_at, updated_at) VALUES (?, 'Refunds', '', '', 'active', ?, ?)`).run(goalId, iso(), iso());
  const plan = {
    brief: { slug: 'refunds', summary: 'Refunds end to end.' },
    stages: stages.map((s, i) => ({ key: `s${i + 1}`, template: s.template, title: `Stage ${i + 1}`, why: '', focus: s.focus, optional: false })),
    criteria: [],
  };
  db.prepare(`INSERT INTO goal_pilots (id, goal_id, phase, plan, involvement, created_at, updated_at) VALUES (?, ?, 'staffing', ?, 'hands-off', ?, ?)`)
    .run(pilotId, goalId, JSON.stringify(plan), iso(), iso());
  return pilotId;
}

test('a Confer stage needs two or more repos — a one-repo pipeline is refused at staffing', async () => {
  const pilotId = stagedPilot([{ template: 'Confer', focus: 'JIRA EPIC: GRD-1712' }]);
  const r = await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: '/tmp/only-one', agentType: 'claude' }] });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /two or more repos/);
});

test('GOAL → Confer stage on a Jira epic → runs as a confer → when it finishes, the next stage starts', async () => {
  const ledger = '/tmp/goal-ledger', frontdesk = '/tmp/goal-frontdesk';
  const a = cartridge(ledger), b = cartridge(frontdesk);
  const pilotId = stagedPilot([
    { template: 'Confer', focus: 'JIRA EPIC: GRD-1712\nWork every task in the epic.' },
    { template: 'QA Testing Guide', focus: 'Refresh the guide for refunds.' },
  ]);
  const r = await post(`/api/goal-pilots/${pilotId}/start`, {
    repos: [{ repoPath: ledger, agentType: 'claude' }, { repoPath: frontdesk, agentType: 'claude' }],
    assignments: { s2: ledger },          // the Confer stage is not named: it takes every chosen repo
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  let [conferStage, next] = stagesOf(pilotId);
  assert.deepEqual(conferStage.participants.map((p) => p.repoPath).sort(), [frontdesk, ledger].sort());
  assert.equal(conferStage.status, 'running', `${conferStage.status}: ${conferStage.waitReason}`);
  assert.deepEqual([...rosterOf(conferStage.runId)].sort(), [a, b].sort(), 'the goal\'s confer stage has no team');
  const ctx = (db.prepare('SELECT initial_context FROM workflows WHERE id = ?').get(conferStage.runId) as { initial_context: string }).initial_context;
  assert.match(ctx, /JIRA EPIC: GRD-1712/, 'the Jira epic did not reach the Confer\'s Scope step');
  assert.equal(next.status, 'pending');

  // The confer run finishes (every task done) → the pipeline moves on by itself.
  db.prepare(`UPDATE workflow_steps SET status = 'completed', completed_at = ? WHERE workflow_id = ?`).run(iso(), conferStage.runId);
  db.prepare(`UPDATE workflows SET status = 'completed', completed_at = ? WHERE id = ?`).run(iso(), conferStage.runId);
  emitRunFinished(conferStage.runId, 'completed');
  sweepPilots();
  [conferStage, next] = stagesOf(pilotId);
  assert.equal(conferStage.status, 'completed');
  assert.equal(next.status, 'running', `the pipeline did not continue after the confer: ${next.status} ${next.waitReason}`);
  assert.equal(next.agentId, a, 'the next stage is not on the repo it was assigned');
  quiet(next.runId);
});

test('a Confer stage waits while any of its cartridges is missing, and starts when all are there', async () => {
  const r1 = '/tmp/wait-one', r2 = '/tmp/wait-two';
  cartridge(r1);
  const pilotId = stagedPilot([{ template: 'Confer', focus: 'T' }]);
  const r = await post(`/api/goal-pilots/${pilotId}/start`, {
    repos: [{ repoPath: r1, agentType: 'claude' }, { repoPath: r2, agentType: 'claude' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let [s] = stagesOf(pilotId);
  assert.equal(s.status, 'waiting');
  assert.match(s.waitReason, /No Claude Code cartridge is running in wait-two|No .* cartridge is running in wait-two/);
  cartridge(r2);
  sweepPilots();
  [s] = stagesOf(pilotId);
  assert.equal(s.status, 'running', s.waitReason);
  assert.equal(rosterOf(s.runId).length, 2);
  quiet(s.runId);
});
