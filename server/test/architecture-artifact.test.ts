/**
 * The architecture is a page you look at, not a Markdown file.
 *
 * REQUESTED: "for the architecture generation, I'd like instead of doing an MD to generate an
 * artifact that shows in the architecture tab". Generate with AI now asks for `architectureHtml`: a
 * self-contained page (inline CSS and SVG diagrams, no scripts). It must travel the whole way —
 * every place the architecture goes, the page goes too:
 *   prompt    → asks for it, and only when the architecture is asked for
 *   proposal  → kept (scripts stripped, so it cannot act as the server's origin), dropped if not asked
 *   apply     → written onto the project
 *   project   → the API says it has one (the tab shows it from the route below)
 *   route     → GET /docs/architecture?format=html serves it, sandboxed by CSP
 *   publish   → docs/product/ARCHITECTURE.html
 * The short text notes stay — the planner reads text when it scopes each feature.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  normalizeImport, createImportRow, submitImport, applyImport, buildImportPrompt,
} from '../src/lib/project-import.ts';
import { projectDocFiles } from '../src/lib/project-docs.ts';
import projectsRouter from '../src/routes/projects.ts';

installStubIO();
const ISO = new Date().toISOString();
let n = 0;
function project(): string {
  const id = `arch-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,NULL,?,'','/tmp/arch-repo','#fff',?,?)`).run(id, `proj ${id}`, ISO, ISO);
  return id;
}

const PAGE = '<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body>'
  + '<h1>How it is built</h1><svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'
  + '<script>fetch("/api/agents")</script><button onclick="steal()">x</button></body></html>';

const app = express();
app.use(express.json());
app.use('/api/projects', projectsRouter);
const server = app.listen(0, '127.0.0.1');
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('the prompt asks for the page only when the architecture is asked for', () => {
  const pid = project();
  assert.match(buildImportPrompt(createImportRow(pid, 'a', ['architecture'])), /architectureHtml/);
  assert.doesNotMatch(buildImportPrompt(createImportRow(pid, 'a', ['features'])), /architectureHtml/);
});

test('a proposal keeps the page without its scripts, and drops it when it was not asked for', () => {
  const out = normalizeImport({ architecture: 'notes', architectureHtml: PAGE }, { listed: [], parts: ['architecture'] });
  assert.ok(out.value, out.error);
  assert.match(out.value!.architectureHtml, /<svg/);
  assert.doesNotMatch(out.value!.architectureHtml, /<script|onclick=/i, 'scripts must not survive into the page');
  const page = normalizeImport({ architectureHtml: PAGE }, { listed: [], parts: ['architecture'] });
  assert.ok(page.value, 'a page alone is a usable answer');
  const notAsked = normalizeImport({ architectureHtml: PAGE, features: [{ name: 'X' }] }, { listed: [], parts: ['features'] });
  assert.equal(notAsked.value!.architectureHtml, '');
});

test('applied, the page reaches every place the architecture goes', async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const pid = project();
  const imp = createImportRow(pid, 'a', ['architecture']);
  submitImport(imp.id, { architecture: 'API → queue → workers', architectureHtml: PAGE });
  applyImport(imp.id, { architecture: 'API → queue → workers', architectureHtml: true });

  const row = db.prepare('SELECT architecture, architecture_html FROM projects WHERE id = ?').get(pid) as { architecture: string; architecture_html: string };
  assert.equal(row.architecture, 'API → queue → workers', 'the planner\'s text notes were lost');
  assert.match(row.architecture_html, /How it is built/);

  const proj = await (await fetch(`${base()}/api/projects/${pid}`)).json() as { project: { hasArchitecturePage?: boolean } };
  assert.equal(proj.project.hasArchitecturePage, true, 'the project API does not say it has a page');

  const tab = await (await fetch(`${base()}/api/projects/${pid}/architecture`)).json() as { html: string };
  assert.match(tab.html, /How it is built/, 'the Architecture tab\'s route does not return the page');

  const res = await fetch(`${base()}/api/projects/${pid}/docs/architecture?format=html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /html/);
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/, 'the page must be served sandboxed');
  assert.match(await res.text(), /How it is built/);

  const files = projectDocFiles(pid)!.files;
  assert.match(files.get('docs/product/ARCHITECTURE.html') ?? '', /How it is built/, 'publishing does not write the page');
});
