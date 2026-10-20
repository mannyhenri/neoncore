/**
 * A CONFER THAT IS WAITING SAYS SO, ON THE STEP.
 *
 * Reported as: "why does an epic workflow doesn't run? This has been a few times where this
 * happens". Run 86 (Epic: Task by Task, GRD-4453) sat with its first step `pending` for three
 * and a half minutes; runs 78 and 84 sat for hours and were cancelled; run 75 for three days.
 *
 * The confer executor is RIGHT to wait: a participant (or a sibling in its repo) is busy, and
 * starting on top of live work is worse. What was wrong is that the wait was invisible. The step
 * was reset to `pending` — the state of a step that has never been dispatched — and the reason
 * went only to the journal, once per change in who was blocking. On the canvas a waiting run
 * and a dead run looked identical, so the only available response was to cancel it.
 *
 * The wait now lives on the step, in `routing_note`, which the canvas already renders under the
 * step: who it waits for, since when, and what that cartridge is doing. It is removed when the
 * confer starts, and any other note on the step is kept.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';

installStubIO();

const iso = () => new Date().toISOString();
let n = 0;

function cartridge(name: string, status: string, currentTask = ''): string {
  const id = `cw-${process.pid}-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,current_task)
     VALUES (?,?,?,?,?,'claude',?,?,?,?)`,
  ).run(id, `${os.hostname()}/${name}`, os.hostname(), `/tmp/${name}-${n}`, name, status, iso(), `s-${id}`, currentTask);
  return id;
}

function runWithConfer(participants: string[], note = ''): { runId: string; stepId: string } {
  const i = ++n;
  const runId = `cw-run-${i}`, stepId = `cw-step-${i}`;
  db.prepare(
    `INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number,initial_context)
     VALUES (?,'Epic: Task by Task','','running','[]',?,?,'tpl',86,'GRD-4453')`,
  ).run(runId, iso(), iso());
  db.prepare(
    `INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,
       executor_type,executor_id,executor_config,auto_advance,depends_on,created_at,status,routing_note)
     VALUES (?,?,'Load Epic','',300,50,'confer','__deferred__',?,1,'[]',?,'pending',?)`,
  ).run(stepId, runId, JSON.stringify({ conferAgentIds: participants, conferMode: 'collaborate', prompt: 'Load the epic.' }), iso(), note);
  return { runId, stepId };
}

const step = (id: string) => db.prepare('SELECT status, routing_note FROM workflow_steps WHERE id = ?')
  .get(id) as { status: string; routing_note: string };

test('a confer waiting on a busy participant says who, since when, and what it is doing', () => {
  const busy = cartridge('film-engine', 'working', 'Restart the backend after migration 117');
  const free = cartridge('gl-dev-media', 'idle');
  const { stepId } = runWithConfer([busy, free]);

  tickWorkflowsOnce();

  const s = step(stepId);
  assert.equal(s.status, 'pending', 'the confer must still wait — starting on live work is the worse bug');
  assert.match(s.routing_note, /^Waiting since \d{2}:\d{2} UTC/m, 'the wait is not on the step, so the run looks dead');
  assert.match(s.routing_note, /film-engine/, 'does not say which cartridge it waits for');
  assert.match(s.routing_note, /Restart the backend after migration 117/, 'does not say what the blocker is doing');
  assert.doesNotMatch(s.routing_note, /gl-dev-media/, 'names a participant that is not blocking');
});

test('the "since" time is kept across ticks, so a long wait reads as long', () => {
  const busy = cartridge('gl-dev-lane-ops', 'working', 'GRD-4306 SSH install');
  const { stepId } = runWithConfer([busy, cartridge('gl-dev', 'idle')]);
  tickWorkflowsOnce();
  const first = step(stepId).routing_note.match(/Waiting since (\d{2}:\d{2}) UTC/)?.[1];
  const cfg = db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ?').get(stepId) as { executor_config: string };
  const since = JSON.parse(cfg.executor_config).conferWaitingSince as string;
  assert.ok(first && since, 'no wait start recorded');
  tickWorkflowsOnce();
  assert.equal(JSON.parse((db.prepare('SELECT executor_config FROM workflow_steps WHERE id = ?').get(stepId) as { executor_config: string }).executor_config).conferWaitingSince, since,
    'every tick restarted the clock');
});

test('when the blocker frees up, the wait line goes and other notes stay', () => {
  const busy = cartridge('baseback', 'working', 'PR review');
  const { stepId } = runWithConfer([busy, cartridge('gl-dev-b', 'idle')], 'capability routing: confer -> frontier (ok)');
  tickWorkflowsOnce();
  assert.match(step(stepId).routing_note, /^Waiting since/m);

  db.prepare("UPDATE agents SET status = 'idle', current_task = '' WHERE id = ?").run(busy);
  tickWorkflowsOnce();

  const s = step(stepId);
  assert.doesNotMatch(s.routing_note, /Waiting since/, 'the confer started but still says it is waiting');
  assert.match(s.routing_note, /capability routing: confer -> frontier/, 'clearing the wait wiped an unrelated note');
});
