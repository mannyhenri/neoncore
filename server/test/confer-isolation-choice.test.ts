/**
 * SPLIT OR SHARED — THE LAUNCH FORM DECIDES, NOT THE CODE.
 *
 * Reported as "the template should give that option, split or shared".
 *
 * Two cartridges working one repo can share a checkout or take a worktree each. That is a real
 * choice with a real cost either way: a shared tree means one git index and one cargo target
 * lock between two agents; a worktree each removes the collision but costs disk and a merge.
 * It was not offered — routes/workflows.ts hardcoded `config.conferIsolation ?? 'shared'`, the
 * exact shape the conferMode hardcode had, so every run came up shared and the only way to get
 * worktrees was to edit the run's rows by hand. That was done twice this week.
 *
 * WORKTREE REQUIRES DIVIDE, and that is not a validation quibble: confer-conductor.ts:584
 * downgrades worktree to shared whenever the mode is collaborate, because agents working the
 * SAME thing in separate trees produce two divergent answers and no way to reconcile them.
 * So the launch must refuse that combination loudly rather than accept it and silently do
 * something else — silently substituting is the defect the mode hardcode already was.
 *
 * SET-BASED over CONFER_ISOLATIONS x CONFER_MODES, the two registries, so a third isolation or
 * a third mode is covered the day it lands rather than the day someone notices.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import { CONFER_MODES, CONFER_ISOLATIONS, isConferIsolation } from '../src/lib/confer-conductor.ts';
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
    const id = `ci-${++n}`;
    db.prepare(
      `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
       VALUES (?,?,?,?,?,'claude','idle',?,?)`,
    ).run(id, id, os.hostname(), `/tmp/${id}`, `repo-${id}`, iso(), `s-${id}`);
    io.connect(id);
    ids.push(id);
  }
  return ids;
}

const template = () => (db.prepare(
  "SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Bug Hunter'",
).get() as { id: string }).id;

const conferSteps = (runId: string) => (db.prepare(
  "SELECT name, executor_config FROM workflow_steps WHERE workflow_id = ? AND executor_type = 'confer'",
).all(runId) as { name: string; executor_config: string }[])
  .map((s) => ({ name: s.name, cfg: JSON.parse(s.executor_config || '{}') as Record<string, unknown> }));

async function launch(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/workflows/v2/${template()}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test('the isolation registry exists and names both choices', () => {
  assert.ok(CONFER_ISOLATIONS.includes('shared'), 'shared is missing');
  assert.ok(CONFER_ISOLATIONS.includes('worktree'), 'worktree — the split — is missing');
  assert.ok(isConferIsolation('worktree'));
  assert.ok(!isConferIsolation('sandbox'), 'an unknown isolation was accepted as valid');
});

test('EVERY isolation survives a divide launch and reaches the step', async () => {
  const wrong: string[] = [];
  for (const isolation of CONFER_ISOLATIONS) {
    const { status, text } = await launch({
      conferAllSteps: cartridges(), conferMode: 'divide', conferIsolation: isolation,
    });
    if (status !== 200) { wrong.push(`${isolation}: launch refused → ${text}`); continue; }
    const runId = (JSON.parse(text) as { workflow: { id: string } }).workflow.id;
    for (const s of conferSteps(runId)) {
      if (s.cfg.conferIsolation !== isolation) {
        wrong.push(`${isolation}: step "${s.name}" got "${String(s.cfg.conferIsolation)}"`);
      }
    }
  }
  assert.deepEqual(wrong, [],
    'a chosen isolation did not reach the step — the launch silently picked for you:\n  ' + wrong.join('\n  '));
});

test('no isolation requested still means shared', async () => {
  const { status, text } = await launch({ conferAllSteps: cartridges(), conferMode: 'divide' });
  assert.equal(status, 200, text);
  const runId = (JSON.parse(text) as { workflow: { id: string } }).workflow.id;
  for (const s of conferSteps(runId)) {
    assert.equal(s.cfg.conferIsolation, 'shared', `"${s.name}" changed the default`);
  }
});

test('worktree + collaborate is REFUSED, not silently downgraded', async () => {
  // The conductor downgrades it (confer-conductor.ts:584). Accepting the request and then
  // doing something else is how a user believes they got separate trees and did not.
  const { status, text } = await launch({
    conferAllSteps: cartridges(), conferMode: 'collaborate', conferIsolation: 'worktree',
  });
  assert.equal(status, 400, `expected a refusal, got ${status}: ${text}`);
  assert.match(text, /worktree/i);
  assert.match(text, /divide|collaborate/i, 'the error does not explain the constraint');
});

test('an unknown isolation is refused, naming the valid ones', async () => {
  const { status, text } = await launch({
    conferAllSteps: cartridges(), conferIsolation: 'sandbox',
  });
  assert.equal(status, 400, `expected a refusal, got ${status}`);
  assert.match(text, /sandbox/);
  assert.match(text, /shared/);
  assert.match(text, /worktree/);
});

test('the refusal happens even when every cartridge is busy', async () => {
  // Same trap the mode validation fell into: the queue guard runs first and parks a malformed
  // request instead of refusing it.
  const ids = cartridges();
  for (const id of ids) db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(id);
  const { status } = await launch({ conferAllSteps: ids, conferIsolation: 'sandbox' });
  assert.equal(status, 400, 'a malformed isolation was queued rather than refused');
});

test('every mode is still launchable with the default isolation', async () => {
  // Guard against the isolation check breaking the mode choice that already worked.
  for (const mode of CONFER_MODES) {
    const { status, text } = await launch({ conferAllSteps: cartridges(), conferMode: mode });
    assert.equal(status, 200, `${mode} stopped launching: ${text}`);
  }
});
