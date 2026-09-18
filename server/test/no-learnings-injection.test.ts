/**
 * A RUN CARRIES ITS OWN WORKFLOW'S HISTORY, NEVER ANOTHER WORKFLOW'S.
 *
 * Every run created on a project had the last 3 `project_learnings` rows pasted into its
 * `initial_context`, each cut at `content.slice(0, 600)`, and `buildLaunchContext` put that in
 * front of the first step's prompt. Those rows hold WHOLE WORKFLOW REPORTS, not distilled
 * lessons, so what an agent actually received was a report from an unrelated workflow, sliced
 * mid-sentence.
 *
 * Reported as: a GPU architecture review of another repo ("Architecture Mapping … MMQ dots
 * int8 weights … RECOMMENDATION CONTRADICTS THE RESEARCH …") appearing inside the Daily AI
 * Research Digest. Measured: 19 runs across 5 workflows carried it, 16 step prompts received
 * it. The 600-char cut is the sharp edge — it lands mid-sentence on text that reads like an
 * order, and nothing marks it as history from somewhere else.
 *
 * SCOPED TO THE CURRENT WORKFLOW, as asked: a run may still be told what previous runs OF THE
 * SAME WORKFLOW learned, which is the useful half. What it must never receive is a different
 * workflow's report. Project membership is not relevance — "Gridlight" holds a research digest
 * and a CUDA inference engine, and nothing about sharing a project makes one relevant to the
 * other.
 *
 * SET-BASED OVER THE CLONE PATHS, because the injector was written TWICE — once in
 * lib/workflow-from-template.ts (scheduled runs, decompositions) and once inline in
 * routes/workflows.ts (the HTTP start handler), the same query in both. Turning off the one
 * you happen to be looking at leaves the other running. A third path must fail this test.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();
const iso = () => new Date().toISOString();
let base = '';
let server: Server;
let n = 0;

/** The real shape: a whole workflow report, well past the 600-char slice. */
const REPORT_DUMP =
  '## Workflow: Engineering Architecture Review\n\n### Architecture Mapping\n'
  + 'Architecture review complete, committed at d511af175. RECOMMENDATION CONTRADICTS THE '
  + 'RESEARCH, so the requested elimination was NOT performed: MMQ dots int8 weights against '
  + 'int8 activations with __dp4a, measured on a T4 at 72.5 to 46.2 tok/s. '
  + 'x'.repeat(900);

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/workflows', workflowsRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r();
    });
  });
});
test.after(() => server?.close());

function projectWithLearnings(): string {
  const projectId = `proj-${++n}`;
  db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(projectId, `Gridlight ${n}`, iso(), iso());
  return projectId;
}

/**
 * A learning left by a FINISHED run of `templateId`, on this project.
 * `foreign` makes it a different workflow's report — the thing that leaked.
 */
function learningFrom(projectId: string, templateId: string, name: string, content: string): void {
  const runId = `prior-${++n}`;
  db.prepare(
    `INSERT INTO workflows (id, name, status, run_number, template_id, project_id, created_at)
     VALUES (?, ?, 'completed', 1, ?, ?, ?)`,
  ).run(runId, name, templateId, projectId, iso());
  db.prepare(
    `INSERT INTO project_learnings (id, project_id, workflow_id, workflow_name, content, tags, created_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?)`,
  ).run(`l-${++n}`, projectId, runId, name, content, iso());
}

function cartridge(): string {
  const id = `ag-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,?,'/tmp/x',?,'claude','idle',?,?)`,
  ).run(id, id, os.hostname(), `repo-${id}`, iso(), `s-${id}`);
  io.connect(id);
  return id;
}

const template = (name: string) => (db.prepare(
  'SELECT id FROM workflows WHERE template_id IS NULL AND name = ?',
).get(name) as { id: string }).id;

/** The other workflow's report. Must never reach a run of a different workflow. */
const FOREIGN_MARKER = 'RECOMMENDATION CONTRADICTS THE RESEARCH';

const contextOf = (runId: string) => (db.prepare(
  'SELECT initial_context FROM workflows WHERE id = ?',
).get(runId) as { initial_context: string }).initial_context || '';

test('NO clone path carries another workflow\'s report into a run', async () => {
  const projectId = projectWithLearnings();
  const agentId = cartridge();
  const tplId = template('Daily AI Research Digest');
  // The exact shape of the bug: an architecture review of a CUDA engine, on the same project.
  learningFrom(projectId, template('Engineering Architecture Review'),
    'Engineering Architecture Review', REPORT_DUMP);

  // Both ways a run is created. A third must be added here or it is not covered.
  const res = await fetch(`${base}/api/workflows/v2/${tplId}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, projectId }),
  });
  const body = await res.text();
  assert.ok(res.ok, body);
  const httpRun = (JSON.parse(body) as { workflow: { id: string } }).workflow.id;

  const clonedRun = cloneTemplateAsRun(tplId, projectId, '', { agentId })!;
  assert.ok(clonedRun, 'cloneTemplateAsRun created nothing');

  const offenders: string[] = [];
  for (const [path, runId] of [['HTTP start', httpRun], ['cloneTemplateAsRun', clonedRun]] as const) {
    if (contextOf(runId).includes(FOREIGN_MARKER)) {
      offenders.push(`${path}: the digest run was handed the architecture review as its brief`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

test('a run DOES still get what previous runs of the SAME workflow learned', async () => {
  const projectId = projectWithLearnings();
  const agentId = cartridge();
  const tplId = template('Daily AI Research Digest');
  const OWN = 'Prefer arXiv listings over the RSS mirror, which lags by a day.';
  learningFrom(projectId, tplId, 'Daily AI Research Digest', OWN);
  learningFrom(projectId, template('Engineering Architecture Review'),
    'Engineering Architecture Review', REPORT_DUMP);

  const res = await fetch(`${base}/api/workflows/v2/${tplId}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, projectId }),
  });
  const { workflow } = await res.json() as { workflow: { id: string } };
  const httpCtx = contextOf(workflow.id);
  const cloneCtx = contextOf(cloneTemplateAsRun(tplId, projectId, '', { agentId })!);

  for (const [path, ctx] of [['HTTP start', httpCtx], ['cloneTemplateAsRun', cloneCtx]] as const) {
    assert.ok(ctx.includes(OWN),
      `${path}: scoping threw away the workflow's OWN history, which was the useful half`);
    assert.ok(!ctx.includes(FOREIGN_MARKER),
      `${path}: the other workflow's report came along anyway`);
  }
});

test('what the PERSON typed at launch still survives', async () => {
  // The injection is going; the context someone actually wrote must not go with it.
  const projectId = projectWithLearnings();
  const agentId = cartridge();
  const tplId = template('Bug Hunter');
  const typed = 'The export to PDF drops the last row on every invoice.';

  const res = await fetch(`${base}/api/workflows/v2/${tplId}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, projectId, initialContext: typed }),
  });
  const { workflow } = await res.json() as { workflow: { id: string } };
  const httpCtx = (db.prepare('SELECT initial_context FROM workflows WHERE id = ?')
    .get(workflow.id) as { initial_context: string }).initial_context;
  assert.equal(httpCtx, typed, 'the HTTP start path mangled the context the person typed');

  const clonedRun = cloneTemplateAsRun(tplId, projectId, typed, { agentId })!;
  const cloneCtx = (db.prepare('SELECT initial_context FROM workflows WHERE id = ?')
    .get(clonedRun) as { initial_context: string }).initial_context;
  assert.equal(cloneCtx, typed, 'the clone path mangled the context the person typed');
});

test('learnings are still RECORDED — this scopes the injection, not the memory', () => {
  // Every learning stays readable on the project page (routes/projects.ts). Narrowing what is
  // pasted into a prompt must not quietly delete the project's history.
  const projectId = projectWithLearnings();
  learningFrom(projectId, template('Bug Hunter'), 'Bug Hunter', 'anything');
  learningFrom(projectId, template('Engineering Architecture Review'),
    'Engineering Architecture Review', REPORT_DUMP);
  const rows = db.prepare('SELECT COUNT(*) c FROM project_learnings WHERE project_id = ?')
    .get(projectId) as { c: number };
  assert.equal(rows.c, 2, 'the learnings themselves were dropped');
});
