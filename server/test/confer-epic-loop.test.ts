/**
 * CONFER WORKS EVERY TASK OF THE EPIC — the loop, end to end on the seeded template.
 *
 * Confer (with a Jira epic) must not end with the epic half done because the participants ran
 * out of rounds. Verify Coverage's COVERAGE line is read by the ENGINE (lib/coverage-loop.ts):
 *   - tasks open            → back to the confer: a fresh session, TOLD what is left, with build
 *                             rounds sized to what is left (lib/confer-sizing.ts);
 *   - every task done       → the run goes on;
 *   - no progress since the → the run HOLDS for a person (`tasks-outstanding`), which no autonomy
 *     last pass              level may settle; "Keep working" goes back, "Accept as is" goes on.
 * Asserted through the executor and the real template, not by reading the config.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import {
  tickWorkflowsOnce, completeStepFromSignal, executorSettled, continueCoverageWork, acceptCoverage,
} from '../src/lib/workflow-executor-v2.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { workflowNeedsAttention } from '../src/lib/workflow-attention.ts';
import { canAutoResolve } from '../src/lib/autonomy.ts';

const io = installStubIO();
const iso = () => new Date().toISOString();
let n = 0;

function agent(repo: string): string {
  const id = `cel-${++n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,active_queue_item_id)
              VALUES (?,?,'box',?,?,'claude','idle',?,?,'')`).run(id, id, `/tmp/${repo}`, repo, iso(), `s-${id}`);
  io.connect(id);
  return id;
}

type Row = { id: string; name: string; status: string; executor_config: string; executor_id: string };
const stepsOf = (runId: string) => db.prepare('SELECT id, name, status, executor_config, executor_id FROM workflow_steps WHERE workflow_id = ?').all(runId) as Row[];
const named = (runId: string, name: string) => stepsOf(runId).find((s) => s.name === name)!;
const cfgOf = (runId: string, name: string) => JSON.parse(named(runId, name).executor_config) as Record<string, unknown>;
const settle = async () => { await executorSettled(); for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5)); };
const confers = () => (db.prepare('SELECT COUNT(*) n FROM confer_sessions').get() as { n: number }).n;

/** A Confer run, exactly as a two-cartridge launch makes it, with Scope and the first confer done. */
function runAtVerify() {
  const a = agent(`ledger-${n}`), b = agent(`frontdesk-${n}`);
  const tpl = (db.prepare("SELECT id FROM workflows WHERE name = 'Confer' AND template_id IS NULL").get() as { id: string }).id;
  const runId = cloneTemplateAsRun(tpl, null, 'JIRA EPIC: GRD-1712', { agentId: a, confer: { agentIds: [a, b] } })!;
  const done = (name: string, result: string) => db.prepare(
    "UPDATE workflow_steps SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
  ).run(result, iso(), named(runId, name).id);
  done('Scope the Work', 'MODE: EPIC GRD-1712\nTASK_COUNT: 3\nTASKS:\nGRD-1 — Refund API\nGRD-2 — Refund screen\nGRD-3 — Refund email');
  done('Confer & Build', 'ledger took GRD-1 (done). frontdesk took GRD-2 (done). Nobody took GRD-3.');
  db.prepare("UPDATE workflow_steps SET status = 'running', started_at = ? WHERE id = ?").run(iso(), named(runId, 'Verify Coverage').id);
  return { runId, a, b };
}

const TWO_OF_THREE = 'COVERAGE: 2/3 · 1 never claimed · 0 blocked\n\nOUTSTANDING — one line each:\n- GRD-3 Refund email — ledger — never claimed';

/** Report Verify, then let the engine read it. */
async function verify(runId: string, result: string) {
  const s = named(runId, 'Verify Coverage');
  if (s.status !== 'running') db.prepare("UPDATE workflow_steps SET status = 'running', started_at = ? WHERE id = ?").run(iso(), s.id);
  assert.ok(completeStepFromSignal(s.id, result), 'the completion was not accepted');
  tickWorkflowsOnce();
  await settle();
}

test('tasks open: back to a fresh confer, told exactly what is left, with rounds sized to it', async () => {
  const { runId } = runAtVerify();
  const before = confers();
  await verify(runId, TWO_OF_THREE);

  assert.equal(named(runId, 'Scope the Work').status, 'completed', 'the epic was looked up again for nothing');
  if (named(runId, 'Confer & Build').status === 'pending') { tickWorkflowsOnce(); await settle(); }
  assert.equal(named(runId, 'Confer & Build').status, 'running', 'the run was not sent back to the confer');
  assert.ok(['pending', 'running'].includes(named(runId, 'Verify Coverage').status), 'Verify will not check again');
  assert.equal(named(runId, 'Work Standard Check').status, 'pending', 'the run went on with a task open');

  assert.equal(confers(), before + 1, 'no new confer session started');
  const session = db.prepare('SELECT task, build_rounds FROM confer_sessions ORDER BY rowid DESC LIMIT 1').get() as { task: string; build_rounds: number };
  assert.match(session.task, /GRD-3 Refund email/, 'the new session is not told which task is still open');
  assert.match(session.task, /TASKS STILL OPEN/, 'the new session is not told why it runs again');
  // 1 task left, 2 participants, 2 per participant per round → 1 round, not the template's 3.
  assert.equal(session.build_rounds, 1, 'the confer was not sized to what is left');
  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);
});

test('every task done: no loop — the run goes on', async () => {
  const { runId } = runAtVerify();
  await verify(runId, 'COVERAGE: 3/3 · 0 never claimed · 0 blocked');
  assert.equal(named(runId, 'Confer & Build').status, 'completed', 'a finished epic was sent round again');
  assert.notEqual(named(runId, 'Work Standard Check').status, 'pending', 'the run did not go on');
  assert.equal(workflowNeedsAttention(runId), null);
  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);
});

test('no progress since the last pass: the run HOLDS for a person — and no autonomy level may settle it', async () => {
  const { runId } = runAtVerify();
  await verify(runId, TWO_OF_THREE);                                  // pass 1: back to the confer
  db.prepare("UPDATE workflow_steps SET status = 'completed', result = 'nobody could take GRD-3', completed_at = ? WHERE id = ?")
    .run(iso(), named(runId, 'Confer & Build').id);
  await verify(runId, TWO_OF_THREE);                                  // pass 2: still 2 of 3

  const att = workflowNeedsAttention(runId);
  assert.equal(att?.reason, 'tasks-outstanding', `expected a hold, got ${JSON.stringify(att)}`);
  assert.match(att!.detail, /1 of 3 task\(s\) are still open/);
  tickWorkflowsOnce(); await settle();
  assert.equal(named(runId, 'Work Standard Check').status, 'pending', 'a held run went on by itself');
  for (const level of ['manual', 'advance', 'full'] as const) {
    assert.equal(canAutoResolve(level, 'tasks-outstanding'), false, `"${level}" autonomy could accept open tasks for you`);
  }
  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);
});

test('"Keep working" goes back to the confer; "Accept as is" lets the run go on', async () => {
  // Keep working.
  {
    const { runId } = runAtVerify();
    await verify(runId, TWO_OF_THREE);
    db.prepare("UPDATE workflow_steps SET status = 'completed', completed_at = ? WHERE id = ?").run(iso(), named(runId, 'Confer & Build').id);
    await verify(runId, TWO_OF_THREE);
    const held = named(runId, 'Verify Coverage');
    assert.ok(cfgOf(runId, 'Verify Coverage')._coverageHold, 'not holding');
    assert.deepEqual(continueCoverageWork(held.id), { ok: true });
    assert.equal(cfgOf(runId, 'Verify Coverage')._coverageHold, undefined);
    assert.ok(['pending', 'running'].includes(named(runId, 'Confer & Build').status), 'Keep working did not go back to the confer');
    db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);
  }
  // Accept as is.
  {
    const { runId } = runAtVerify();
    await verify(runId, TWO_OF_THREE);
    db.prepare("UPDATE workflow_steps SET status = 'completed', completed_at = ? WHERE id = ?").run(iso(), named(runId, 'Confer & Build').id);
    await verify(runId, TWO_OF_THREE);
    const held = named(runId, 'Verify Coverage');
    assert.deepEqual(acceptCoverage(held.id), { ok: true });
    tickWorkflowsOnce(); await settle();
    assert.notEqual(named(runId, 'Work Standard Check').status, 'pending', 'Accept as is did not let the run go on');
    assert.ok((cfgOf(runId, 'Verify Coverage')._coverageAccepted as { done: number }).done === 2, 'the acceptance is not on record');
    assert.equal(workflowNeedsAttention(runId)?.reason === 'tasks-outstanding', false);
    db.prepare("UPDATE workflows SET status = 'completed' WHERE id = ?").run(runId);
  }
});
