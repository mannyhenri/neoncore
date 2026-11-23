/**
 * BUG TRIAGE — the API and the Jira client.
 *   - every route of the contract answers;
 *   - the webhook refuses a missing or wrong HMAC signature and takes a right one;
 *   - the Jira client speaks Jira Cloud REST v3 to a tiny fake over real HTTP, authenticates from
 *     the ENV NAMES the source holds, and never returns or stores the values.
 */
import './helpers/isolated-db.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import triageRouter, { triageWebhook } from '../src/routes/triage.ts';
import { setTriageSender } from '../src/lib/triage/dispatch.ts';
import { setMessengerJira } from '../src/lib/triage/messenger.ts';
import { setEngineJira, triageSettled } from '../src/lib/triage/engine.ts';
import { JiraClient, adfDoc, adfText, adfMention } from '../src/lib/triage/jira.ts';
import type { JiraIssue } from '../src/lib/triage/jira.ts';

installStubIO();
setTriageSender(() => ({ ok: true }));
setMessengerJira(() => ({ addComment: async () => ({ id: '1' }), addLabels: async () => null, transitionTo: async () => true, addRemoteLink: async () => null }));
const BUG: JiraIssue = { key: 'WEB-1', projectKey: 'WEB', summary: 'Login button does nothing', description: 'Click it.', issueType: 'Bug', status: 'Open', reporter: { accountId: 'r1', displayName: 'Rae' }, labels: [], created: new Date().toISOString(), updated: new Date().toISOString(), environment: '', attachments: [], links: [] };
setEngineJira(() => ({ search: async () => [], getIssue: async () => BUG, comments: async () => [], myself: async () => ({ accountId: 'svc', displayName: 'svc' }), createIssue: async () => ({ key: 'WEB-2' }), addRemoteLink: async () => null }));
db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, agent_type) VALUES ('tr-a', 'box/tr', 'box', '/tmp/tr', 'tr', 'idle', ?, 'claude')`).run(new Date().toISOString());

let server: Server; let base = '';
before(async () => {
  const app = express();
  app.post('/api/triage/webhook/:sourceId', express.raw({ type: '*/*' }), (req, res) => { void triageWebhook(req, res); });
  app.use(express.json());
  app.use('/api/triage', triageRouter);
  base = await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)); });
});
after(() => server.close());

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined;
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
  const text = await res.text();
  let json: any = text; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

test('every route of the contract answers', async () => {
  process.env.TRIAGE_HOOK_SECRET = 'shh';
  const s = await call('POST', '/api/triage/sources', { name: 'Acme', jiraBaseUrl: 'https://acme.atlassian.net', authEnv: { email: 'JIRA_EMAIL', token: 'JIRA_TOKEN' }, projects: ['web'], repoFor: { WEB: '/tmp/web' }, triageAgentId: 'tr-a', webhookSecretEnv: 'TRIAGE_HOOK_SECRET' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.deepEqual(s.json.projects, ['WEB']);
  const sid = s.json.id;
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'WEB-1' } });
  const sig = `sha256=${crypto.createHmac('sha256', 'shh').update(body).digest('hex')}`;
  const hook = await call('POST', `/api/triage/webhook/${sid}`, body, { 'X-Hub-Signature': sig });
  assert.equal(hook.status, 200, JSON.stringify(hook.json));
  assert.equal(hook.json.handled, 'intake');
  await triageSettled();
  const issues = await call('GET', `/api/triage/issues?sourceId=${sid}`);
  assert.equal(issues.json.length, 1);
  const iid = issues.json[0].id;
  const detail = await call('GET', `/api/triage/issues/${iid}`);
  const reqId = detail.json.requests[0].id;
  assert.ok(!('prompt' in detail.json.requests[0]), 'prompts are not served');

  const routes: [string, string, unknown?][] = [
    ['GET', '/api/triage/sources'], ['GET', `/api/triage/sources/${sid}`], ['PUT', `/api/triage/sources/${sid}`, { pollSeconds: 120 }],
    ['GET', '/api/triage/issues'], ['GET', `/api/triage/issues/${iid}`],
    ['GET', '/api/triage/settings'], ['PUT', '/api/triage/settings', { dailyDispatchCap: 50 }], ['GET', '/api/triage/metrics'],
    ['POST', `/api/triage/requests/${reqId}/submit`, { result: { classification: 'question', complete: true, reason: 'asks how to log in' } }],
    ['POST', `/api/triage/issues/${iid}/handover`, { reason: 'mine' }],
    ['POST', `/api/triage/issues/${iid}/retry`],
    ['POST', `/api/triage/sources/${sid}/poll`],
  ];
  for (const [m, r, b] of routes) {
    const res = await call(m, r, b);
    assert.ok(res.status < 400, `${m} ${r} → ${res.status} ${JSON.stringify(res.json)}`);
    await triageSettled();
  }
  // reopen and released answer with a reason when the issue is not in the right state — still an answer
  for (const r of [`/api/triage/issues/${iid}/reopen`, `/api/triage/issues/${iid}/released`]) {
    const res = await call('POST', r);
    assert.ok([200, 409].includes(res.status), `${r} → ${res.status}`);
  }
  assert.equal((await call('POST', '/api/triage/from-qa-finding/nope', { sourceId: sid })).status, 404);
  assert.equal((await call('DELETE', `/api/triage/sources/${sid}`)).status, 200);
});

test('the webhook refuses a missing or wrong signature', async () => {
  process.env.TRIAGE_HOOK_SECRET = 'shh';
  const s = (await call('POST', '/api/triage/sources', { name: 'Hooked', jiraBaseUrl: 'https://acme.atlassian.net', webhookSecretEnv: 'TRIAGE_HOOK_SECRET' })).json;
  const body = JSON.stringify({ webhookEvent: 'jira:issue_created', issue: { key: 'WEB-1' } });
  assert.equal((await call('POST', `/api/triage/webhook/${s.id}`, body)).status, 401);
  assert.equal((await call('POST', `/api/triage/webhook/${s.id}`, body, { 'X-Hub-Signature': 'sha256=deadbeef' })).status, 401);
  const wrongKey = `sha256=${crypto.createHmac('sha256', 'other').update(body).digest('hex')}`;
  assert.equal((await call('POST', `/api/triage/webhook/${s.id}`, body, { 'X-Hub-Signature': wrongKey })).status, 401);
  const tampered = `sha256=${crypto.createHmac('sha256', 'shh').update(body).digest('hex')}`;
  assert.equal((await call('POST', `/api/triage/webhook/${s.id}`, body.replace('WEB-1', 'WEB-9'), { 'X-Hub-Signature': tampered })).status, 401);
});

test('a source refuses credentials given as values instead of environment-variable names', async () => {
  const res = await call('POST', '/api/triage/sources', { name: 'Bad', jiraBaseUrl: 'https://acme.atlassian.net', authEnv: { email: 'me@acme.com', token: 'ATATT3xFfGF0' } });
  assert.equal(res.status, 400);
});

test('the Jira client speaks REST v3 to a fake Jira, authenticates from env names, and never echoes the token', async () => {
  const seen: { method: string; url: string; auth: string; body: any }[] = [];
  const fake = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? ''), body });
      const send = (o: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url === '/rest/api/3/myself') return send({ accountId: 'svc-1', displayName: 'Triage Bot' });
      if (req.url === '/rest/api/3/search/jql') {
        const page2 = body.nextPageToken === 'p2';
        return send({ issues: [{ key: page2 ? 'WEB-2' : 'WEB-1', fields: { summary: page2 ? 'Two' : 'One', project: { key: 'WEB' }, issuetype: { name: 'Bug' }, reporter: { accountId: 'r', displayName: 'R' }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps' }] }] } } }], ...(page2 ? { isLast: true } : { nextPageToken: 'p2', isLast: false }) });
      }
      if (req.url?.startsWith('/rest/api/3/issue/WEB-1/transitions') && req.method === 'GET') return send({ transitions: [{ id: '31', name: 'Start', to: { name: 'In Progress' } }] });
      if (req.url?.startsWith('/rest/api/3/issue/WEB-1/comment') && req.method === 'GET') return send({ comments: [{ id: '9', author: { accountId: 'r', displayName: 'R' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'here are the steps' }] }] }, created: '2026-11-21T10:00:00.000+0000' }] });
      if (req.method === 'POST' && req.url === '/rest/api/3/issue') return send({ key: 'WEB-3' });
      send({});
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  process.env.T_JIRA_EMAIL = 'bot@acme.com'; process.env.T_JIRA_TOKEN = 'secret-token-123';
  const jira = new JiraClient({ jiraBaseUrl: url, authEnv: { email: 'T_JIRA_EMAIL', token: 'T_JIRA_TOKEN' } });
  try {
    assert.equal((await jira.myself()).accountId, 'svc-1');
    const found = await jira.search('project = WEB');
    assert.deepEqual(found.map((i) => i.key), ['WEB-1', 'WEB-2'], 'follows nextPageToken');
    assert.equal(found[0].description, 'Steps');
    assert.equal((await jira.comments('WEB-1'))[0].body, 'here are the steps');
    await jira.addComment('WEB-1', adfDoc([[adfMention('r', 'R'), adfText(' hello')]]));
    await jira.addLabels('WEB-1', ['ai-triaged']);
    assert.equal(await jira.transitionTo('WEB-1', 'In Progress'), true);
    await jira.addRemoteLink('WEB-1', 'https://github.com/x/pull/1', 'Fix');
    assert.equal((await jira.createIssue('WEB', 'From QA', 'Steps')).key, 'WEB-3');
    const want = `Basic ${Buffer.from('bot@acme.com:secret-token-123').toString('base64')}`;
    assert.ok(seen.every((s) => s.auth === want), 'every call authenticates with the env values');
    const comment = seen.find((s) => s.method === 'POST' && s.url === '/rest/api/3/issue/WEB-1/comment')!;
    assert.equal(comment.body.body.type, 'doc');
    assert.equal(comment.body.body.version, 1);
    assert.equal(comment.body.body.content[0].content[0].type, 'mention');
    assert.deepEqual(seen.find((s) => s.method === 'PUT')!.body, { update: { labels: [{ add: 'ai-triaged' }] } });
    assert.deepEqual(seen.find((s) => s.url === '/rest/api/3/issue/WEB-1/transitions' && s.method === 'POST')!.body, { transition: { id: '31' } });
    assert.equal(seen.find((s) => s.url === '/rest/api/3/issue/WEB-1/remotelink')!.body.object.url, 'https://github.com/x/pull/1');
    assert.ok(!JSON.stringify(found).includes('secret-token-123'));
    delete process.env.T_JIRA_TOKEN;
    await assert.rejects(() => jira.myself(), /T_JIRA_TOKEN/, 'a missing credential names the variable, not a value');
  } finally { fake.close(); }
});
