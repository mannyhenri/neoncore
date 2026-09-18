/**
 * A CONFER INSIDE A WORKFLOW IS NOT A SECOND THING RUNNING.
 *
 * Reported as "I have 2 confers running at the same time for baseback and backend-interlag —
 * is there an extra one?". There was not. ONE confer was running: session a44d10cf, the
 * "Verify Together" step of run 2713c7de, with those two repos as its participants. Both
 * cartridges read `working` because both are participants of that single confer, which is what
 * a confer is.
 *
 * What produced the second entry is that the run and its own confer session are fetched from
 * two endpoints and merged into one list:
 *
 *   /api/workflows → run 2713c7de "Confer"   (running)
 *   /api/confer    → session a44d10cf         (running)
 *   totalActive = activeRuns.length + activeV1.length + activeConfers.length  → 2
 *
 * One confer, counted twice: once as the run that owns it, once as the session that run
 * created. A standalone confer — started from the Confer panel with no workflow — has no run
 * to be counted beside, so it must still appear on its own. The distinction is "does a
 * workflow step own this session", and the client had no way to ask: `workflow_steps`
 * stores `conferSessionId` in its executor_config, `confer_sessions` stores no back-reference,
 * and the payload carried neither.
 *
 * SET-BASED OVER EVERY SESSION the API returns, not over a fixture pair, because the failure
 * this prevents is a payload that attributes the session you happened to look at. Every
 * session must be attributed correctly: owned ones name their run, standalone ones name none.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { listConfers } from '../src/lib/confer-conductor.ts';

const iso = () => new Date().toISOString();
let n = 0;

function session(id: string): string {
  db.prepare(
    `INSERT INTO confer_sessions (id, repo_name, repo_path, task, participant_ids, status,
       current_milestone, error, created_at, mode, isolation, build_rounds)
     VALUES (?, 'backend-interlag', '/tmp/x', 'work together', '["a","b"]', 'running', 1, '', ?, 'divide', 'shared', 1)`,
  ).run(id, iso());
  return id;
}

/** A run whose confer step created `sessionId` — the shape the executor writes. */
function runOwning(sessionId: string): { runId: string; stepId: string } {
  const runId = `own-run-${++n}`;
  const stepId = `own-step-${n}`;
  db.prepare(
    `INSERT INTO workflows (id, name, status, run_number, template_id, created_at)
     VALUES (?, 'Confer', 'running', 1, 'tpl-c', ?)`,
  ).run(runId, iso());
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id,
       executor_config, position_x, position_y, created_at)
     VALUES (?, ?, 'Verify Together', 'running', 'confer', '', ?, 300, 50, ?)`,
  ).run(stepId, runId, JSON.stringify({ conferSessionId: sessionId, conferAgentIds: ['a', 'b'] }), iso());
  return { runId, stepId };
}

test('every session the API returns says whether a run owns it', () => {
  const standalone = session(`solo-${++n}`);
  const owned = session(`owned-${++n}`);
  const { runId, stepId } = runOwning(owned);

  const byId = new Map(listConfers().map((c) => [c.id, c]));
  assert.ok(byId.size >= 2, 'listConfers returned nothing to check');

  // SET-BASED: check EVERY session, not just the two just made. Truth comes from the steps
  // table, which is the only place the link exists.
  const wrong: string[] = [];
  for (const [id, c] of byId) {
    const step = db.prepare(
      `SELECT id, workflow_id FROM workflow_steps WHERE executor_config LIKE ?`,
    ).get(`%"conferSessionId":"${id}"%`) as { id: string; workflow_id: string } | undefined;
    const expected = step ? step.workflow_id : null;
    const actual = (c as { workflowId?: string | null }).workflowId ?? null;
    if (actual !== expected) {
      wrong.push(`${id}: payload says workflowId=${JSON.stringify(actual)}, steps table says ${JSON.stringify(expected)}`);
    }
  }
  assert.deepEqual(wrong, [],
    'sessions are not attributed to the run that owns them, so the UI cannot tell a confer '
    + 'inside a workflow from a standalone one and counts the workflow ones twice:\n  '
    + wrong.join('\n  '));

  assert.equal((byId.get(owned) as { workflowId?: string | null }).workflowId, runId);
  assert.equal((byId.get(owned) as { stepId?: string | null }).stepId, stepId);
  assert.equal((byId.get(standalone) as { workflowId?: string | null }).workflowId ?? null, null,
    'a standalone confer was attributed to a run, which would hide it from the list entirely');
});

test('a deleted run leaves its session standalone, not pointing at nothing', () => {
  // A dangling workflowId is worse than none: the surface would hide the session while no run
  // exists to represent it, and the confer would vanish from every list.
  const orphan = session(`orphan-${++n}`);
  const { runId } = runOwning(orphan);
  db.prepare('DELETE FROM workflows WHERE id = ?').run(runId);
  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(runId);

  const c = listConfers().find((x) => x.id === orphan)!;
  assert.equal((c as { workflowId?: string | null }).workflowId ?? null, null,
    'the session still points at a run that no longer exists, so it would be hidden forever');
});
