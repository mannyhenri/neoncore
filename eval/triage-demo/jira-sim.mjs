#!/usr/bin/env node
/**
 * A LOCAL JIRA — the subset of the Jira Cloud REST API v3 that NeonCore's Bug Triage uses, with
 * the same paths, shapes and status codes as Atlassian's, so the triage engine's Jira client is the
 * real one and only the base URL changes. Dependency-free; state is in memory.
 *
 *   node eval/triage-demo/jira-sim.mjs --port 4071          (seeded with seed.mjs)
 *   import { startJiraSim } from './jira-sim.mjs'           ({port, seed} → {baseUrl, close, state})
 *
 * Auth: HTTP Basic (email:API token), as Jira Cloud. Any non-empty pair is accepted; none → 401.
 *
 * Endpoints (registry: ENDPOINTS):
 *   POST /rest/api/3/search/jql            {jql, fields, maxResults, nextPageToken} → {issues, nextPageToken?, isLast}
 *   GET  /rest/api/3/issue/{key}?fields=
 *   PUT  /rest/api/3/issue/{key}           {fields:{labels}} | {update:{labels:[{add}|{remove}|{set}]}} → 204
 *   GET  /rest/api/3/issue/{key}/comment   POST {body: ADF} → 201
 *   GET  /rest/api/3/issue/{key}/transitions   POST {transition:{id}} → 204
 *   POST /rest/api/3/issue/{key}/remotelink    {object:{url, title}} → 201
 *   POST /rest/api/3/issue                 {fields:{project:{key}, summary, issuetype:{name}, description}} → 201
 *   GET  /rest/api/3/myself
 * Test-only (not Jira): GET /__state · POST /__reset · POST /__comment-as-reporter {key, text}
 *
 * JQL: clauses joined by AND — `project = A`, `project in (A, B)`, `issuetype = Bug`,
 * `issuetype in (Bug, Task)`, `key = A-1`, `updated|created >=|>|<=|< "yyyy-MM-dd HH:mm"` or a
 * relative `-10m` / `-2h` / `-1d` — then `ORDER BY updated|created|key [ASC|DESC]`. Times are UTC
 * (Jira reads them in the user's time zone; the simulator's user is in UTC). Anything else → 400,
 * as Jira answers an unparseable query.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { isAdfDoc, textToAdf } from './adf.mjs';
import { PROJECT, REPORTERS, SEED_ISSUES } from './seed.mjs';

export const SERVICE_ACCOUNT = { accountId: '712020:neoncore-triage-bot', displayName: 'NeonCore Triage', emailAddress: 'triage-bot@ledgerly.test', active: true, accountType: 'atlassian', timeZone: 'UTC' };

const STATUSES = {
  open: { id: '10001', name: 'Open', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
  progress: { id: '3', name: 'In Progress', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
  review: { id: '10002', name: 'In Review', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
  done: { id: '10003', name: 'Done', statusCategory: { id: 3, key: 'done', name: 'Done' } },
};
const TRANSITIONS = [
  { id: '11', name: 'To Do', to: STATUSES.open },
  { id: '21', name: 'In Progress', to: STATUSES.progress },
  { id: '31', name: 'In Review', to: STATUSES.review },
  { id: '41', name: 'Done', to: STATUSES.done },
];
const ISSUE_TYPES = { Bug: { id: '10004', name: 'Bug', subtask: false }, Task: { id: '10002', name: 'Task', subtask: false }, Story: { id: '10001', name: 'Story', subtask: false } };

/** Jira's timestamp format: 2026-11-21T10:00:00.000+0000 */
export const jiraTime = (ms) => new Date(ms).toISOString().replace('Z', '+0000');
const parseJiraTime = (s) => Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

function freshState(seed, now) {
  const issues = new Map();
  const start = now - (seed.length + 5) * 60_000;
  seed.forEach((s, i) => {
    const at = start + i * 60_000;
    const key = `${PROJECT.key}-${i + 1}`;
    issues.set(key, {
      id: String(10100 + i), key, project: PROJECT,
      summary: s.summary, description: textToAdf(s.description),
      issuetype: ISSUE_TYPES[s.type] ?? ISSUE_TYPES.Bug, status: STATUSES.open,
      reporter: REPORTERS[s.reporter] ?? REPORTERS.dana, labels: [...(s.labels ?? [])],
      created: at, updated: at, comments: [], issuelinks: [], remotelinks: [],
    });
  });
  return { issues, nextIssue: seed.length + 1, nextComment: 20000, nextLink: 30000, requests: [] };
}

class HttpError extends Error {
  constructor(status, messages, errors = {}) { super(messages[0] ?? String(status)); this.status = status; this.body = { errorMessages: messages, errors }; }
}
const notFound = () => new HttpError(404, ['Issue does not exist or you do not have permission to see it.']);

// ── JQL ──────────────────────────────────────────────────────────────────────────────────

function parseWhen(raw, now) {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  const rel = /^(-?\d+)\s*([mhdw])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]); const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase()];
    return now + n * unit;
  }
  const abs = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(v);
  if (abs) return Date.UTC(+abs[1], +abs[2] - 1, +abs[3], +(abs[4] ?? 0), +(abs[5] ?? 0));
  throw new HttpError(400, [`Error in the JQL Query: Date value '${v}' for field 'updated' is invalid.`]);
}

const list = (s) => s.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

/** A JQL string → a predicate and a sort. */
export function compileJql(jql, now = Date.now()) {
  const text = String(jql ?? '').trim();
  const [where, order] = text.split(/\s+ORDER\s+BY\s+/i);
  const tests = [];
  if (where && where.trim()) {
    for (const clause of where.split(/\s+AND\s+/i)) {
      const c = clause.trim();
      let m;
      if ((m = /^project\s*=\s*"?([\w-]+)"?$/i.exec(c))) { const p = m[1].toUpperCase(); tests.push((i) => i.project.key === p); continue; }
      if ((m = /^project\s+in\s*(\(.*\))$/i.exec(c))) { const ps = list(m[1]).map((p) => p.toUpperCase()); tests.push((i) => ps.includes(i.project.key)); continue; }
      if ((m = /^(?:issuetype|type)\s*=\s*"?([\w ]+?)"?$/i.exec(c))) { const t = m[1].toLowerCase(); tests.push((i) => i.issuetype.name.toLowerCase() === t); continue; }
      if ((m = /^(?:issuetype|type)\s+in\s*(\(.*\))$/i.exec(c))) { const ts = list(m[1]).map((t) => t.toLowerCase()); tests.push((i) => ts.includes(i.issuetype.name.toLowerCase())); continue; }
      if ((m = /^(?:key|issue|issuekey)\s*=\s*"?([\w-]+)"?$/i.exec(c))) { const k = m[1].toUpperCase(); tests.push((i) => i.key === k); continue; }
      if ((m = /^(updated|created)\s*(>=|<=|>|<)\s*(.+)$/i.exec(c))) {
        const field = m[1].toLowerCase(); const op = m[2]; const at = parseWhen(m[3], now);
        tests.push((i) => (op === '>=' ? i[field] >= at : op === '>' ? i[field] > at : op === '<=' ? i[field] <= at : i[field] < at));
        continue;
      }
      throw new HttpError(400, [`Error in the JQL Query: The query '${c}' is not supported.`]);
    }
  }
  let sort = (a, b) => a.created - b.created;
  if (order) {
    const m = /^(updated|created|key)\s*(ASC|DESC)?$/i.exec(order.trim());
    if (!m) throw new HttpError(400, [`Error in the JQL Query: ORDER BY '${order.trim()}' is not supported.`]);
    const f = m[1].toLowerCase(); const dir = (m[2] ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
    const val = (i) => (f === 'key' ? Number(i.key.split('-')[1]) : i[f]);
    sort = (a, b) => (val(a) - val(b)) * dir;
  }
  return { match: (i) => tests.every((t) => t(i)), sort };
}

// ── shapes ───────────────────────────────────────────────────────────────────────────────

function commentOut(base, issue, c) {
  return { self: `${base}/rest/api/3/issue/${issue.id}/comment/${c.id}`, id: c.id, author: c.author, body: c.body, updateAuthor: c.author, created: jiraTime(c.created), updated: jiraTime(c.created), jsdPublic: true };
}

function allFields(base, issue) {
  return {
    summary: issue.summary,
    description: issue.description,
    issuetype: issue.issuetype,
    status: issue.status,
    project: { self: `${base}/rest/api/3/project/${issue.project.id}`, ...issue.project },
    reporter: { self: `${base}/rest/api/3/user?accountId=${encodeURIComponent(issue.reporter.accountId)}`, ...issue.reporter, active: true },
    labels: [...issue.labels],
    created: jiraTime(issue.created),
    updated: jiraTime(issue.updated),
    comment: { comments: issue.comments.map((c) => commentOut(base, issue, c)), maxResults: issue.comments.length, total: issue.comments.length, startAt: 0 },
    issuelinks: issue.issuelinks,
    attachment: [],
  };
}

/** An issue as Jira returns it, with only the requested fields (`*all` / `*navigable` = every one). */
function issueOut(base, issue, fields) {
  const all = allFields(base, issue);
  const wanted = !fields || fields.length === 0 || fields.some((f) => f === '*all' || f === '*navigable')
    ? Object.keys(all)
    : fields.filter((f) => !f.startsWith('-'));
  const out = {};
  for (const f of wanted) if (f in all) out[f] = all[f];
  return { expand: 'renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations', id: issue.id, self: `${base}/rest/api/3/issue/${issue.id}`, key: issue.key, fields: out };
}

// ── the server ───────────────────────────────────────────────────────────────────────────

/** Every Jira endpoint the simulator serves — the registry the tests iterate. */
export const ENDPOINTS = [
  { method: 'POST', path: '/rest/api/3/search/jql' },
  { method: 'GET', path: '/rest/api/3/issue/{key}' },
  { method: 'PUT', path: '/rest/api/3/issue/{key}' },
  { method: 'GET', path: '/rest/api/3/issue/{key}/comment' },
  { method: 'POST', path: '/rest/api/3/issue/{key}/comment' },
  { method: 'GET', path: '/rest/api/3/issue/{key}/transitions' },
  { method: 'POST', path: '/rest/api/3/issue/{key}/transitions' },
  { method: 'POST', path: '/rest/api/3/issue/{key}/remotelink' },
  { method: 'POST', path: '/rest/api/3/issue' },
  { method: 'GET', path: '/rest/api/3/myself' },
];

function authorised(req) {
  const m = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return !!user && rest.join(':').length > 0;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, ['Unexpected character in the request body: it is not JSON.']); }
}

export function startJiraSim({ port = 4071, host = '127.0.0.1', seed = SEED_ISSUES, now = () => Date.now() } = {}) {
  let state = freshState(seed, now());
  let base = '';
  const issueOr404 = (key) => {
    const k = decodeURIComponent(key).toUpperCase();
    const byKey = state.issues.get(k) ?? [...state.issues.values()].find((i) => i.id === k);
    if (!byKey) throw notFound();
    return byKey;
  };
  const touch = (issue) => { issue.updated = Math.max(now(), issue.updated + 1); };
  const addComment = (issue, author, body) => {
    const c = { id: String(state.nextComment++), author, body, created: now() };
    issue.comments.push(c); touch(issue);
    return c;
  };

  const handlers = {
    'POST /rest/api/3/search/jql': async (req) => {
      const body = await readJson(req);
      if (typeof body.jql !== 'string') throw new HttpError(400, ['The JQL query is required (jql).']);
      const { match, sort } = compileJql(body.jql, now());
      const all = [...state.issues.values()].filter(match).sort(sort);
      const maxResults = Math.min(5000, Math.max(1, Number(body.maxResults) || 50));
      const startAt = body.nextPageToken ? Number(Buffer.from(String(body.nextPageToken), 'base64url').toString()) || 0 : 0;
      const page = all.slice(startAt, startAt + maxResults);
      const fields = Array.isArray(body.fields) ? body.fields.map(String) : (typeof body.fields === 'string' ? body.fields.split(',') : ['id']);
      const isLast = startAt + maxResults >= all.length;
      return [200, {
        issues: page.map((i) => (fields.length === 1 && fields[0] === 'id' ? { id: i.id, self: `${base}/rest/api/3/issue/${i.id}`, key: i.key } : issueOut(base, i, fields))),
        ...(isLast ? {} : { nextPageToken: Buffer.from(String(startAt + maxResults)).toString('base64url') }),
        isLast,
      }];
    },
    'GET /rest/api/3/issue/{key}': async (_req, p, url) => {
      const fields = url.searchParams.get('fields');
      return [200, issueOut(base, issueOr404(p.key), fields ? fields.split(',') : null)];
    },
    'PUT /rest/api/3/issue/{key}': async (req, p) => {
      const issue = issueOr404(p.key);
      const body = await readJson(req);
      if (body.fields && 'labels' in body.fields) {
        if (!Array.isArray(body.fields.labels)) throw new HttpError(400, [], { labels: 'Labels must be an array.' });
        issue.labels = [...new Set(body.fields.labels.map(String))];
      }
      for (const op of body.update?.labels ?? []) {
        if (op.add !== undefined) { if (/\s/.test(op.add)) throw new HttpError(400, [], { labels: 'The label must not contain spaces.' }); if (!issue.labels.includes(op.add)) issue.labels.push(String(op.add)); }
        if (op.remove !== undefined) issue.labels = issue.labels.filter((l) => l !== op.remove);
        if (op.set !== undefined) issue.labels = [...new Set(op.set.map(String))];
      }
      if (body.fields?.summary !== undefined) issue.summary = String(body.fields.summary);
      touch(issue);
      return [204, null];
    },
    'GET /rest/api/3/issue/{key}/comment': async (_req, p) => {
      const issue = issueOr404(p.key);
      return [200, { startAt: 0, maxResults: 5000, total: issue.comments.length, comments: issue.comments.map((c) => commentOut(base, issue, c)) }];
    },
    'POST /rest/api/3/issue/{key}/comment': async (req, p) => {
      const issue = issueOr404(p.key);
      const body = await readJson(req);
      if (!isAdfDoc(body.body)) throw new HttpError(400, ['Comment body is not valid. It must be an Atlassian Document Format document (type "doc", version 1).']);
      return [201, commentOut(base, issue, addComment(issue, SERVICE_ACCOUNT, body.body))];
    },
    'GET /rest/api/3/issue/{key}/transitions': async (_req, p) => {
      issueOr404(p.key);
      return [200, { expand: 'transitions', transitions: TRANSITIONS.map((t) => ({ ...t, hasScreen: false, isGlobal: true, isInitial: false, isAvailable: true, isConditional: false })) }];
    },
    'POST /rest/api/3/issue/{key}/transitions': async (req, p) => {
      const issue = issueOr404(p.key);
      const body = await readJson(req);
      const t = TRANSITIONS.find((x) => x.id === String(body.transition?.id ?? ''));
      if (!t) throw new HttpError(400, ['Transition id is not valid for this issue.']);
      issue.status = t.to; touch(issue);
      return [204, null];
    },
    'POST /rest/api/3/issue/{key}/remotelink': async (req, p) => {
      const issue = issueOr404(p.key);
      const body = await readJson(req);
      if (!body.object?.url || !body.object?.title) throw new HttpError(400, [], { object: 'A remote link needs object.url and object.title.' });
      const id = state.nextLink++;
      issue.remotelinks.push({ id, ...body }); touch(issue);
      return [201, { id, self: `${base}/rest/api/3/issue/${issue.key}/remotelink/${id}` }];
    },
    'POST /rest/api/3/issue': async (req) => {
      const body = await readJson(req);
      const f = body.fields ?? {};
      if (String(f.project?.key ?? '').toUpperCase() !== PROJECT.key) throw new HttpError(400, [], { project: 'Specify a valid project ID or key' });
      if (!f.summary) throw new HttpError(400, [], { summary: 'You must specify a summary of the issue.' });
      const type = ISSUE_TYPES[f.issuetype?.name ?? ''];
      if (!type) throw new HttpError(400, [], { issuetype: 'Specify an issue type' });
      if (f.description !== undefined && !isAdfDoc(f.description)) throw new HttpError(400, [], { description: 'Operation value must be an Atlassian Document.' });
      const key = `${PROJECT.key}-${state.nextIssue}`; const id = String(10100 + state.nextIssue - 1); state.nextIssue++;
      const at = now();
      state.issues.set(key, { id, key, project: PROJECT, summary: String(f.summary), description: f.description ?? null, issuetype: type, status: STATUSES.open, reporter: SERVICE_ACCOUNT, labels: Array.isArray(f.labels) ? f.labels.map(String) : [], created: at, updated: at, comments: [], issuelinks: [], remotelinks: [] });
      return [201, { id, key, self: `${base}/rest/api/3/issue/${id}` }];
    },
    'GET /rest/api/3/myself': async () => [200, { self: `${base}/rest/api/3/user?accountId=${SERVICE_ACCOUNT.accountId}`, ...SERVICE_ACCOUNT }],
  };

  const route = (method, pathname) => {
    for (const ep of ENDPOINTS) {
      if (ep.method !== method) continue;
      const re = new RegExp(`^${ep.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
      const m = re.exec(pathname);
      if (m) return { handler: handlers[`${ep.method} ${ep.path}`], params: m.groups ?? {} };
    }
    return null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, body === null ? {} : { 'content-type': 'application/json;charset=UTF-8' });
      res.end(body === null ? undefined : JSON.stringify(body));
    };
    try {
      state.requests.push({ method: req.method, path: url.pathname });
      // Test-only controls — not part of Jira, no auth.
      if (url.pathname === '/__state' && req.method === 'GET') {
        return send(200, { issues: [...state.issues.values()].map((i) => ({ ...issueOut(base, i, ['*all']), remotelinks: i.remotelinks })), requests: state.requests.slice(-200) });
      }
      if (url.pathname === '/__reset' && req.method === 'POST') { state = freshState(seed, now()); return send(200, { ok: true }); }
      if (url.pathname === '/__comment-as-reporter' && req.method === 'POST') {
        const body = await readJson(req);
        const issue = issueOr404(String(body.key ?? ''));
        const c = addComment(issue, issue.reporter, textToAdf(String(body.text ?? '')));
        return send(201, commentOut(base, issue, c));
      }
      const r = route(req.method ?? 'GET', url.pathname);
      if (!r) return send(404, { errorMessages: ['No resource found for this path.'], errors: {} });
      if (!authorised(req)) return send(401, { errorMessages: ['You are not authenticated. Authentication required to perform this operation.'], errors: {} });
      const [status, body] = await r.handler(req, r.params, url);
      send(status, body);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, e.body);
      send(500, { errorMessages: [String(e?.message ?? e)], errors: {} });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      base = `http://${host}:${server.address().port}`;
      resolve({
        baseUrl: base,
        get state() { return state; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 4071;
  startJiraSim({ port }).then((sim) => {
    console.log(`Jira simulator on ${sim.baseUrl} — ${sim.state.issues.size} seeded issues in project DEMO`);
  });
}
