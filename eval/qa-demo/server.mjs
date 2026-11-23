#!/usr/bin/env node
/**
 * QA DEMO — a small daily-report app with EIGHT BUGS PLANTED ON PURPOSE, for proving the QA
 * section (docs/plans/qa-section.md). The bugs are listed in BUGS.md, which is for verifying a run
 * only: an explorer under test must never be shown it.
 *
 *   node eval/qa-demo/server.mjs --port 4061
 *
 * Dependency-free, in-memory, reset on every start. Variants, for self-repair:
 *   A  normal
 *   B  the "Submit" button is renamed "Send report", and the Hours field moves below Notes
 *   C  the approval feature is removed
 * chosen by QA_DEMO_VARIANT, or `POST /__variant {"variant":"B"}` from this machine only.
 * `POST /__reset` (this machine only) restores the seed data.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const USERS = {
  supervisor: { password: () => process.env.QA_DEMO_SUPERVISOR_PASS || 'supervisor-demo', role: 'supervisor', name: 'Sam Supervisor' },
  worker: { password: () => process.env.QA_DEMO_WORKER_PASS || 'worker-demo', role: 'worker', name: 'Wren Worker' },
};
const VARIANTS = ['A', 'B', 'C'];

function seed() {
  return [
    { id: 1, project: 'Harbour', date: '2026-11-17', hours: 7.5, notes: 'Poured the east footing.', author: 'worker', status: 'Approved' },
    { id: 2, project: 'Beacon', date: '2026-11-18', hours: 8, notes: 'Framing, level 2.', author: 'worker', status: 'Awaiting approval' },
    { id: 3, project: 'Alpha', date: '2026-11-19', hours: 6, notes: 'Site survey and safety walk.', author: 'worker', status: 'Awaiting approval' },
  ];
}

export function createDemo({ variant = process.env.QA_DEMO_VARIANT || 'A', recorderSrc = process.env.QA_DEMO_RECORDER || '' } = {}) {
  const state = { variant: VARIANTS.includes(variant) ? variant : 'A', reports: seed(), nextId: 4, sessions: new Map() };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const userOf = (req) => {
    const sid = /(?:^|;\s*)demo_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const name = sid ? state.sessions.get(sid) : undefined;
    return name ? { id: name, ...USERS[name] } : null;
  };
  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

  const page = (title, user, body, { script = '' } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Daily Reports</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f6fa; color: #1b2230; }
  header { background: #1f3a5f; color: #fff; padding: 12px 20px; display: flex; gap: 18px; align-items: center; }
  header a { color: #cfe3ff; text-decoration: none; } header .who { margin-left: auto; font-size: 14px; }
  main { max-width: 760px; margin: 24px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 8px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 16px; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  input, select, textarea { font: inherit; padding: 6px 8px; width: 100%; box-sizing: border-box; }
  button { font: inherit; padding: 7px 14px; margin-top: 14px; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3e7ee; }
  .error { color: #b00020; font-weight: 600; }
  .status { font-weight: 700; }
</style>
${recorderSrc ? `<script src="${esc(recorderSrc)}" defer></script>` : ''}
</head><body>
<header><strong>Daily Reports</strong>
${user ? `<nav><a href="/reports">Reports</a> · <a href="/reports/new">New report</a> · <a href="/help">Help</a></nav>
<span class="who">${esc(user.name)} (${esc(user.role)}) · <a href="/logout">Log out</a></span>` : ''}
</header>
<main>${body}</main>
${script ? `<script>${script}</script>` : ''}
</body></html>`;

  const send = (res, status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const redirect = (res, to, headers = {}) => { res.writeHead(303, { location: to, ...headers }); res.end(); };
  const body = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 100_000) req.destroy(); });
    req.on('end', () => {
      if ((req.headers['content-type'] || '').includes('application/json')) { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } return; }
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
  });

  const reportForm = (values = {}, error = '') => {
    const hours = `<label for="hours">Hours</label><input id="hours" name="hours" value="${esc(values.hours ?? '')}" inputmode="decimal">`;
    const notes = `<label for="notes">Notes</label><textarea id="notes" name="notes" rows="3">${esc(values.notes ?? '')}</textarea>`;
    return `<div class="card"><h1>New daily report</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/reports/new">
  <label for="project">Project</label><input id="project" name="project" value="${esc(values.project ?? '')}">
  <label for="date">Date</label><input id="date" name="date" placeholder="YYYY-MM-DD" value="${esc(values.date ?? '')}">
  ${state.variant === 'B' ? `${notes}${hours}` : `${hours}${notes}`}
  <button type="submit">${state.variant === 'B' ? 'Send report' : 'Submit'}</button>
</form></div>`;
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://demo.local');
    const path = url.pathname;
    const user = userOf(req);

    // ── test controls, this machine only ──
    if (path === '/__variant' && req.method === 'POST') {
      if (!isLocal(req)) return json(res, 403, { error: 'local only' });
      const v = String((await body(req)).variant || '').toUpperCase();
      if (!VARIANTS.includes(v)) return json(res, 400, { error: `variant must be one of ${VARIANTS.join(', ')}` });
      state.variant = v;
      return json(res, 200, { variant: v });
    }
    if (path === '/__reset' && req.method === 'POST') {
      if (!isLocal(req)) return json(res, 403, { error: 'local only' });
      state.reports = seed(); state.nextId = 4; state.sessions.clear();
      return json(res, 200, { ok: true });
    }
    if (path === '/__variant' && req.method === 'GET') return json(res, 200, { variant: state.variant });

    if (path === '/') return redirect(res, user ? '/reports' : '/login');

    if (path === '/login' && req.method === 'GET') {
      return send(res, 200, page('Log in', null, `<div class="card"><h1>Log in</h1>
<form method="post" action="/login">
  <label for="username">Username</label><input id="username" name="username" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit">Log in</button>
</form></div>`));
    }
    if (path === '/login' && req.method === 'POST') {
      const { username = '', password = '' } = await body(req);
      const u = USERS[username];
      if (!u || u.password() !== password) {
        return send(res, 401, page('Log in', null, `<div class="card"><h1>Log in</h1><p class="error" role="alert">Wrong username or password.</p>
<form method="post" action="/login">
  <label for="username">Username</label><input id="username" name="username" value="${esc(username)}">
  <label for="password">Password</label><input id="password" name="password" type="password">
  <button type="submit">Log in</button>
</form></div>`));
      }
      const sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      state.sessions.set(sid, username);
      return redirect(res, '/reports', { 'set-cookie': `demo_session=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (path === '/logout') return redirect(res, '/login', { 'set-cookie': 'demo_session=; Path=/; Max-Age=0' });

    // BUG 3 — the Help link in the nav goes nowhere.
    if (path === '/help') return send(res, 404, page('Not found', user, '<div class="card"><h1>Page not found</h1></div>'));

    if (!user) return redirect(res, '/login');

    if (path === '/reports' && req.method === 'GET') {
      const rows = state.reports.map((r, i) => `<tr data-id="${r.id}"><td><a href="/reports/${r.id}">${esc(r.project)}</a></td><td>${esc(r.date)}</td><td>${esc(r.hours)}</td>
<td class="status">${esc(r.status)}</td><td>${user.role === 'supervisor' && r.status === 'Awaiting approval' && state.variant !== 'C'
        ? `<form method="post" action="/reports/quick-approve"><input type="hidden" name="row" value="${i}"><button type="submit" style="margin:0">Quick approve</button></form>` : ''}</td></tr>`).join('');
      return send(res, 200, page('Reports', user, `<div class="card"><h1>Reports</h1>
<form id="filter" onsubmit="return false"><label for="filter-project">Filter by project</label><input id="filter-project" name="project">
<button type="button" id="filter-btn">Filter</button> <button type="button" id="export-btn">Export</button></form>
<p id="filter-msg" role="status"></p>
<table><thead><tr><th>Project</th><th>Date</th><th>Hours</th><th>Status</th><th></th></tr></thead><tbody id="rows">${rows}</tbody></table></div>`, {
        // BUG 1 — the list page throws on load (a console error).
        // BUG 2 — the filter calls an endpoint that answers 500.
        // BUG 4 — Export does nothing: no handler is ever attached.
        script: `
const summary = window.reportSummary;
document.title = document.title + ' (' + summary.length + ')';
`,
      }).replace('</body>', `<script>
document.getElementById('filter-btn').addEventListener('click', async () => {
  const q = document.getElementById('filter-project').value;
  const msg = document.getElementById('filter-msg');
  try {
    const r = await fetch('/api/reports?project=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    msg.textContent = data.length + ' report(s)';
  } catch (e) { msg.textContent = 'Could not filter reports.'; }
});
</script></body>`));
    }

    if (path === '/api/reports' && req.method === 'GET') {
      const q = url.searchParams.get('project') || '';
      // BUG 2 — any non-empty filter crashes the endpoint.
      if (q) return json(res, 500, { error: 'TypeError: Cannot read properties of undefined (reading \'toLowerCase\')' });
      return json(res, 200, state.reports);
    }

    if (path === '/reports/new' && req.method === 'GET') return send(res, 200, page('New report', user, reportForm()));
    if (path === '/reports/new' && req.method === 'POST') {
      const v = await body(req);
      const hours = Number(String(v.hours ?? '').trim());
      // BUG 5 — an empty project is accepted (no "Project is required").
      // BUG 6 — the date is never checked: "2026-13-45" is stored as given.
      if (!String(v.hours ?? '').trim() || !Number.isFinite(hours) || hours < 0 || hours > 24) {
        return send(res, 422, page('New report', user, reportForm(v, 'Hours must be a number between 0 and 24.')));
      }
      const report = { id: state.nextId++, project: String(v.project ?? '').trim(), date: String(v.date ?? '').trim(), hours, notes: String(v.notes ?? ''), author: user.id, status: 'Awaiting approval' };
      state.reports.push(report);
      return redirect(res, `/reports/${report.id}`);
    }

    if (path === '/reports/quick-approve' && req.method === 'POST') {
      if (state.variant === 'C') return send(res, 404, page('Not found', user, '<div class="card"><h1>Page not found</h1></div>'));
      if (user.role !== 'supervisor') return send(res, 403, page('Forbidden', user, '<div class="card"><h1>Only supervisors approve reports</h1></div>'));
      const row = Number((await body(req)).row);
      // BUG 7 — quick approve approves the row ABOVE the one clicked (off by one).
      const target = state.reports[row - 1] ?? state.reports[row];
      if (target) target.status = 'Approved';
      return redirect(res, '/reports');
    }

    const detail = /^\/reports\/(\d+)$/.exec(path);
    if (detail && req.method === 'GET') {
      const r = state.reports.find((x) => x.id === Number(detail[1]));
      if (!r) return send(res, 404, page('Not found', user, '<div class="card"><h1>Report not found</h1></div>'));
      const canApprove = user.role === 'supervisor' && r.status === 'Awaiting approval' && state.variant !== 'C';
      // BUG 8 — the detail card is visibly broken: the status stamp image is missing (404) and long
      // notes run out of the card instead of wrapping.
      return send(res, 200, page(`Report ${r.id}`, user, `<div class="card" style="width:420px; overflow:visible">
<img src="/static/stamp-${r.status === 'Approved' ? 'approved' : 'pending'}.png" alt="" width="64" height="64" style="float:right">
<h1>Report ${r.id}: ${esc(r.project) || '(no project)'}</h1>
<p>Date: ${esc(r.date)}</p><p>Hours: ${esc(r.hours)}</p>
<p style="white-space:nowrap">Notes: ${esc(r.notes)}</p>
<p>Status: <span class="status" id="status">${esc(r.status)}</span></p>
${canApprove ? `<form method="post" action="/reports/${r.id}/approve"><button type="submit">Approve</button></form>` : ''}
</div>`));
    }
    const approve = /^\/reports\/(\d+)\/approve$/.exec(path);
    if (approve && req.method === 'POST') {
      if (state.variant === 'C') return send(res, 404, page('Not found', user, '<div class="card"><h1>Page not found</h1></div>'));
      if (user.role !== 'supervisor') return send(res, 403, page('Forbidden', user, '<div class="card"><h1>Only supervisors approve reports</h1></div>'));
      const r = state.reports.find((x) => x.id === Number(approve[1]));
      if (r) r.status = 'Approved';
      return redirect(res, `/reports/${approve[1]}`);
    }

    return send(res, 404, page('Not found', user, '<div class="card"><h1>Page not found</h1></div>'));
  };

  const server = http.createServer((req, res) => { handler(req, res).catch((err) => { res.writeHead(500); res.end(String(err)); }); });
  return { server, state };
}

/** Start the demo on `port` (0 = any free port). Resolves with its base URL and a close(). */
export function startDemo({ port = 4061, host = '127.0.0.1', ...opts } = {}) {
  const { server, state } = createDemo(opts);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({ baseUrl: `http://${host}:${actual}`, port: actual, state, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 4061;
  startDemo({ port }).then(({ baseUrl, state }) => console.log(`QA demo (variant ${state.variant}) on ${baseUrl}`));
}
