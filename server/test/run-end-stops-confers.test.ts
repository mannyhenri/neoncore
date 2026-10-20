/**
 * ENDING A RUN ENDS THE CONFERS IT STARTED.
 *
 * Reported as "make sure gl-dev-lane-c and gridlight-manager are working together on run 80".
 * They weren't. Run 79 had been cancelled 30s after its "Load Epic" confer started, but
 * cancelling a run only flipped `workflows.status`. The confer it owned (422d7775) kept
 * dispatching milestones, both cartridges kept working on it, and run 80's own confer waited
 * behind them as "busy". Run 78 had left one behind the same way.
 *
 * SET-BASED over every way a run can be ended early by hand (cancel, delete), and over every
 * confer a run can own: each RUNNING confer owned by the run must end, a FINISHED one must be
 * left as it was, and a confer owned by ANOTHER run must not be touched.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import workflowsRouter from '../src/routes/workflows.ts';

installStubIO();
const iso = () => new Date().toISOString();

function confer(status: string): string {
  const id = `rec-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO confer_sessions (id, repo_name, repo_path, task, participant_ids, status,
       current_milestone, error, created_at, mode, isolation, build_rounds)
     VALUES (?, 'r', '/tmp/r', 't', '["pa","pb"]', ?, 0, '', ?, 'collaborate', 'shared', 1)`,
  ).run(id, status, iso());
  return id;
}

/** A running run with one confer step per session, the shape the executor writes. */
function runOwning(sessionIds: string[]): string {
  const runId = `rec-run-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO workflows (id, name, status, run_number, template_id, created_at)
     VALUES (?, 'Epic', 'running', 1, 'tpl', ?)`,
  ).run(runId, iso());
  sessionIds.forEach((sid, i) => {
    db.prepare(
      `INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id,
         executor_config, position_x, position_y, created_at)
       VALUES (?, ?, ?, 'running', 'confer', '', ?, 0, ?, ?)`,
    ).run(randomUUID(), runId, `step-${i}`,
      JSON.stringify({ conferSessionId: sid, conferAgentIds: ['pa', 'pb'] }), i * 100, iso());
  });
  return runId;
}

const statusOf = (id: string) =>
  (db.prepare('SELECT status FROM confer_sessions WHERE id = ?').get(id) as { status: string }).status;

let app: { base: string; close: () => void } | null = null;
async function base(): Promise<string> {
  if (app) return app.base;
  const e = express();
  e.use(express.json());
  e.use('/api/workflows', workflowsRouter);
  const server: Server = await new Promise((r) => { const s = e.listen(0, () => r(s)); });
  app = { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
  return app.base;
}
test.after(() => app?.close());

const END_PATHS: { name: string; end: (runId: string) => Promise<Response> }[] = [
  { name: 'POST /:id/cancel', end: async (id) => fetch(`${await base()}/api/workflows/${id}/cancel`, { method: 'POST' }) },
  { name: 'DELETE /:id', end: async (id) => fetch(`${await base()}/api/workflows/${id}`, { method: 'DELETE' }) },
];

for (const path of END_PATHS) {
  test(`${path.name} ends every running confer the run owns, and nothing else`, async () => {
    const live = [confer('running'), confer('running')];
    const finished = [confer('completed'), confer('failed')];
    const runId = runOwning([...live, ...finished]);
    const bystander = confer('running');
    runOwning([bystander]);

    const res = await path.end(runId);
    assert.ok(res.ok, `${path.name} returned ${res.status}`);

    const wrong: string[] = [];
    for (const id of live) if (statusOf(id) !== 'cancelled') wrong.push(`${id} still ${statusOf(id)} (owned, was running)`);
    const was: Record<string, string> = { [finished[0]]: 'completed', [finished[1]]: 'failed' };
    for (const id of finished) if (statusOf(id) !== was[id]) wrong.push(`${id} became ${statusOf(id)} (owned, already ${was[id]})`);
    if (statusOf(bystander) !== 'running') wrong.push(`${bystander} became ${statusOf(bystander)} (another run's)`);
    assert.deepEqual(wrong, [], `${path.name} left confers in the wrong state:\n${wrong.join('\n')}`);
  });
}
