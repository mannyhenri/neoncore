/**
 * THE RUNS THAT ALREADY EXIST.
 *
 * Exempting the report step from confer conversion fixes every run created from now on. It
 * does nothing for the rows already in the database, and those are not a historical curiosity:
 * measured on the live database, SIX report steps sit converted to `confer` with an empty
 * executor_id and status `pending`, and ONE of them belongs to a run that is still running.
 * When that run reaches its last step it will confer the report across its participants and
 * reproduce the bug exactly — duplicate reports, no journal entry — on code that is fixed.
 *
 * A launch-time fix that leaves live runs holding the broken shape is half a fix. This is the
 * other half, and it runs at boot beside the report backfill.
 *
 * SET-BASED over every conferred report step in the database rather than over a fixture,
 * because the population is the thing being asserted about: after the repair there must be
 * NONE left that could still dispatch.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import db from '../src/db.ts';
import { repairConferredReportSteps } from '../src/lib/workflow-report-repair.ts';
import { isReportStep } from '../src/lib/workflow-report.ts';

const iso = () => new Date().toISOString();
let n = 0;

function agent(): string {
  const id = `rep-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,?,'/tmp/x',?,'claude','idle',?,?)`,
  ).run(id, id, os.hostname(), `repo-${id}`, iso(), `s-${id}`);
  return id;
}

/** A run holding a report step in the broken shape, exactly as the live rows look. */
function brokenRun(runStatus: string, stepStatus: string, roster: string[]): { runId: string; stepId: string } {
  const runId = `rr-${++n}`;
  const stepId = `rs-${n}`;
  db.prepare(
    `INSERT INTO workflows (id, name, status, run_number, template_id, created_at)
     VALUES (?, 'Confer', ?, 1, 'tpl-x', ?)`,
  ).run(runId, runStatus, iso());
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, position_x, position_y, created_at)
     VALUES (?, ?, 'Workflow Completion Report', ?, 'confer', '', ?, 300, 50, ?)`,
  ).run(stepId, runId, stepStatus, JSON.stringify({
    stepKind: 'workflow-report', reportContext: true, conferAgentIds: roster, conferMode: 'divide',
  }), iso());
  return { runId, stepId };
}

/** Every report step that could still DISPATCH as a confer. After the repair this must be empty. */
function stillConferred(): string[] {
  const rows = db.prepare(
    `SELECT id, executor_type, status, executor_config FROM workflow_steps
      WHERE executor_type = 'confer' AND status IN ('pending', 'running')`,
  ).all() as { id: string; executor_type: string; status: string; executor_config: string }[];
  return rows.filter((r) => isReportStep(JSON.parse(r.executor_config || '{}'))).map((r) => r.id);
}

test('no report step that could still dispatch is left as a confer', () => {
  const a = agent(); const b = agent();
  const live = brokenRun('running', 'pending', [a, b]);
  const failed = brokenRun('failed', 'pending', [a, b]);

  assert.deepEqual(stillConferred().sort(), [live.stepId, failed.stepId].sort(),
    'the fixture is not reproducing the broken shape');

  repairConferredReportSteps(db);

  assert.deepEqual(stillConferred(), [],
    'a report step in an undispatched run is still a confer — it will duplicate the report '
    + 'and skip the journal the moment that run advances');

  for (const { stepId } of [live, failed]) {
    const s = db.prepare('SELECT executor_type, executor_id, executor_config FROM workflow_steps WHERE id = ?')
      .get(stepId) as { executor_type: string; executor_id: string; executor_config: string };
    assert.equal(s.executor_type, 'claude-code');
    assert.equal(s.executor_id, a, 'must take the first participant — the same judge the launch path picks');
    assert.ok(isReportStep(JSON.parse(s.executor_config)), 'the repair destroyed the step kind');
    assert.deepEqual(JSON.parse(s.executor_config).conferAgentIds, [a, b],
      'the roster must survive: it is how reportSources finds a report already written to a participant repo');
  }
});

test('a COMPLETED conferred report is left exactly as it is', () => {
  const a = agent(); const b = agent();
  const done = brokenRun('completed', 'completed', [a, b]);
  const before = db.prepare('SELECT executor_type, executor_id, executor_config FROM workflow_steps WHERE id = ?')
    .get(done.stepId);

  repairConferredReportSteps(db);

  const after = db.prepare('SELECT executor_type, executor_id, executor_config FROM workflow_steps WHERE id = ?')
    .get(done.stepId);
  // Its work happened. Rewriting it would be inventing a history where one cartridge owned a
  // step that two of them actually ran — and the ingest reads the roster, not the type.
  assert.deepEqual(after, before, 'the repair rewrote a step that had already run');
});

test('a step whose roster is all dead cartridges is left alone, not half-repaired', () => {
  const orphan = brokenRun('running', 'pending', ['no-such-agent-1', 'no-such-agent-2']);
  const repaired = repairConferredReportSteps(db);

  const s = db.prepare('SELECT executor_type, executor_id FROM workflow_steps WHERE id = ?')
    .get(orphan.stepId) as { executor_type: string; executor_id: string };
  // Pinning a dead id would turn a visible confer into a step that dies at dispatch with
  // "has no cartridge assigned" — the launch door refuses a stale pin for exactly this reason.
  assert.equal(s.executor_id, '', 'pinned a cartridge that does not exist');
  assert.ok(repaired.unrepairable >= 1, 'a step it could not repair must be counted, not swallowed');
});

test('running it twice changes nothing the second time', () => {
  const a = agent(); const b = agent();
  brokenRun('running', 'pending', [a, b]);
  const first = repairConferredReportSteps(db);
  const second = repairConferredReportSteps(db);
  assert.ok(first.repaired >= 1, 'the first pass repaired nothing');
  assert.equal(second.repaired, 0, 'the repair is not idempotent — it runs at every boot');
});
