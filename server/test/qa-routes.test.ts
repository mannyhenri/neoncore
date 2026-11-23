/**
 * THE QA API AND THE RECORDER (docs/plans/qa-section.md).
 *
 * SET-BASED: every route of the contract's API table answers (not 404/500); every way a typed
 * value can be sensitive is never stored; journeys are mined, generated into tests, and covered.
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
import qaRouter, { recorderRouter } from '../src/routes/qa.ts';
import { setQaRunner, runDir } from '../src/lib/qa/runner.ts';
import { setQaSender } from '../src/lib/qa/dispatch.ts';
import { qaSettled } from '../src/lib/qa/engine.ts';
import { MASK, stepsOf, sentencesFor } from '../src/lib/qa/recorder.ts';

installStubIO();
process.env.NEONCORE_QA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-routes-'));
setQaSender(() => ({ ok: true }));
setQaRunner(async (spec) => ({ status: 'passed', steps: spec.sentences.map((sentence, index) => ({ index, sentence, status: 'passed' as const })), console: [], network: [], trace: '', durationMs: 1 }));
db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, agent_type) VALUES ('qa-r', 'box/qa', 'box', '/tmp/qa', 'qa', 'idle', ?, 'claude')`).run(new Date().toISOString());

let server: Server; let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/qa', qaRouter);
  app.use('/qa', recorderRouter);
  base = await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)); });
});
after(() => server.close());

async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: any = text; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
}

test('every route of the contract answers', async () => {
  const t = (await call('POST', '/api/qa/targets', { name: 'Demo', baseUrl: 'http://localhost:4061', allowHosts: ['localhost:4061'], agentId: 'qa-r' })).json;
  assert.ok(t.id, JSON.stringify(t));
  const tc = (await call('POST', '/api/qa/tests', { targetId: t.id, sentences: '1. Go to the list.\n2. Check that the title is Reports.' })).json;
  assert.deepEqual(tc.sentences, ['Go to the list.', 'Check that the title is Reports.']);
  const run = (await call('POST', '/api/qa/runs', { targetId: t.id, kind: 'explore' })).json;
  const req = (await call('GET', `/api/qa/runs/${run.id}`)).json.requests[0];
  const session = (await call('POST', '/api/qa/sessions', { targetId: t.id, key: t.recorderKey })).json;
  const finding = (await call('POST', `/api/qa/requests/${req.id}/submit`, { result: { findings: [{ title: 'Broken link', page: '/x', steps: ['Go to /x'], sentences: ['Go to /x.'] }] } })).json;
  assert.equal(finding.ok, true);
  const fid = (await call('GET', `/api/qa/findings?targetId=${t.id}`)).json[0].id;

  const ROUTES: [string, string, unknown?][] = [
    ['GET', '/api/qa/targets'], ['GET', `/api/qa/targets/${t.id}`], ['PUT', `/api/qa/targets/${t.id}`, { name: 'Demo app' }],
    ['GET', `/api/qa/tests?targetId=${t.id}`], ['GET', `/api/qa/tests/${tc.id}`], ['PUT', `/api/qa/tests/${tc.id}`, { name: 'List title' }],
    ['GET', `/api/qa/runs?targetId=${t.id}`], ['GET', `/api/qa/runs/${run.id}`], ['GET', `/api/qa/runs/${run.id}/report.html`],
    ['GET', `/api/qa/findings?targetId=${t.id}`], ['PUT', `/api/qa/findings/${fid}`, { status: 'dismissed' }],
    ['GET', '/api/qa/repairs?status=pending'], ['GET', `/api/qa/journeys?targetId=${t.id}`],
    ['POST', `/api/qa/sessions/${session.id}/events`, { key: t.recorderKey, events: [] }], ['GET', `/api/qa/requests/${req.id}`],
    ['GET', `/qa/recorder.js?target=${t.id}&key=${t.recorderKey}`],
  ];
  const bad: string[] = [];
  for (const [m, r, b] of ROUTES) {
    const out = await call(m, r, b);
    if (out.status >= 400) bad.push(`${m} ${r} → ${out.status} ${out.text.slice(0, 120)}`);
  }
  assert.deepEqual(bad, []);
  const report = await call('GET', `/api/qa/runs/${run.id}/report.html`);
  assert.match(report.type, /html/);
  assert.match(report.text, /Broken link/);
  // …and the deletes.
  assert.equal((await call('DELETE', `/api/qa/tests/${tc.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/qa/targets/${t.id}`)).status, 200);
  assert.equal((await call('GET', `/api/qa/targets/${t.id}`)).status, 404);
});

test('a target on a host nobody listed is refused by the API', async () => {
  const out = await call('POST', '/api/qa/targets', { name: 'Prod', baseUrl: 'https://app.example.com', allowHosts: ['localhost'] });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /allow-list/);
});

test('the recorder never stores a password, a sensitive field, or typed text that did not opt in', async () => {
  const t = (await call('POST', '/api/qa/targets', { name: 'Rec', baseUrl: 'http://localhost:4061', agentId: 'qa-r' })).json;
  const s = (await call('POST', '/api/qa/sessions', { targetId: t.id, key: t.recorderKey })).json;
  const SECRET = 'hunter2-SECRET';
  const CASES = [
    { t: 'input', path: '/login', field: 'Password', inputType: 'password', value: SECRET },
    { t: 'input', path: '/pay', field: 'Card', sensitive: true, value: SECRET, record: true },
    { t: 'input', path: '/report', field: 'Notes', value: SECRET },
    { t: 'input', path: '/report', field: 'Project', value: 'Alpha', record: true },
  ];
  await call('POST', `/api/qa/sessions/${s.id}/events`, { key: t.recorderKey, events: CASES });
  const row = db.prepare('SELECT events FROM qa_sessions WHERE id = ?').get(s.id) as { events: string };
  assert.ok(!row.events.includes(SECRET), 'a secret reached the database');
  const stored = JSON.parse(row.events) as { field: string; value: string }[];
  assert.deepEqual(stored.map((e) => [e.field, e.value]), [['Notes', MASK], ['Project', 'Alpha']]);
  const script = (await call('GET', `/qa/recorder.js?target=${t.id}&key=${t.recorderKey}`)).text;
  assert.match(script, /password/);
  assert.match(script, /data-qa-sensitive/);
  assert.equal((await call('GET', '/qa/recorder.js?target=nope')).status, 404);
});

test('journeys: sessions are grouped, ranked, generated into tests, and covered', async () => {
  const t = (await call('POST', '/api/qa/targets', { name: 'J', baseUrl: 'http://localhost:4061', agentId: 'qa-r' })).json;
  const journey = (n: string) => [
    { t: 'nav', path: '/login' }, { t: 'input', path: '/login', field: 'User', value: n }, { t: 'click', path: '/login', label: 'Sign in' },
    { t: 'nav', path: `/reports/${n.length}` }, { t: 'click', path: '/reports/1', label: 'Approve' },
  ];
  for (const who of ['ann', 'bob', 'carla']) {
    const s = (await call('POST', '/api/qa/sessions', { targetId: t.id, key: t.recorderKey })).json;
    await call('POST', `/api/qa/sessions/${s.id}/events`, { key: t.recorderKey, events: journey(who) });
  }
  const lone = (await call('POST', '/api/qa/sessions', { targetId: t.id, key: t.recorderKey })).json;
  await call('POST', `/api/qa/sessions/${lone.id}/events`, { key: t.recorderKey, events: [{ t: 'nav', path: '/help' }, { t: 'click', path: '/help', label: 'Contact' }] });

  let cov = (await call('GET', `/api/qa/journeys?targetId=${t.id}`)).json;
  assert.equal(cov.total, 2);
  assert.equal(cov.journeys[0].count, 3, 'the most-travelled journey first');
  assert.equal(cov.covered, 0);
  const gen = (await call('POST', '/api/qa/runs', { targetId: t.id, kind: 'generate', limit: 1 })).json;
  assert.equal(gen.status, 'completed');
  assert.equal(gen.aiCalls, 0);
  cov = (await call('GET', `/api/qa/journeys?targetId=${t.id}`)).json;
  assert.equal(cov.covered, 1);
  assert.ok(cov.journeys[0].testId, 'the top journey has its test');
  const generated = (await call('GET', `/api/qa/tests/${cov.journeys[0].testId}`)).json;
  assert.equal(generated.source, 'recorder');
  assert.ok(!JSON.stringify(generated.sentences).includes('carla'), 'typed values are replaced by test data');
  assert.match(generated.sentences.at(-1), /^Check that/);
});

test('a journey of steps reads as sentences', () => {
  const steps = stepsOf([{ t: 'nav', path: '/a' }, { t: 'input', path: '/a', field: 'Name', value: MASK }, { t: 'input', path: '/a', field: 'Name', value: MASK }, { t: 'submit', path: '/a', label: 'Save' }]);
  assert.deepEqual(steps, ['goto /a', 'fill name', 'submit save']);
  assert.deepEqual(sentencesFor(steps), ['Go to /a.', 'Fill in "name" with test data.', 'Submit the form.', 'Check that the page is /a.']);
});

test('evidence is served from inside its run, and nothing outside it', async () => {
  const t = (await call('POST', '/api/qa/targets', { name: 'E', baseUrl: 'http://localhost:4061', agentId: 'qa-r' })).json;
  await call('POST', '/api/qa/tests', { targetId: t.id, sentences: ['Go to /.'], cache: [[{ do: 'goto', path: '/' }]] });
  const run = (await call('POST', '/api/qa/runs', { targetId: t.id, kind: 'run' })).json;
  await qaSettled();
  fs.mkdirSync(runDir(run.id), { recursive: true });
  fs.writeFileSync(path.join(runDir(run.id), 'shot.png'), 'png');
  fs.writeFileSync(path.join(process.env.NEONCORE_QA_DIR!, 'secret.txt'), 'nope');
  assert.equal((await call('GET', `/api/qa/evidence/${run.id}/shot.png`)).status, 200);
  for (const evil of ['../secret.txt', '..%2Fsecret.txt', '..%2F..%2Fsecret.txt', '%2Fetc%2Fpasswd']) {
    const out = await call('GET', `/api/qa/evidence/${run.id}/${evil}`);
    assert.ok(out.status === 403 || out.status === 404, `${evil} → ${out.status}`);
    assert.ok(!out.text.includes('nope'));
  }
});

test('the recorder intake takes only its target\'s own key — never the fleet token, never another target\'s key', async () => {
  const a = (await call('POST', '/api/qa/targets', { name: 'key-a', baseUrl: 'http://localhost:4061' })).json;
  const b = (await call('POST', '/api/qa/targets', { name: 'key-b', baseUrl: 'http://localhost:4062' })).json;
  assert.match(a.recorderKey, /^[0-9a-f]{48}$/);
  assert.notEqual(a.recorderKey, b.recorderKey);
  for (const key of [undefined, '', 'nope', b.recorderKey]) {
    assert.equal((await call('POST', '/api/qa/sessions', { targetId: a.id, key })).status, 403, `start with key ${key}`);
    assert.equal((await call('GET', `/qa/recorder.js?target=${a.id}&key=${key ?? ''}`)).status, 404, `script with key ${key}`);
  }
  const s = (await call('POST', '/api/qa/sessions', { targetId: a.id, key: a.recorderKey })).json;
  for (const key of [undefined, 'nope', b.recorderKey]) {
    assert.equal((await call('POST', `/api/qa/sessions/${s.id}/events`, { key, events: [{ t: 'nav', path: '/' }] })).status, 403, `events with key ${key}`);
  }
  assert.equal((await call('POST', `/api/qa/sessions/${s.id}/events`, { key: a.recorderKey, events: [{ t: 'nav', path: '/' }] })).status, 200);
  const script = (await call('GET', `/qa/recorder.js?target=${a.id}&key=${a.recorderKey}`)).text;
  assert.ok(script.includes(a.recorderKey), 'the script carries its key');
});

test('a run as the API returns it links its evidence through this server, and names its tests', async () => {
  const { runDir } = await import('../src/lib/qa/runner.ts');
  const { setQaRunner } = await import('../src/lib/qa/runner.ts');
  const t = (await call('POST', '/api/qa/targets', { name: 'links', baseUrl: 'http://localhost:4063' })).json;
  const tc = (await call('POST', '/api/qa/tests', { targetId: t.id, name: 'Named test', sentences: ['Go home.'], cache: [[{ do: 'goto', path: '/' }]] })).json;
  let inside = '';
  setQaRunner(async (_spec: unknown, out: string) => {
    inside = `${out}/fail.png`;
    return { status: 'passed', steps: [{ index: 0, sentence: 'Go home.', status: 'passed', screenshot: inside }], console: [], network: [], trace: '/etc/passwd', durationMs: 1 } as never;
  });
  const run = (await call('POST', '/api/qa/runs', { targetId: t.id, kind: 'run' })).json;
  let detail: any;
  for (let i = 0; i < 50; i++) { detail = (await call('GET', `/api/qa/runs/${run.id}`)).json; if (detail.status !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  const r = detail.results[0];
  assert.equal(r.testName, 'Named test');
  assert.ok(inside.startsWith(runDir(run.id)), 'the runner wrote inside the run directory');
  assert.match(r.evidence.steps[0].screenshot, new RegExp(`^/api/qa/evidence/${run.id}/`), 'a path inside the run is a served link');
  assert.equal(r.evidence.trace, '', 'a path outside the run gets no link');
  void tc;
});
