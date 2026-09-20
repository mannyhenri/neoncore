/**
 * A WORKFLOW CONFER CAN STILL BE TOLD HOW TO WORK TOGETHER.
 *
 * Reported as: "the old confer (the one that we replace this weekend) had two modes, split the
 * work and work together ... restore these modes into the confer workflows please it's super
 * important."
 *
 * The modes were never deleted. `confer-conductor.ts` still defines both milestone sets and
 * they are genuinely different runs of work — DIVIDE opens by agreeing a split so the peers do
 * not collide, COLLABORATE has them work the same thing and reconcile. What was lost is the
 * CHOICE: run-level confer hardcoded `config.conferMode = config.conferMode ?? 'divide'`
 * (routes/workflows.ts), so every confer launched from a workflow silently divided, whatever
 * the work actually needed.
 *
 * SET-BASED over MILESTONE_SETS, the mode registry, rather than testing 'collaborate' because
 * that is the one that regressed. A third mode added later is covered the day it lands, and a
 * mode that reaches the step config but has no milestones behind it is caught here rather than
 * at 3am in a live confer.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import { CONFER_MODES, conferMilestoneCount } from '../src/lib/confer-conductor.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();
const iso = () => new Date().toISOString();
let base = '';
let server: Server;
let n = 0;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', workflowsRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r();
    });
  });
});
test.after(() => server?.close());

function cartridges(count = 2): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `cm-${++n}`;
    db.prepare(
      `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
       VALUES (?,?,?,?,?,'claude','idle',?,?)`,
    ).run(id, id, os.hostname(), `/tmp/${id}`, `repo-${id}`, iso(), `s-${id}`);
    io.connect(id);
    ids.push(id);
  }
  return ids;
}

const template = (name: string) => (db.prepare(
  'SELECT id FROM workflows WHERE template_id IS NULL AND name = ?',
).get(name) as { id: string }).id;

function conferStepsOf(runId: string) {
  return (db.prepare(
    "SELECT name, executor_config FROM workflow_steps WHERE workflow_id = ? AND executor_type = 'confer'",
  ).all(runId) as { name: string; executor_config: string }[])
    .map((s) => ({ name: s.name, cfg: JSON.parse(s.executor_config || '{}') as Record<string, unknown> }));
}

test('the mode registry has both modes, and each has its own milestones', () => {
  assert.ok(CONFER_MODES.includes('divide'), 'divide — split the work — is missing');
  assert.ok(CONFER_MODES.includes('collaborate'), 'collaborate — work together — is missing');
  for (const mode of CONFER_MODES) {
    assert.ok(conferMilestoneCount(mode) > 0, `mode "${mode}" has no milestones behind it`);
  }
  // If two modes ran the same milestones, the choice would be cosmetic.
  const counts = new Set(CONFER_MODES.map((m) => JSON.stringify([m, conferMilestoneCount(m)])));
  assert.equal(counts.size, CONFER_MODES.length);
});

test('EVERY mode survives a run-level confer launch', async () => {
  const wrong: string[] = [];
  for (const mode of CONFER_MODES) {
    const ids = cartridges();
    const res = await fetch(`${base}/api/workflows/v2/${template('Bug Hunter')}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conferAllSteps: ids, conferMode: mode }),
    });
    const body = await res.text();
    if (!res.ok) { wrong.push(`${mode}: launch refused → ${body}`); continue; }
    const runId = (JSON.parse(body) as { workflow: { id: string } }).workflow.id;

    const steps = conferStepsOf(runId);
    if (steps.length === 0) { wrong.push(`${mode}: the run has no confer step`); continue; }
    for (const s of steps) {
      if (s.cfg.conferMode !== mode) {
        wrong.push(`${mode}: step "${s.name}" was launched as "${String(s.cfg.conferMode)}"`);
      }
    }
  }
  assert.deepEqual(wrong, [],
    'a requested confer mode did not reach the step — the workflow silently picked for you:\n  '
    + wrong.join('\n  '));
});

test('no mode requested still means divide — the old default is unchanged', async () => {
  const ids = cartridges();
  const res = await fetch(`${base}/api/workflows/v2/${template('Bug Hunter')}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferAllSteps: ids }),
  });
  const runId = (JSON.parse(await res.text()) as { workflow: { id: string } }).workflow.id;
  for (const s of conferStepsOf(runId)) {
    assert.equal(s.cfg.conferMode, 'divide', `"${s.name}" changed the default mode`);
  }
});

test('an unknown mode is refused, not quietly run as divide', async () => {
  // Silently substituting would be the same defect in reverse: the caller asked for something
  // specific and got something else with no error.
  const ids = cartridges();
  const res = await fetch(`${base}/api/workflows/v2/${template('Bug Hunter')}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferAllSteps: ids, conferMode: 'telepathy' }),
  });
  assert.equal(res.status, 400, 'an unknown confer mode was accepted');
  const { error } = await res.json() as { error: string };
  assert.match(error, /telepathy/, 'the error does not say what was rejected');
  assert.match(error, /divide|collaborate/, 'the error does not say what the valid modes are');
});

/**
 * THE CHECK MUST NOT DEPEND ON HOW BUSY THE FLEET IS.
 *
 * The first version of the validation sat with the conversion, several hundred lines below the
 * busy-cartridge queue guard. Against idle cartridges the request reached it and a bad mode
 * was refused — which is exactly what the test above proved, and it proved it on the one path
 * that happened to work. Against a BUSY cartridge the queue guard returns `queued: true`
 * first, so the malformed request was parked to be applied later with nobody watching.
 *
 * Found by launching against the real server, not by this suite: conferMode "telepathy" came
 * back 202 Queued. So the case is pinned here, with the cartridges deliberately BUSY.
 */
test('a bad mode is refused even when every cartridge is busy', async () => {
  const ids = cartridges();
  // Busy, which is what sends the launch down the queue path instead of dispatching.
  for (const id of ids) db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);

  const res = await fetch(`${base}/api/workflows/v2/${template('Bug Hunter')}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferAllSteps: ids, conferMode: 'telepathy' }),
  });
  const body = await res.text();
  assert.equal(res.status, 400,
    `a malformed confer was accepted because the cartridges were busy — got ${res.status}: ${body}`);
  assert.match(body, /telepathy/);
});

test('a one-cartridge confer is refused when busy too', async () => {
  const ids = cartridges(1);
  db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(ids[0]);
  const res = await fetch(`${base}/api/workflows/v2/${template('Bug Hunter')}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferAllSteps: ids }),
  });
  assert.equal(res.status, 400, 'a one-person confer was queued rather than refused');
});
