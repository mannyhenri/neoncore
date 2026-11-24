/**
 * A RUN'S STEP SUMMARY NAMES WHO IS RUNNING ITS STEPS — so the run card can say "Running in
 * background: G3 suite · 12 min" instead of looking stalled (docs/plans/epic-qa-any-project.md,
 * part 6; deferred by the dashboard track because the summary did not name the agent).
 *
 * SET — every producer of a stepSummary: GET /api/workflows, GET /api/workflows/v2/:id/runs and the
 * `workflow_updated` socket emit. They used to be two copies of the same code (routes/workflows.ts
 * buildStepSummary and an inline copy in workflow-executor-v2.ts emitWorkflowUpdate); there is now
 * one, lib/step-summary.ts, and this file checks both that it is right and that nobody re-copies it.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db from '../src/db.js';
import { buildStepSummary } from '../src/lib/step-summary.js';
import workflowsRouter from '../src/routes/workflows.js';

let n = 0;
function run(steps: { status: string; executorId?: string; dispatchAgentId?: string }[]): string {
  const tpl = `ss-tpl-${++n}`;
  const id = `ss-run-${n}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, 'pending', ?)`).run(tpl, `T${n}`, now);
  db.prepare(`INSERT INTO workflows (id, name, status, created_at, template_id, run_number) VALUES (?, ?, 'running', ?, ?, 1)`).run(id, `R${n}`, now, tpl);
  steps.forEach((s, i) => {
    db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, executor_type, executor_id, status, created_at, dispatch_agent_id)
                VALUES (?, ?, ?, 'claude-code', ?, ?, ?, ?)`)
      .run(`${id}-s${i}`, id, `Step ${i}`, s.executorId ?? '', s.status, now, s.dispatchAgentId ?? '');
  });
  return id;
}

test('runningAgentIds: the agent of every RUNNING step — dispatch agent first, else executor; never deferred, never other states', () => {
  const id = run([
    { status: 'running', executorId: 'tpl-agent', dispatchAgentId: 'dispatched-agent' },
    { status: 'running', executorId: 'exec-agent' },
    { status: 'running', executorId: '__deferred__' },
    { status: 'completed', executorId: 'done-agent' },
    { status: 'pending', executorId: 'later-agent' },
    { status: 'failed', executorId: 'failed-agent' },
    { status: 'running', executorId: 'exec-agent' },
  ]);
  const s = buildStepSummary(id)!;
  assert.deepEqual([...s.runningAgentIds].sort(), ['dispatched-agent', 'exec-agent']);
  assert.equal(s.running, 4);
  assert.equal(s.total, 7);
});

test('a run with no steps has no summary', () => {
  db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES ('ss-empty', 'E', 'running', ?)`).run(new Date().toISOString());
  assert.equal(buildStepSummary('ss-empty'), null);
});

test('every HTTP producer carries runningAgentIds', async () => {
  const id = run([{ status: 'running', executorId: 'http-agent' }]);
  const tpl = (db.prepare('SELECT template_id FROM workflows WHERE id = ?').get(id) as { template_id: string }).template_id;
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', workflowsRouter);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflows`;
    for (const url of [`${base}?runs=true`, `${base}/v2/${tpl}/runs`]) {
      const list = await (await fetch(url)).json() as { id: string; stepSummary?: { runningAgentIds?: string[] } }[];
      const wf = list.find((w) => w.id === id);
      assert.deepEqual(wf?.stepSummary?.runningAgentIds, ['http-agent'], url);
    }
  } finally {
    server.close();
  }
});

test('one implementation: the routes and the socket emit use lib/step-summary.ts, not a copy', () => {
  for (const file of ['../src/routes/workflows.ts', '../src/lib/workflow-executor-v2.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /from '\.\.?\/(lib\/)?step-summary\.js'/, `${file} imports buildStepSummary`);
    assert.doesNotMatch(src, /completed: stepRows\.filter/, `${file} has no copy of the summary`);
  }
});
