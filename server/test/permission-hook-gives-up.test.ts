/**
 * A QUESTION THE HOOK STOPPED WAITING ON MUST LEAVE THE APP.
 *
 * Reported as "I answer a question in NeonCore and then have to answer it again in the
 * session — sometimes". Confirmed in the logs: Claude Code killed the permission hook at its
 * 600s default, the terminal menu took over, but the `permissions` row stayed pending for the
 * 15-minute TTL. 3 of 10 dashboard answers landed in that window (737s, 757s, 808s); each
 * resolved no hook, yet cleared the banner and set the cartridge `working` — a silent drop.
 *
 * The fix has three parts that must agree, so they are asserted together:
 *   - install.py registers the hook with a long timeout, and the proxy's wait stays under it
 *     (agent/tests/test_permission_wait.py);
 *   - the server's TTL outlives the hook, so a question is never swept while a hook still waits;
 *   - when the hook gives up it POSTs /abandon, and the question leaves the app at once.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db.ts';
import permissionsRouter, { applyDecision } from '../src/routes/permissions.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let base = '';
let server: Server;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/permissions', permissionsRouter);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r();
  }); });
});
test.after(() => server?.close());

let n = 0;
function openQuestion(status = 'pending'): { agentId: string; permissionId: string } {
  const agentId = `gu-agent-${++n}`;
  const permissionId = `gu-perm-${n}`;
  const q = '{"questions":[{"question":"Which model?"}]}';
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
              VALUES (?,?,'test',?,'repo','claude','waiting',?,?,?)`)
    .run(agentId, agentId, `/tmp/gu-${n}`, new Date().toISOString(), `gu-s-${n}`, q);
  db.prepare(`INSERT INTO permissions (id, agent_id, tool_name, tool_input, description, status, created_at)
              VALUES (?, ?, 'AskUserQuestion', ?, 'Which model?', ?, ?)`)
    .run(permissionId, agentId, q, status, new Date().toISOString());
  io.connect(agentId);
  return { agentId, permissionId };
}
const perm = (id: string) => db.prepare('SELECT status FROM permissions WHERE id = ?').get(id) as { status: string };
const agent = (id: string) => db.prepare('SELECT status, pending_question FROM agents WHERE id = ?').get(id) as { status: string; pending_question: string };
const abandon = (id: string) => fetch(`${base}/api/permissions/${id}/abandon`, { method: 'POST' });

test('the server TTL outlives the hook timeout install.py registers', () => {
  const install = readFileSync(resolve(root, 'agent/install.py'), 'utf8');
  const index = readFileSync(resolve(root, 'server/src/index.ts'), 'utf8');
  const hookTimeout = Number(install.match(/PERMISSION_HOOK_TIMEOUT_SECONDS = (\d+)/)?.[1]);
  const ttl = index.match(/PERMISSION_TTL_MS = ([\d\s*]+);/)?.[1];
  assert.ok(hookTimeout > 600, 'the hook must outlive Claude Code\'s 600s default');
  assert.ok(ttl, 'PERMISSION_TTL_MS not found');
  const ttlMs = ttl.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
  assert.ok(ttlMs > hookTimeout * 1000, `TTL ${ttlMs}ms would sweep a question the hook (${hookTimeout}s) still waits on`);
});

test('a hook that gives up takes the question out of the app at once', async () => {
  const { agentId, permissionId } = openQuestion();
  const before = io.emissions.length;
  const res = await abandon(permissionId);
  assert.equal(res.status, 200);
  assert.equal(perm(permissionId).status, 'expired');
  assert.equal(agent(agentId).pending_question, '', 'the banner still offers a question nobody is waiting on');
  assert.equal(agent(agentId).status, 'waiting', 'it is still waiting — on the terminal now — so it must not read as working');
  assert.ok(io.emissions.slice(before).some((e) => e.event === 'permission_decided'), 'the app was not told to drop it');
});

test('a late answer after the hook gave up is not reported as delivered', async () => {
  const { agentId, permissionId } = openQuestion();
  await abandon(permissionId);
  const result = applyDecision(permissionId, 'allowed', { answers: { 'Which model?': 'Qwen' } });
  assert.equal(result?.status, 'expired', 'the answer was recorded as if a hook had received it');
  assert.equal(agent(agentId).status, 'waiting');
});

test('abandon never touches a question that was already decided, or an unknown id', async () => {
  const { permissionId } = openQuestion('allowed');
  assert.equal((await abandon(permissionId)).status, 200);
  assert.equal(perm(permissionId).status, 'allowed');
  assert.equal((await abandon('no-such-permission')).status, 404);
});

test('abandon leaves the banner on another question that is still open', async () => {
  const { agentId, permissionId } = openQuestion();
  const other = `gu-perm-other-${++n}`;
  db.prepare(`INSERT INTO permissions (id, agent_id, tool_name, tool_input, description, status, created_at)
              VALUES (?, ?, 'AskUserQuestion', '{"questions":[{"question":"Second?"}]}', 'Second?', 'pending', ?)`)
    .run(other, agentId, new Date(Date.now() + 1000).toISOString());
  await abandon(permissionId);
  assert.match(agent(agentId).pending_question, /Second\?/);
});
