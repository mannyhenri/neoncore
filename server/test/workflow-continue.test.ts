/**
 * CE: PHASE 3 CONTINUES INTO PHASE 4 — the `launch-workflow` connector.
 *
 * Phase 3's description said "Auto-continues to Phase 4" while the run ended on a notification:
 * no connector could start another workflow. It can now (lib/workflow-continue.ts). What must
 * hold, each asserted below:
 *   - it continues ONLY when Build Summary passed — a failed build must not go on to open a PR;
 *   - the next run is on the same project and cartridge, with the same posture and launch
 *     context (the slug), and not with this template's learnings;
 *   - it starts the next run ONCE, however often the step is re-executed;
 *   - a missing template, a self-loop or a run with no cartridge fails loudly.
 * The first test drives the REAL seeded CE: Phase 3 template through the executor.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { tickWorkflowsOnce, executorSettled } from '../src/lib/workflow-executor-v2.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { continueIntoWorkflow } from '../src/lib/workflow-continue.ts';

const io = installStubIO();
const iso = () => new Date().toISOString();
let n = 0;

const templateId = (name: string) =>
  (db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').get(name) as { id: string }).id;

function agent(): string {
  const id = `cont-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
              VALUES (?,?,'box','/tmp/cont-repo','cont-repo','claude','idle',?,?)`).run(id, id, iso(), `s-${id}`);
  io.connect(id);
  return id;
}

function project(): string {
  const id = `cont-proj-${++n}`;
  db.prepare(`INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)`).run(id, id, iso(), iso());
  return id;
}

const steps = (runId: string) => db.prepare(
  'SELECT id, name, status, result, executor_type, executor_id, executor_config FROM workflow_steps WHERE workflow_id = ?',
).all(runId) as { id: string; name: string; status: string; result: string; executor_type: string; executor_id: string; executor_config: string }[];

const runsOf = (tplName: string) => db.prepare(
  'SELECT id, project_id, initial_context, autonomy FROM workflows WHERE template_id = ?',
).all(templateId(tplName)) as { id: string; project_id: string | null; initial_context: string; autonomy: string }[];

/** Clone CE: Phase 3 and mark everything before the continue connector done, as a run would. */
function phase3ReadyToContinue(buildSummary: string) {
  const a = agent(), p = project();
  const runId = cloneTemplateAsRun(templateId('CE: Phase 3 — Implement'), p, 'Feature slug: user-auth-v2', { agentId: a, autonomy: 'auto' })!;
  for (const s of steps(runId)) {
    if (s.name === 'Continue to Phase 4' || s.name === 'Workflow Completion Report') continue;
    db.prepare(`UPDATE workflow_steps SET status = 'completed', completed_at = ?, result = ? WHERE id = ?`)
      .run(iso(), s.name === 'Build Summary' ? buildSummary : `${s.name} done`, s.id);
  }
  return { runId, agentId: a, projectId: p };
}

test('the real CE: Phase 3 template starts Phase 4 when Build Summary passed — same project, cartridge, slug', async () => {
  const before = runsOf('CE: Phase 4 — Review').length;
  const { runId, agentId, projectId } = phase3ReadyToContinue('STATUS: PASS — ready for Phase 4\nTests: 42 passing');

  tickWorkflowsOnce();
  await executorSettled();

  const cont = steps(runId).find((s) => s.name === 'Continue to Phase 4')!;
  assert.equal(cont.status, 'completed', `the continue step did not run: ${cont.status}`);
  assert.match(cont.result, /^Continued into "CE: Phase 4 — Review" — run /);

  const phase4 = runsOf('CE: Phase 4 — Review');
  assert.equal(phase4.length, before + 1, 'no Phase 4 run was started');
  const next = phase4.find((r) => cont.result.endsWith(r.id))!;
  assert.ok(next, 'the step names a run that does not exist');
  assert.equal(next.project_id, projectId, 'Phase 4 left the project');
  assert.equal(next.autonomy, 'auto', 'Phase 4 lost the posture the run was launched in');
  assert.match(next.initial_context, /^Feature slug: user-auth-v2/, 'Phase 4 lost the slug every CE phase reads');
  assert.match(next.initial_context, /Continued from "CE: Phase 3 — Implement"/);
  const deferred = steps(next.id).filter((s) => s.executor_id === '__deferred__');
  assert.deepEqual(deferred.map((s) => s.name), [], 'Phase 4 steps were left without a cartridge');
  assert.ok(steps(next.id).some((s) => s.executor_id === agentId), 'Phase 4 is not on the cartridge Phase 3 used');
});

test('a build that did not pass does NOT start Phase 4, and the step says why', async () => {
  const before = runsOf('CE: Phase 4 — Review').length;
  const { runId } = phase3ReadyToContinue('STATUS: FAIL — 3 type errors, resolve before continuing');

  tickWorkflowsOnce();
  await executorSettled();

  const cont = steps(runId).find((s) => s.name === 'Continue to Phase 4')!;
  assert.equal(cont.status, 'completed', 'not continuing is not a failure of the run');
  assert.match(cont.result, /Not continued: "Build Summary" did not report "STATUS: PASS"/);
  assert.equal(runsOf('CE: Phase 4 — Review').length, before, 'Phase 4 started on a failed build');
});

test('the next run is started ONCE, however often the step is executed', () => {
  const { runId } = phase3ReadyToContinue('STATUS: PASS');
  const row = steps(runId).find((s) => s.name === 'Continue to Phase 4')!;
  const load = () => {
    const r = db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ?').get(row.id) as { executor_config: string };
    return { id: row.id, workflowId: runId, executorConfig: JSON.parse(r.executor_config) };
  };
  const first = continueIntoWorkflow(load());
  const second = continueIntoWorkflow(load());
  assert.equal(first.kind, 'launched');
  assert.equal(second.kind, 'launched');
  assert.equal((second as { runId: string }).runId, (first as { runId: string }).runId);
  assert.equal((second as { alreadyLaunched: boolean }).alreadyLaunched, true);
});

test('this template\'s learnings are not carried into the next phase', () => {
  const { runId, projectId } = phase3ReadyToContinue('STATUS: PASS');
  // A Phase 3 learning, injected into THIS run's context the way cloneTemplateAsRun does.
  db.prepare('UPDATE workflows SET initial_context = ? WHERE id = ?')
    .run('Feature slug: user-auth-v2\n\n## What previous runs of this workflow learned\n\n### 1. worktree path was wrong', runId);
  const row = steps(runId).find((s) => s.name === 'Continue to Phase 4')!;
  const out = continueIntoWorkflow({ id: row.id, workflowId: runId, executorConfig: JSON.parse(row.executor_config) });
  assert.equal(out.kind, 'launched');
  const ctx = (db.prepare('SELECT initial_context FROM workflows WHERE id = ?').get((out as { runId: string }).runId) as { initial_context: string }).initial_context;
  assert.ok(!ctx.includes('worktree path was wrong'), 'Phase 3\'s learnings were handed to Phase 4');
  assert.ok(ctx.startsWith('Feature slug: user-auth-v2'));
  void projectId;
});

test('it fails loudly rather than starting nothing: unknown template, itself, or no cartridge', () => {
  const { runId } = phase3ReadyToContinue('STATUS: PASS');
  const row = steps(runId).find((s) => s.name === 'Continue to Phase 4')!;
  const withCfg = (extra: Record<string, unknown>) =>
    ({ id: row.id, workflowId: runId, executorConfig: { ...JSON.parse(row.executor_config), ...extra } });

  assert.throws(() => continueIntoWorkflow(withCfg({ templateName: 'No Such Workflow' })), /no "No Such Workflow" workflow template/);
  assert.throws(() => continueIntoWorkflow(withCfg({ templateName: 'CE: Phase 3 — Implement' })), /cannot continue into itself/);
  assert.throws(() => continueIntoWorkflow(withCfg({ templateName: '' })), /requires templateName/);

  db.prepare(`UPDATE workflow_steps SET executor_id = '' WHERE workflow_id = ?`).run(runId);
  assert.throws(() => continueIntoWorkflow(withCfg({})), /no cartridge/);
});

test('inside a Goal Pilot the pilot decides what runs next — Phase 3 does not start a Phase 4 it never planned', () => {
  const { runId } = phase3ReadyToContinue('STATUS: PASS');
  const now = iso();
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, status, created_at, updated_at)
              VALUES ('cont-goal', 'Refunds', '', '', 'active', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO goal_pilots (id, goal_id, created_at, updated_at) VALUES ('cont-pilot', 'cont-goal', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO goal_pilot_stages (id, pilot_id, position, template_name, run_id, status, started_at)
              VALUES ('cont-stage', 'cont-pilot', 0, 'CE: Phase 3 — Implement', ?, 'running', ?)`).run(runId, now);

  const before = runsOf('CE: Phase 4 — Review').length;
  const row = steps(runId).find((s) => s.name === 'Continue to Phase 4')!;
  const out = continueIntoWorkflow({ id: row.id, workflowId: runId, executorConfig: JSON.parse(row.executor_config) });
  assert.equal(out.kind, 'skipped');
  assert.match((out as { reason: string }).reason, /Goal Pilot stage/);
  assert.equal(runsOf('CE: Phase 4 — Review').length, before, 'a Phase 4 the pilot never planned was started');
});
