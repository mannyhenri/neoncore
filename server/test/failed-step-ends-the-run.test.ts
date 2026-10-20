/**
 * A RUN WITH NOTHING LEFT IT CAN DO IS OVER.
 *
 * Reported as: "run 86 is stalled again". Run 86 (Epic: Task by Task, GRD-4453) finished all
 * three confers, then its Work Standard Check failed with retries exhausted at 04:50. The run
 * stayed `running` for 3h+ with "Workflow Completion Report" pending: a step whose dependency
 * FAILED can never become ready, a run only finishes when every step is terminal, so nothing
 * would ever finish it — and nothing told the user it had stopped.
 *
 * Only gates flagged `terminalOnFail` ended the run. Every other way a step fails left the same
 * hang. SET-BASED over those ways: a quality gate that exhausts its retries, and an ordinary
 * step that fails. And the rule must not end a run early: a failed branch strands only its
 * own dependents, while an independent branch is still working the run stays open.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';

installStubIO();
const iso = () => new Date().toISOString();
let n = 0;

type S = { name: string; type: string; status: string; deps?: string[]; error?: string };

function run(steps: S[]): { runId: string; id: (name: string) => string } {
  const i = ++n;
  const runId = `fs-run-${i}`;
  const id = (name: string) => `fs-${i}-${name.replace(/\W+/g, '-')}`;
  db.prepare(
    `INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number)
     VALUES (?,'Epic: Task by Task','','running','[]',?,?,'tpl',86)`,
  ).run(runId, iso(), iso());
  steps.forEach((s, k) => db.prepare(
    `INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,executor_type,executor_id,
       executor_config,auto_advance,depends_on,created_at,status,error,completed_at)
     VALUES (?,?,?,'',300,?,?,'a','{}',1,?,?,?,?,?)`,
  ).run(id(s.name), runId, s.name, 50 + k * 175, s.type, JSON.stringify((s.deps ?? []).map(id)), iso(), s.status,
    s.error ?? '', ['completed', 'failed', 'skipped'].includes(s.status) ? iso() : null));
  return { runId, id };
}

const runStatus = (id: string) => (db.prepare('SELECT status, error FROM workflows WHERE id = ?').get(id) as { status: string; error: string });
const stepRow = (id: string) => db.prepare('SELECT status, error FROM workflow_steps WHERE id = ?').get(id) as { status: string; error: string };

const FAILURES: Array<[string, S]> = [
  ['a quality gate that exhausted its retries', { name: 'Work Standard Check', type: 'quality-gate', status: 'failed', deps: ['Notify'], error: 'Quality gate [Work Standard] failed after 1 retries' }],
  ['an ordinary step that failed', { name: 'Work Standard Check', type: 'claude-code', status: 'failed', deps: ['Notify'], error: 'Command not delivered' }],
];

for (const [label, failed] of FAILURES) {
  test(`${label}: the run ends as failed and its stranded steps are skipped, saying why`, () => {
    const { runId, id } = run([
      { name: 'Verify Coverage', type: 'confer', status: 'completed' },
      { name: 'Notify', type: 'connector', status: 'completed', deps: ['Verify Coverage'] },
      failed,
      { name: 'Workflow Completion Report', type: 'claude-code', status: 'pending', deps: ['Work Standard Check'] },
    ]);

    tickWorkflowsOnce();

    assert.equal(runStatus(runId).status, 'failed', 'the run is still "running" with nothing left that can run');
    const report = stepRow(id('Workflow Completion Report'));
    assert.equal(report.status, 'skipped', 'the step behind the failure is left pending forever');
    assert.match(report.error, /Work Standard Check/, 'the skipped step does not say which failure stranded it');
  });
}

test('a chain behind a failure is skipped all the way down', () => {
  const { runId, id } = run([
    { name: 'Build', type: 'claude-code', status: 'failed', error: 'boom' },
    { name: 'Test', type: 'claude-code', status: 'pending', deps: ['Build'] },
    { name: 'Report', type: 'claude-code', status: 'pending', deps: ['Test'] },
  ]);
  tickWorkflowsOnce();
  assert.equal(runStatus(runId).status, 'failed');
  assert.deepEqual([stepRow(id('Test')).status, stepRow(id('Report')).status], ['skipped', 'skipped']);
});

test('while an independent branch is still working, the run stays open', () => {
  const { runId, id } = run([
    { name: 'Branch A', type: 'claude-code', status: 'failed', error: 'boom' },
    { name: 'After A', type: 'claude-code', status: 'pending', deps: ['Branch A'] },
    { name: 'Branch B', type: 'claude-code', status: 'running' },
  ]);
  tickWorkflowsOnce();
  assert.equal(runStatus(runId).status, 'running', 'ended the run while another branch was still working');
  assert.equal(stepRow(id('After A')).status, 'pending', 'judged a step stranded while the run could still change');
});

test('a skipped dependency still lets work continue — only a FAILED one strands', () => {
  const { runId, id } = run([
    { name: 'Optional', type: 'claude-code', status: 'skipped' },
    { name: 'Next', type: 'connector', status: 'pending', deps: ['Optional'] },
  ]);
  tickWorkflowsOnce();
  assert.notEqual(stepRow(id('Next')).status, 'skipped', 'a skipped dependency was treated as a failure');
  assert.notEqual(runStatus(runId).status, 'failed');
});
