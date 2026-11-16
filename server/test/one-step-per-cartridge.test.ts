// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { startWorkflowApp, stepsOf, verified, type WorkflowApp, type StepRow } from './helpers/workflow-app.ts';

/**
 * ONE STEP AT A TIME PER CARTRIDGE.
 *
 * The executor dispatched every ready step of a stage at once. With the default of one cartridge
 * per run, a "parallel" stage sent N prompts to the same relay, which wrote each as a bracketed
 * paste followed by a delayed Enter — so all N landed in the input box before the first Enter and
 * reached the agent as ONE message. Verified in the sandbox on CE: Phase 2: three plan reviews
 * injected within 3 ms arrived as a single 6,984-char message; one step was answered, two stayed
 * `running` with nothing left to answer them.
 *
 * And a step sent to a cartridge parked on a question was consumed as the ANSWER to it.
 *
 * The rule: a step is dispatched to a cartridge only when that cartridge has no other step running
 * (in any run) and no pending question; otherwise it waits, and says what it is waiting for.
 * SET-BASED over every seeded template with a parallel stage; plus the two cases the rule must
 * not break — separate cartridges still run in parallel, and nothing waits on nothing.
 */

let app: WorkflowApp;
before(async () => { app = await startWorkflowApp('one-step-agent'); });
after(() => app.close());

const AGENT_TYPES = new Set(['claude-code', 'command', 'quality-gate', 'review-gate']);

/** Templates with a stage of two or more agent steps sharing the same dependencies. */
function templatesWithParallelStages(): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const t of db.prepare('SELECT id, name FROM workflows WHERE template_id IS NULL').all() as Array<{ id: string; name: string }>) {
    const steps = stepsOf(t.id).filter((s) => AGENT_TYPES.has(s.executor_type));
    const byDeps = new Map<string, number>();
    for (const s of steps) {
      const key = JSON.stringify(JSON.parse(s.depends_on).sort());
      byDeps.set(key, (byDeps.get(key) ?? 0) + 1);
    }
    if ([...byDeps.values()].some((n) => n >= 2)) out.push(t);
  }
  return out;
}

/** Answer every running step through the webhook, one pass at a time, recording concurrency. */
async function drive(runId: string, agents: string[]): Promise<{ maxRunningPerAgent: number; status: string; dispatchedTogether: number }> {
  let maxRunningPerAgent = 0;
  let dispatchedTogether = 0;
  for (let guard = 0; guard < 200; guard++) {
    tickWorkflowsOnce();
    await new Promise((r) => setImmediate(r));
    const all = stepsOf(runId);
    const running = all.filter((s) => s.status === 'running' && AGENT_TYPES.has(s.executor_type));
    for (const a of agents) {
      const n = running.filter((s) => (s as StepRow & { executor_id: string }).executor_id === a).length;
      maxRunningPerAgent = Math.max(maxRunningPerAgent, n);
    }
    dispatchedTogether = Math.max(dispatchedTogether, running.length);
    const wf = db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string };
    if (wf.status !== 'running') return { maxRunningPerAgent, status: wf.status, dispatchedTogether };
    for (const s of all.filter((x) => x.status === 'completed' && !x.auto_advance)) {
      await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/advance`, {});
    }
    for (const s of all.filter((x) => x.status === 'running' && x.executor_type === 'decision')) {
      const cfg = JSON.parse(s.executor_config);
      await app.post(`/api/workflows/v2/${runId}/steps/${s.id}/decide`, { optionId: cfg.options[0].id });
    }
    for (const s of running) {
      const gate = s.executor_type.endsWith('gate');
      const cfg = JSON.parse(s.executor_config);
      const needsCount = all.some((x) => JSON.parse(x.executor_config).loopCountFrom?.step === s.name);
      const result = gate ? 'PASS\nok' : `${s.name} done${needsCount ? '\nTASKS: 2\nTASKS_A: 2\nTASKS_B: 2' : ''}${cfg.loopCountFrom ? `\nDONE T-${Number(cfg._currentLoop) || 1} · ${2 - (Number(cfg._currentLoop) || 1)} remaining` : ''}`;
      await app.post(`/api/workflows/webhook/${s.id}/complete`, gate ? { result } : verified(result));
    }
  }
  return { maxRunningPerAgent, status: 'stuck', dispatchedTogether };
}

test('the set of templates with a parallel stage is not empty', () => {
  assert.ok(templatesWithParallelStages().length >= 5, templatesWithParallelStages().map((t) => t.name).join(', '));
});

test('on one cartridge, no template ever has two steps in flight — and every run still completes', async () => {
  const wrong: string[] = [];
  for (const t of templatesWithParallelStages()) {
    const start = await app.post(`/api/workflows/v2/${t.id}/start`, { agentId: app.agent, initialContext: 'x' });
    assert.equal(start.status, 200, `${t.name}: ${JSON.stringify(start.json)}`);
    const r = await drive(start.json.workflow.id, [app.agent]);
    if (r.maxRunningPerAgent > 1) wrong.push(`${t.name}: ${r.maxRunningPerAgent} steps running at once on one cartridge`);
    if (r.status !== 'completed') wrong.push(`${t.name}: ended ${r.status}`);
  }
  assert.deepEqual(wrong, []);
});

test('steps assigned to different cartridges still run in parallel', async () => {
  const second = 'one-step-agent-2';
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, 'box/app-repo-2', 'box', '/tmp/app-repo-2', 'app-repo-2', 'idle', ?, 'sess-2', 'claude')`).run(second, new Date().toISOString());
  const created = await app.post('/api/workflows/v2/create', {
    name: 'two cartridges', skipStandardGate: true, skipReportStep: true,
    steps: [
      { id: 'a', name: 'Left', executorConfig: { prompt: 'Left half.' } },
      { id: 'b', name: 'Right', executorConfig: { prompt: 'Right half.' } },
    ],
  });
  const tpl = stepsOf(created.json.workflow.id);
  const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, {
    agentOverrides: { [tpl.find((s) => s.name === 'Left')!.id]: app.agent, [tpl.find((s) => s.name === 'Right')!.id]: second },
  });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  tickWorkflowsOnce();
  const running = stepsOf(start.json.workflow.id).filter((s) => s.status === 'running').map((s) => s.name).sort();
  // Right's cartridge has no relay in this test, so it may fail delivery; what matters is that
  // it was DISPATCHED in the same pass, not held behind Left.
  const dispatched = stepsOf(start.json.workflow.id).filter((s) => s.status !== 'pending').map((s) => s.name).sort();
  assert.deepEqual(dispatched, ['Left', 'Right'], `running: ${running.join(', ')}`);
  // Left is still running on the shared cartridge; end the run so it does not hold later tests.
  db.prepare(`UPDATE workflows SET status = 'cancelled' WHERE id = ?`).run(start.json.workflow.id);
});

test('a cartridge waiting on a question gets no step until the question is answered', async () => {
  const created = await app.post('/api/workflows/v2/create', {
    name: 'question', skipStandardGate: true, skipReportStep: true,
    steps: [{ id: 'q', name: 'Only', executorConfig: { prompt: 'Do it.' } }],
  });
  db.prepare(`UPDATE agents SET status = 'waiting', pending_question = 'Which option: A or B?' WHERE id = ?`).run(app.agent);
  try {
    const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent, queueIfBusy: false });
    const runId = start.json.workflow.id as string;
    tickWorkflowsOnce();
    assert.equal(stepsOf(runId)[0].status, 'pending', 'the step was typed into an open question');
    const log = db.prepare(`SELECT message FROM workflow_journal WHERE workflow_id = ?`).all(runId) as { message: string }[];
    assert.ok(log.some((l) => /waiting for .*question/i.test(l.message)), log.map((l) => l.message).join('\n'));
    db.prepare(`UPDATE agents SET status = 'idle', pending_question = '' WHERE id = ?`).run(app.agent);
    tickWorkflowsOnce();
    assert.equal(stepsOf(runId)[0].status, 'running', 'the step never started after the question was answered');
  } finally {
    db.prepare(`UPDATE agents SET status = 'idle', pending_question = '' WHERE id = ?`).run(app.agent);
  }
});

test('a cartridge parked on a permission prompt gets no step until it is decided — a stale "waiting" alone holds nothing', async () => {
  const created = await app.post('/api/workflows/v2/create', {
    name: 'permission', skipStandardGate: true, skipReportStep: true,
    steps: [{ id: 'q', name: 'Only', executorConfig: { prompt: 'Do it.' } }],
  });
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  const now = new Date().toISOString();
  // A permission is open: the cartridge's terminal is showing a permission prompt.
  db.prepare(`UPDATE agents SET status = 'waiting', pending_question = '' WHERE id = ?`).run(app.agent);
  db.prepare(`INSERT INTO permissions (id, agent_id, tool_name, status, created_at) VALUES ('perm-1', ?, 'Bash', 'pending', ?)`).run(app.agent, now);
  try {
    const start = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent, queueIfBusy: false });
    const runId = start.json.workflow.id as string;
    tickWorkflowsOnce();
    assert.equal(stepsOf(runId)[0].status, 'pending', 'the step was typed into an open permission prompt');
    const log = db.prepare(`SELECT message FROM workflow_journal WHERE workflow_id = ?`).all(runId) as { message: string }[];
    assert.ok(log.some((l) => /permission/i.test(l.message)), log.map((l) => l.message).join('\n'));
    // Decided — but the status has not caught up yet. A stale "waiting" must not hold the step.
    db.prepare(`UPDATE permissions SET status = 'allowed' WHERE id = 'perm-1'`).run();
    tickWorkflowsOnce();
    assert.equal(stepsOf(runId)[0].status, 'running', 'a stale waiting status held the step');
  } finally {
    db.prepare(`UPDATE agents SET status = 'idle', pending_question = '' WHERE id = ?`).run(app.agent);
  }
});
