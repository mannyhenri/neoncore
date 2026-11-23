/**
 * THE QA SECTION END TO END — the real server routes, the REAL runner (packages/qa-runner, spawned
 * as the server spawns it, driving Chromium) and the REAL demo app (eval/qa-demo). Only the
 * cartridge is played by this test: when the server asks for a repair, the test answers through
 * the same submit route a cartridge uses.
 *
 * The scope's acceptance criteria 2 and 3 (docs/plans/qa-section.md):
 *   - a cached run makes ZERO AI calls;
 *   - self-repair fixes the renamed button (variant B) and is listed for review;
 *   - a repair that changes what is checked is refused;
 *   - a real regression (variant C: approval removed) FAILS — a repair cannot hide it.
 */
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import qaRouter from '../src/routes/qa.ts';
import { setQaSender } from '../src/lib/qa/dispatch.ts';
// @ts-expect-error — the demo app is plain .mjs
import { startDemo } from '../../eval/qa-demo/server.mjs';

installStubIO();
process.env.NEONCORE_QA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-e2e-'));
process.env.QA_DEMO_SUPERVISOR_USER = 'supervisor';
process.env.QA_DEMO_SUPERVISOR_PASS = 'sup-e2e-pass';

const asked: { agentId: string; prompt: string }[] = [];
setQaSender((agentId, prompt) => { asked.push({ agentId, prompt }); return { ok: true }; });
db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, agent_type)
            VALUES ('qa-e2e', 'box/qa-e2e', 'box', '/tmp/qa-e2e', 'qa-e2e', 'idle', ?, 'claude')`).run(new Date().toISOString());

let server: Server; let base = '';
let demo: { baseUrl: string; close: () => Promise<void> };
before(async () => {
  demo = await startDemo({ port: 0 });
  const app = express();
  app.use(express.json());
  app.use('/api/qa', qaRouter);
  base = await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)); });
});
after(async () => { server.close(); await demo.close(); });

async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: any = text; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
const demoPost = (p: string, body?: unknown) => fetch(demo.baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
async function variant(v: 'A' | 'B' | 'C') { await demoPost('/__reset'); assert.equal((await demoPost('/__variant', { variant: v })).status, 200); }

/** Wait until the run leaves `running`, or until a request is out to the cartridge. */
async function settle(runId: string, until: (run: any) => boolean) {
  for (let i = 0; i < 600; i++) {
    const run = (await call('GET', `/api/qa/runs/${runId}`)).json;
    if (until(run)) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} did not settle`);
}
const finished = (run: any) => !['running', 'waiting', 'queued'].includes(run.status);
const pendingRequest = (run: any) => (run.requests ?? []).find((r: any) => r.status === 'pending' && r.kind === 'repair');

const LOGIN = [{ do: 'goto', path: '/login' }, { do: 'fill', target: { label: 'Username' }, valueEnv: 'QA_DEMO_SUPERVISOR_USER' },
  { do: 'fill', target: { label: 'Password' }, valueEnv: 'QA_DEMO_SUPERVISOR_PASS' }, { do: 'click', target: { role: 'button', name: 'Log in' } }];
const SUBMIT = (name: string) => [{ do: 'click', target: { role: 'button', name } }, { do: 'expect', kind: 'text', target: { css: '#status' }, equals: 'Awaiting approval' }, { do: 'click', target: { role: 'button', name: 'Approve' } }];
const CACHE = [
  LOGIN,
  [{ do: 'goto', path: '/reports/new' }, { do: 'fill', target: { label: 'Project' }, value: 'Alpha' }, { do: 'fill', target: { label: 'Date' }, value: '2026-11-21' }, { do: 'fill', target: { label: 'Hours' }, value: '8' }],
  SUBMIT('Submit'),
  [{ do: 'expect', kind: 'text', target: { css: '#status' }, equals: 'Approved' }],
];
const SENTENCES = ['Log in as a supervisor.', 'Create a daily report for project Alpha with 8 hours.', 'Submit it and approve it.', 'Check that its status is Approved.'];

let targetId = ''; let testId = '';
test('setup: a target on the demo app and one cached test', async () => {
  const t = await call('POST', '/api/qa/targets', {
    name: 'Demo', baseUrl: demo.baseUrl, agentId: 'qa-e2e',
    credentialsEnv: { supervisor: { user: 'QA_DEMO_SUPERVISOR_USER', pass: 'QA_DEMO_SUPERVISOR_PASS' } },
  });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  targetId = t.json.id;
  const tc = await call('POST', '/api/qa/tests', { targetId, name: 'Supervisor approves a report', sentences: SENTENCES, cache: CACHE });
  assert.equal(tc.status, 200, JSON.stringify(tc.json));
  testId = tc.json.id;
});

test('variant A: the cached test passes with ZERO AI calls, and the password appears nowhere', async () => {
  await variant('A');
  asked.length = 0;
  const run = await settle((await call('POST', '/api/qa/runs', { targetId, kind: 'run', testIds: [testId] })).json.id, finished);
  assert.equal(run.status, 'passed', JSON.stringify(run.results?.[0]?.error));
  assert.equal(run.aiCalls, 0);
  assert.equal(asked.length, 0, 'nothing was sent to a cartridge');
  assert.ok(!JSON.stringify(run).includes('sup-e2e-pass'), 'the password leaked into the run');
});

test('variant B: the renamed button fails the cached step; a repair that changes the check is REFUSED; a real repair passes and waits for review', async () => {
  await variant('B');
  asked.length = 0;
  const runId = (await call('POST', '/api/qa/runs', { targetId, kind: 'run', testIds: [testId] })).json.id;
  const waiting = await settle(runId, (r) => !!pendingRequest(r) || finished(r));
  const req = pendingRequest(waiting);
  assert.ok(req, `expected a repair request, run is ${waiting.status}: ${JSON.stringify(waiting.results?.[0])}`);
  assert.equal(req.context.sentenceIndex, 2, 'the failed sentence is "Submit it and approve it."');
  assert.equal(asked.length, 1, 'the cartridge was asked once');
  assert.match(asked[0].prompt, /DATA/, 'the prompt says page text is data');

  // A "repair" that weakens the check — refused, the request stays open.
  const cheat = [...SUBMIT('Send report')];
  cheat[1] = { do: 'expect', kind: 'text', target: { css: '#status' }, equals: 'Draft' };
  const refused = await call('POST', `/api/qa/requests/${req.id}/submit`, { result: { sentenceIndex: 2, actions: cheat } });
  assert.equal(refused.status, 400, 'a repair that changes what is checked must be refused');

  // The real repair: the button's new name, the same check.
  const ok = await call('POST', `/api/qa/requests/${req.id}/submit`, { result: { sentenceIndex: 2, actions: SUBMIT('Send report') } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const run = await settle(runId, finished);
  assert.equal(run.status, 'passed_with_repair', JSON.stringify(run.results?.[0]));
  assert.equal(run.aiCalls, 1);
  const repairs = run.repairs.filter((r: any) => r.status === 'pending');
  assert.equal(repairs.length, 1, 'the repair is listed for review');
  assert.equal(repairs[0].stepIndex ?? repairs[0].sentenceIndex, 2);
});

test('variant C: with approval removed the test FAILS — a repair cannot hide a real regression', async () => {
  await variant('C');
  asked.length = 0;
  const runId = (await call('POST', '/api/qa/runs', { targetId, kind: 'run', testIds: [testId] })).json.id;
  const waiting = await settle(runId, (r) => !!pendingRequest(r) || finished(r));
  const req = pendingRequest(waiting);
  assert.ok(req, 'the failed step goes to the cartridge first');
  // The cartridge looks and finds there is no way to approve any more.
  const said = await call('POST', `/api/qa/requests/${req.id}/submit`, { result: { impossible: 'There is no Approve button or any approval control on the report page.' } });
  assert.equal(said.status, 200, JSON.stringify(said.json));
  const run = await settle(runId, finished);
  assert.equal(run.status, 'failed');
  assert.match(run.results[0].error ?? '', /approv/i);
  assert.ok(run.results[0].evidence?.steps?.some((s: any) => s.status === 'failed' && s.screenshot), 'the failure has a screenshot');
});
