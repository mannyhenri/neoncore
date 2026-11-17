/**
 * A TASK-LIST RUN IS NOT FINISHED UNTIL EVERY TASK IS — lib/coverage-loop.ts.
 *
 * The rule, then the real Epic: Task by Task template driven through the completion WEBHOOK the
 * way an agent reports, because two of the promises live there:
 *   - a coverage step that does not report COVERAGE is refused on the spot, with the exact line
 *     it owes (not discovered later as a run holding over a missing line);
 *   - tasks open → the work loop runs again, once per task LEFT, and is told which they are.
 * Confer's version of the same loop is in confer-epic-loop.test.ts.
 */
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { decideCoverage, holdDetail, MAX_COVERAGE_PASSES, countsOwed, COVERAGE_PATTERN } from '../src/lib/coverage-loop.ts';
import { parseCoverage } from '../src/lib/run-progress.ts';
import { tickWorkflowsOnce, executorSettled } from '../src/lib/workflow-executor-v2.ts';
import { startWorkflowApp, stepsOf, verified, type WorkflowApp } from './helpers/workflow-app.ts';

const cfg = { retryFrom: ['Work Every Task'] };
const cov = (done: number, total: number) => ({ done, total, outstanding: [] });

// ── The rule ──────────────────────────────────────────────────────────────────────────

test('every task done → the run goes on; nothing to do counts as done', () => {
  assert.deepEqual(decideCoverage(cov(23, 23), undefined, 0, cfg), { action: 'complete' });
  assert.deepEqual(decideCoverage(cov(0, 0), undefined, 0, cfg), { action: 'complete' });
});

test('tasks open and still progressing → back to the work, sized to what is left', () => {
  assert.deepEqual(decideCoverage(cov(18, 23), undefined, 0, cfg), { action: 'loop-back', remaining: 5 });
  assert.deepEqual(decideCoverage(cov(21, 23), 18, 1, cfg), { action: 'loop-back', remaining: 2 });
});

test('it never loops forever: no progress, no count, or the pass limit → hold for a person', () => {
  assert.equal(decideCoverage(cov(18, 23), 18, 1, cfg).action, 'hold');
  assert.equal(decideCoverage(cov(17, 23), 18, 1, cfg).action, 'hold', 'going backwards is not progress');
  assert.equal(decideCoverage(null, undefined, 0, cfg).action, 'hold', 'an unreadable count is not "complete"');
  assert.equal(decideCoverage(cov(22, 23), 21, MAX_COVERAGE_PASSES, cfg).action, 'hold');
  assert.equal(decideCoverage(cov(22, 23), 21, 2, { ...cfg, maxPasses: 2 }).action, 'hold');
});

test('the hold says how many are open and why, in words a person can act on', () => {
  assert.equal(holdDetail('Verify Coverage', cov(18, 23), 'the last pass finished nothing more'),
    '5 of 23 task(s) are still open after "Verify Coverage" — the last pass finished nothing more. Keep working, or accept the run as it is.');
});

test('COVERAGE is read wherever the agent put it, in every shape the templates ask for', () => {
  for (const [text, done, total] of [
    ['COVERAGE: 18/23 done · 2 skipped · 3 blocked · 0 outstanding', 18, 23],
    ['NEXT: go\n\n**COVERAGE: 3/3** · 0 never claimed', 3, 3],
    ['SUITE: pass\nCOVERAGE: 4 / 9 across both repos', 4, 9],
  ] as const) {
    const c = parseCoverage(text);
    assert.deepEqual([c?.done, c?.total], [done, total], text);
  }
  assert.equal(parseCoverage('All done!'), null);
  const c = parseCoverage('COVERAGE: 1/3\n\nOUTSTANDING (if any) — one line each, with why:\n- T-2 Login — blocked by T-1\n- T-3 Logout — never attempted\n');
  assert.deepEqual(c?.outstanding, ['T-2 Login — blocked by T-1', 'T-3 Logout — never attempted']);
});

test('a coverage step owes its own COVERAGE line — the same pattern the engine reads', () => {
  const owed = countsOwed({ name: 'Verify Coverage', config: { coverage: cfg } }, []);
  assert.deepEqual(owed.map((o) => o.pattern), [COVERAGE_PATTERN]);
  assert.deepEqual(countsOwed({ name: 'Notify', config: {} }, []), []);
  assert.ok(new RegExp(COVERAGE_PATTERN).test('COVERAGE: 3/3'));
});

// ── Epic: Task by Task, through the webhook ─────────────────────────────────────────

let app: WorkflowApp;
before(async () => { app = await startWorkflowApp('coverage-agent'); });
after(() => app.close());

const named = (runId: string, name: string) => stepsOf(runId).find((s) => s.name === name)!;
const settle = async () => { await executorSettled(); for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5)); };

async function epicRunAtVerify(): Promise<string> {
  const tpl = (db.prepare("SELECT id FROM workflows WHERE name = 'Epic: Task by Task' AND template_id IS NULL").get() as { id: string }).id;
  const start = await app.post(`/api/workflows/v2/${tpl}/start`, { agentId: app.agent, initialContext: 'docs/plans/EPIC-refunds.md' });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const runId = start.json.workflow.id as string;
  const now = new Date().toISOString();
  db.prepare(`UPDATE workflow_steps SET status = 'completed', completed_at = ?, result = ? WHERE id = ?`)
    .run(now, 'EPIC: docs/plans/EPIC-refunds.md\nPROGRESS: /tmp/app-repo/docs/progress/EPIC-refunds.md\nTASKS: 3', named(runId, 'Load Epic').id);
  db.prepare(`UPDATE workflow_steps SET status = 'completed', completed_at = ?, result = 'DONE R-1 · 2 remaining' WHERE id = ?`)
    .run(now, named(runId, 'Work Every Task').id);
  db.prepare(`UPDATE workflow_steps SET status = 'running', started_at = ?, dispatched_prompt = 'verify' WHERE id = ?`)
    .run(now, named(runId, 'Verify Coverage').id);
  return runId;
}

test('a coverage report with no COVERAGE line is REFUSED, naming the line it owes', async () => {
  const runId = await epicRunAtVerify();
  const res = await app.post(`/api/workflows/webhook/${named(runId, 'Verify Coverage').id}/complete`, verified('Looks good to me, all done.'));
  assert.equal(res.status, 400, 'a coverage step finished without saying how many tasks are done');
  assert.match(JSON.stringify(res.json), /COVERAGE/);
  assert.equal(named(runId, 'Verify Coverage').status, 'running', 'the refused report completed the step anyway');
  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);
});

test('tasks open: the work loop runs again, once per task LEFT, told which ones', async () => {
  const runId = await epicRunAtVerify();
  const res = await app.post(`/api/workflows/webhook/${named(runId, 'Verify Coverage').id}/complete`, verified(
    'COVERAGE: 1/3 done · 0 skipped · 1 blocked · 1 outstanding\n\nOUTSTANDING (if any) — one line each, with why:\n- R-2 Refund screen — blocked: suite red\n- R-3 Refund email — never attempted'));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  tickWorkflowsOnce();
  await settle();

  const work = named(runId, 'Work Every Task');
  assert.ok(['pending', 'running'].includes(work.status), `the work loop did not run again (${work.status})`);
  const wcfg = JSON.parse(work.executor_config);
  assert.equal(wcfg._resolvedLoopCount, 2, 'the loop was not sized to the 2 tasks left');
  assert.match(String(wcfg._routingFeedback), /R-3 Refund email/, 'the work step is not told which tasks are open');
  assert.equal(named(runId, 'Work Standard Check').status, 'pending', 'the run went on with tasks open');

  // The engine's own record of it.
  const events = db.prepare("SELECT verdict, done, total FROM run_progress WHERE workflow_id = ? AND kind = 'coverage'").all(runId);
  assert.deepEqual(events, [{ verdict: 'loop-back', done: 1, total: 3 }]);
  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);
});
