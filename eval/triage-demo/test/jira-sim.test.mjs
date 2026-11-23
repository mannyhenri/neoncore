/**
 * The Jira simulator answers like Jira Cloud's REST API v3 — every endpoint in its registry, with
 * Jira's shapes and status codes, Basic auth, JQL filters and ADF comment bodies.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, SERVICE_ACCOUNT, compileJql, startJiraSim } from '../jira-sim.mjs';
import { adfToText, isAdfDoc, textToAdf } from '../adf.mjs';
import { SEED_ISSUES } from '../seed.mjs';

let sim;
before(async () => { sim = await startJiraSim({ port: 0 }); });
after(async () => { await sim.close(); });

const AUTH = `Basic ${Buffer.from('triage-bot@ledgerly.test:token').toString('base64')}`;
async function jira(method, path, body, { auth = AUTH } = {}) {
  const res = await fetch(sim.baseUrl + path, {
    method, headers: { accept: 'application/json', 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const reset = () => fetch(`${sim.baseUrl}/__reset`, { method: 'POST' });

const isIssue = (i) => typeof i.id === 'string' && /^DEMO-\d+$/.test(i.key) && typeof i.self === 'string' && typeof i.fields === 'object';
const isComment = (c) => typeof c.id === 'string' && isAdfDoc(c.body) && typeof c.author?.accountId === 'string' && /\+0000$/.test(c.created);

/** One call per registry entry, with a check of Jira's shape for its answer. */
const CALLS = {
  'POST /rest/api/3/search/jql': { body: { jql: 'project = DEMO', fields: ['summary', 'status'], maxResults: 50 }, status: 200,
    check: (j) => Array.isArray(j.issues) && j.issues.every(isIssue) && j.isLast === true && j.issues[0].fields.summary && j.issues[0].fields.status.name },
  'GET /rest/api/3/issue/{key}': { status: 200,
    check: (j) => isIssue(j) && isAdfDoc(j.fields.description) && j.fields.issuetype.name === 'Bug' && typeof j.fields.reporter.accountId === 'string'
      && Array.isArray(j.fields.labels) && Array.isArray(j.fields.comment.comments) && Array.isArray(j.fields.issuelinks) && /\+0000$/.test(j.fields.created) },
  'PUT /rest/api/3/issue/{key}': { body: { update: { labels: [{ add: 'ai-triaged' }] } }, status: 204, check: (j) => j === null },
  'GET /rest/api/3/issue/{key}/comment': { status: 200, check: (j) => Array.isArray(j.comments) && typeof j.total === 'number' && j.startAt === 0 },
  'POST /rest/api/3/issue/{key}/comment': { body: { body: textToAdf('Thanks, we are looking at it.') }, status: 201, check: isComment },
  'GET /rest/api/3/issue/{key}/transitions': { status: 200, check: (j) => Array.isArray(j.transitions) && j.transitions.every((t) => t.id && t.name && t.to?.name) },
  'POST /rest/api/3/issue/{key}/transitions': { body: { transition: { id: '21' } }, status: 204, check: (j) => j === null },
  'POST /rest/api/3/issue/{key}/remotelink': { body: { object: { url: 'https://github.com/ledgerly/app/pull/7', title: 'PR #7' } }, status: 201, check: (j) => typeof j.id === 'number' && typeof j.self === 'string' },
  'POST /rest/api/3/issue': { body: { fields: { project: { key: 'DEMO' }, summary: 'Filed from QA', issuetype: { name: 'Bug' }, description: textToAdf('Found by the Explorer.') } }, status: 201,
    check: (j) => /^DEMO-\d+$/.test(j.key) && typeof j.id === 'string' && typeof j.self === 'string' },
  'GET /rest/api/3/myself': { status: 200, check: (j) => j.accountId === SERVICE_ACCOUNT.accountId && j.displayName && j.active === true },
};

test('the registry and the calls cover each other', () => {
  assert.deepEqual(ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort(), Object.keys(CALLS).sort());
});

for (const ep of ENDPOINTS) {
  const name = `${ep.method} ${ep.path}`;
  const path = ep.path.replace('{key}', 'DEMO-1');
  test(`${name} answers with Jira's shape`, async () => {
    await reset();
    const c = CALLS[name];
    const r = await jira(ep.method, path, c.body);
    assert.equal(r.status, c.status, JSON.stringify(r.json));
    assert.ok(c.check(r.json), `shape: ${JSON.stringify(r.json)?.slice(0, 300)}`);
  });
  test(`${name} refuses a caller without Basic auth (401)`, async () => {
    const r = await jira(ep.method, path, CALLS[name].body, { auth: '' });
    assert.equal(r.status, 401);
    assert.ok(Array.isArray(r.json.errorMessages));
  });
  if (path.includes('DEMO-1')) {
    test(`${name} answers 404 for an issue that does not exist`, async () => {
      const r = await jira(ep.method, path.replace('DEMO-1', 'DEMO-999'), CALLS[name].body);
      assert.equal(r.status, 404);
      assert.match(r.json.errorMessages[0], /does not exist/);
    });
  }
}

test('search/jql returns only ids by default, and pages with nextPageToken', async () => {
  await reset();
  const bare = await jira('POST', '/rest/api/3/search/jql', { jql: 'project = DEMO' });
  assert.deepEqual(Object.keys(bare.json.issues[0]).sort(), ['id', 'key', 'self']);
  const p1 = await jira('POST', '/rest/api/3/search/jql', { jql: 'project = DEMO ORDER BY key ASC', maxResults: 4, fields: ['summary'] });
  assert.equal(p1.json.issues.length, 4);
  assert.equal(p1.json.isLast, false);
  const p2 = await jira('POST', '/rest/api/3/search/jql', { jql: 'project = DEMO ORDER BY key ASC', maxResults: 4, fields: ['summary'], nextPageToken: p1.json.nextPageToken });
  assert.equal(p2.json.issues[0].key, 'DEMO-5');
});

test('JQL: every supported clause filters the way Jira does', async () => {
  await reset();
  const keys = async (jql) => (await jira('POST', '/rest/api/3/search/jql', { jql, fields: ['summary'], maxResults: 100 })).json.issues.map((i) => i.key);
  assert.equal((await keys('project = DEMO')).length, SEED_ISSUES.length);
  assert.equal((await keys('project in (DEMO, OTHER)')).length, SEED_ISSUES.length);
  assert.deepEqual(await keys('project = OTHER'), []);
  assert.equal((await keys('project = DEMO AND issuetype = Bug')).length, SEED_ISSUES.length);
  assert.deepEqual(await keys('issuetype = Story'), []);
  assert.equal((await keys('issuetype in (Bug, Task)')).length, SEED_ISSUES.length);
  assert.deepEqual(await keys('key = DEMO-3'), ['DEMO-3']);
  assert.deepEqual(await keys('updated >= -1m'), [], 'the seed is older than a minute');
  assert.equal((await keys('updated >= -1d')).length, SEED_ISSUES.length);
  const desc = await keys('project = DEMO ORDER BY created DESC');
  assert.equal(desc[0], `DEMO-${SEED_ISSUES.length}`);
  // A comment moves `updated`: the issue shows up in "updated in the last minute" and first by updated DESC.
  await jira('POST', '/rest/api/3/issue/DEMO-2/comment', { body: textToAdf('looking') });
  assert.deepEqual(await keys('project = DEMO AND updated >= -1m'), ['DEMO-2']);
  assert.equal((await keys('project = DEMO ORDER BY updated DESC'))[0], 'DEMO-2');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await keys(`updated >= "${today} 00:00"`)).length >= 1, true);
  const bad = await jira('POST', '/rest/api/3/search/jql', { jql: 'assignee = currentUser()' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errorMessages[0], /JQL/);
});

test('compileJql is the same parser the endpoint uses', () => {
  const now = Date.UTC(2026, 10, 21, 12, 0);
  const { match } = compileJql('updated >= "2026-11-21 11:30"', now);
  assert.equal(match({ updated: Date.UTC(2026, 10, 21, 11, 45) }), true);
  assert.equal(match({ updated: Date.UTC(2026, 10, 21, 11, 0) }), false);
});

test('ADF: a comment round-trips, and a comment that is not ADF is refused (400)', async () => {
  await reset();
  const text = 'Thanks for the report.\n\nWe found the cause:\nthe total is not rounded.';
  const posted = await jira('POST', '/rest/api/3/issue/DEMO-1/comment', { body: textToAdf(text) });
  assert.equal(posted.status, 201);
  const list = await jira('GET', '/rest/api/3/issue/DEMO-1/comment');
  assert.equal(adfToText(list.json.comments.at(-1).body), text);
  assert.equal(list.json.comments.at(-1).author.accountId, SERVICE_ACCOUNT.accountId);
  const plain = await jira('POST', '/rest/api/3/issue/DEMO-1/comment', { body: 'just a string' });
  assert.equal(plain.status, 400);
});

test('labels: add, remove and set through update; the issue shows them', async () => {
  await reset();
  await jira('PUT', '/rest/api/3/issue/DEMO-1', { update: { labels: [{ add: 'ai-triaged' }, { add: 'ai-reproduced' }] } });
  await jira('PUT', '/rest/api/3/issue/DEMO-1', { update: { labels: [{ remove: 'ai-triaged' }] } });
  assert.deepEqual((await jira('GET', '/rest/api/3/issue/DEMO-1?fields=labels')).json.fields.labels, ['ai-reproduced']);
  await jira('PUT', '/rest/api/3/issue/DEMO-1', { fields: { labels: ['x', 'y'] } });
  assert.deepEqual((await jira('GET', '/rest/api/3/issue/DEMO-1?fields=labels')).json.fields.labels, ['x', 'y']);
  assert.equal((await jira('PUT', '/rest/api/3/issue/DEMO-1', { update: { labels: [{ add: 'has space' }] } })).status, 400);
});

test('transitions move the status; an unknown transition is refused', async () => {
  await reset();
  await jira('POST', '/rest/api/3/issue/DEMO-1/transitions', { transition: { id: '31' } });
  assert.equal((await jira('GET', '/rest/api/3/issue/DEMO-1?fields=status')).json.fields.status.name, 'In Review');
  assert.equal((await jira('POST', '/rest/api/3/issue/DEMO-1/transitions', { transition: { id: '999' } })).status, 400);
});

test('the reporter can answer (test control), and the answer reads as theirs', async () => {
  await reset();
  const r = await fetch(`${sim.baseUrl}/__comment-as-reporter`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'DEMO-8', text: 'The invoice list page shows a blank screen.' }) });
  assert.equal(r.status, 201);
  const issue = (await jira('GET', '/rest/api/3/issue/DEMO-8')).json;
  const last = issue.fields.comment.comments.at(-1);
  assert.equal(last.author.accountId, issue.fields.reporter.accountId);
  assert.match(adfToText(last.body), /blank screen/);
});

test('/__state shows every issue with its comments and remote links', async () => {
  await reset();
  await jira('POST', '/rest/api/3/issue/DEMO-1/remotelink', { object: { url: 'https://example.test/pr/1', title: 'PR' } });
  const s = await (await fetch(`${sim.baseUrl}/__state`)).json();
  assert.equal(s.issues.length, SEED_ISSUES.length);
  assert.equal(s.issues.find((i) => i.key === 'DEMO-1').remotelinks.length, 1);
});
