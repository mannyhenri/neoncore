/**
 * ONE RUN, ONE REPORT — AND IT MUST REACH THE JOURNAL.
 *
 * Reported as three symptoms; they are one bug.
 *   "I got the same report several times for baseback/interlag-backend"
 *   "a few repos that are done but never got a report"
 *   "I can't see the baseback/interlag-backend report in the journal"
 *
 * `CONFER_FILL['claude-code'] = 'confer-all'` converts EVERY claude-code step when a run-level
 * confer is launched — including the Workflow Completion Report. Two consequences, both
 * measured on the live database:
 *
 *  1. DUPLICATES. N participants each execute the report prompt, each writes
 *     .neoncore/reports/<runId>/workflow-report.{json,html} into its OWN repo, and each opens
 *     it. Run a6c37e54 has a complete report in backend-interlag AND in baseback — the same
 *     run, reported twice. A completion report is one account of one run; conferring it is
 *     like asking two people to write the same minutes.
 *
 *  2. IT CAN NEVER BE INGESTED. The conversion sets executor_id = '' by design ("it stops
 *     meaning anything for a confer step"), and reportDir() resolves the repo from
 *     `agents WHERE id = executor_id`. Empty id → no repo → ingestReportFromDisk returns early
 *     and the boot backfill, which calls the same function, can never recover it either.
 *     Measured: 7 of 14 report steps converted to confer with an empty executor_id, 1 of 14
 *     delivered.
 *
 * SET-BASED OVER CONFER_FILL, because the question "which step types may be conferred" has one
 * registry and the report step is the entry that was wrong. A test that only checked the
 * Confer template would pass the day someone launches a run-level confer on any other template.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import workflowsRouter, { backfillReportsFromDisk } from '../src/routes/workflows.ts';
import journalRouter from '../src/routes/journal.ts';
import { isReportStep, RUN_ID_PLACEHOLDER } from '../src/lib/workflow-report.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';

const io = installStubIO();
const iso = () => new Date().toISOString();
let base = '';
let server: Server;
let n = 0;

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/journal', journalRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r();
    });
  });
});
test.after(() => server?.close());

/** Two live cartridges with real repo dirs, as a run-level confer needs. */
function participants(): { ids: string[]; repos: string[] } {
  const ids: string[] = [];
  const repos: string[] = [];
  for (const which of ['a', 'b']) {
    const id = `rc-${which}-${++n}`;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `rc-${which}-`));
    db.prepare(
      `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
       VALUES (?,?,?,?,?,'claude','idle',?,?)`,
    ).run(id, id, os.hostname(), repo, `repo-${id}`, iso(), `s-${id}`);
    io.connect(id);
    ids.push(id); repos.push(repo);
  }
  return { ids, repos };
}

// ── The rule ───────────────────────────────────────────────────────────────────────────

test('the report step is NEVER converted to a confer', async () => {
  const { ids } = participants();
  const tpl = db.prepare("SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Confer'")
    .get() as { id: string };

  const res = await fetch(`${base}/api/workflows/v2/${tpl.id}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferAllSteps: ids, initialContext: 'weekend form failures' }),
  });
  const body = await res.text();
  assert.ok(res.ok, body);
  const { workflow } = JSON.parse(body) as { workflow: { id: string } };

  const steps = db.prepare(
    'SELECT name, executor_type, executor_id, executor_config FROM workflow_steps WHERE workflow_id = ?',
  ).all(workflow.id) as { name: string; executor_type: string; executor_id: string; executor_config: string }[];

  const report = steps.find((s) => isReportStep(JSON.parse(s.executor_config || '{}')));
  assert.ok(report, 'the run has no report step');

  assert.notEqual(report!.executor_type, 'confer',
    'the completion report was conferred — every participant writes and opens its own copy, ' +
    'which is why the same report arrived several times for one run');
  assert.ok(report!.executor_id && report!.executor_id !== '__deferred__',
    'the report step has no cartridge, so the server can never find the repo it wrote into ' +
    '— reportDir() resolves the repo from executor_id and returns null for an empty one');
  assert.ok(ids.includes(report!.executor_id),
    'the report step must run on one of the participants');
});

test('the OTHER steps are still conferred — this exempts the report, not the mode', () => {
  // Over-correcting would break run-level confer entirely, which is the feature.
  const { ids } = participants();
  const tpl = db.prepare("SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Bug Hunter'")
    .get() as { id: string };
  return fetch(`${base}/api/workflows/v2/${tpl.id}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferAllSteps: ids }),
  }).then(async (res) => {
    const { workflow } = await res.json() as { workflow: { id: string } };
    const steps = db.prepare(
      'SELECT executor_type, executor_config FROM workflow_steps WHERE workflow_id = ?',
    ).all(workflow.id) as { executor_type: string; executor_config: string }[];
    const work = steps.filter((s) => !isReportStep(JSON.parse(s.executor_config || '{}')));
    assert.ok(work.some((s) => s.executor_type === 'confer'),
      'no step was conferred at all — the exemption swallowed the whole mode');
  });
});

// ── The consequence: it reaches the journal ────────────────────────────────────────────

test('a conferred run STILL delivers exactly one report to the journal', async () => {
  const { ids, repos } = participants();
  const tpl = db.prepare("SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Confer'")
    .get() as { id: string };
  const started = await (await fetch(`${base}/api/workflows/v2/${tpl.id}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferAllSteps: ids }),
  })).json() as { workflow: { id: string } };
  const runId = started.workflow.id;

  const step = db.prepare(
    'SELECT id, executor_id FROM workflow_steps WHERE workflow_id = ? AND executor_config LIKE \'%workflow-report%\'',
  ).get(runId) as { id: string; executor_id: string };

  // The agent writes into ITS OWN repo, exactly as the prompt tells it to.
  const repo = (db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(step.executor_id) as { repo_path: string }).repo_path;
  assert.ok(repos.includes(repo), 'the report step landed on a cartridge outside the confer');
  const dir = path.join(repo, '.neoncore', 'reports', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow-report.json'), JSON.stringify({
    schema: 'neoncore.workflow-report/1', header: { overallStatus: 'SUCCESS' }, executiveSummary: 'one report',
  }));
  fs.writeFileSync(path.join(dir, 'workflow-report.html'), '<title>R</title><h1>R</h1>');

  // The dispatcher would have marked it running; the webhook refuses a pending step and this
  // test is about what happens AFTER the work, not about dispatch.
  db.prepare("UPDATE workflow_steps SET status = 'running' WHERE id = ?").run(step.id);

  // It completes without posting — the case that left the journal empty.
  const done = await fetch(`${base}/api/workflows/webhook/${step.id}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'wrote and opened the report', scope: '9/9', verify: 'ls → 2 files' }),
  });
  assert.ok(done.ok, await done.text());

  const stored = db.prepare('SELECT project, html_path FROM workflow_reports WHERE step_id = ?')
    .get(step.id) as { project: string; html_path: string } | undefined;
  assert.ok(stored, 'a conferred run still cannot get its report into the journal');
  assert.ok(stored!.html_path, 'no html_path — the readable half is unreachable again');
});

test('ONE run produces ONE report row, however many cartridges conferred', () => {
  const rows = db.prepare(
    `SELECT workflow_id, COUNT(*) c FROM workflow_reports GROUP BY workflow_id HAVING c > 1`,
  ).all() as { workflow_id: string; c: number }[];
  assert.deepEqual(rows, [],
    `a run has more than one stored report: ${rows.map((r) => `${r.workflow_id}=${r.c}`).join(', ')}`);
});

// ── Recovery: the reports already sitting on disk ─────────────────────────────────────

/**
 * Exempting the report step fixes every run FROM NOW ON. It does nothing for the runs that
 * already happened — and those are the ones the user is looking at: "I can't see the
 * baseback/interlag-backend report in the journal". Their steps are `confer` with an empty
 * executor_id, so reportDir() has no agent to resolve a repo from and the boot backfill skips
 * them forever. The files are complete and on disk; nothing about them is unreachable.
 *
 * The duplicate is the same fact from the other side: the report exists in BOTH participants'
 * repos. Recovery must therefore be explicit about which copy it takes, and take ONE.
 */
test('a legacy conferred report is recovered from disk — once, from a real repo', () => {
  const { ids, repos } = participants();
  const runId = `legacy-${++n}`;
  db.prepare(
    `INSERT INTO workflows (id, name, status, run_number, created_at)
     VALUES (?, 'Epic: Confer Across Repos', 'completed', 7, ?)`,
  ).run(runId, iso());

  const stepId = `legacy-step-${n}`;
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, position_x, position_y, created_at)
     VALUES (?, ?, 'Workflow Completion Report', 'completed', 'confer', '', ?, 300, 50, ?)`,
  ).run(stepId, runId, JSON.stringify({ stepKind: 'workflow-report', conferAgentIds: ids, conferMode: 'divide' }), iso());

  // Both participants wrote one, which is the bug that produced the duplicates.
  for (const repo of repos) {
    const dir = path.join(repo, '.neoncore', 'reports', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workflow-report.json'), JSON.stringify({
      schema: 'neoncore.workflow-report/1', header: { overallStatus: 'PARTIAL' }, executiveSummary: 'legacy',
    }));
    fs.writeFileSync(path.join(dir, 'workflow-report.html'), '<title>Legacy</title>');
  }

  const found = backfillReportsFromDisk();
  assert.ok(found >= 1, 'the backfill still cannot see a report whose step has no executor_id');

  const rows = db.prepare('SELECT project, html_path, status FROM workflow_reports WHERE workflow_id = ?')
    .all(runId) as { project: string; html_path: string; status: string }[];
  assert.equal(rows.length, 1, `one run, one report — got ${rows.length}`);
  assert.equal(rows[0].status, 'PARTIAL');
  assert.ok(rows[0].html_path && fs.existsSync(rows[0].html_path),
    'html_path does not point at a file that exists — the Open button would 404');
  assert.ok(rows[0].project, 'the report landed in the journal with no project, so no repo shows it');
  const repoNames = ids.map((id) => (db.prepare('SELECT repo_name FROM agents WHERE id = ?').get(id) as { repo_name: string }).repo_name);
  assert.ok(repoNames.includes(rows[0].project),
    `project "${rows[0].project}" is not one of the participants (${repoNames.join(', ')})`);
});

// ── The placeholder must never reach an agent ─────────────────────────────────────────

/**
 * `<workflowRunId>` is the template's stand-in for an id that does not exist yet. A run has
 * one, so a run's steps must not still be carrying the stand-in — whichever executor ends up
 * dispatching them, and whether or not that executor supplies a run record.
 *
 * SET-BASED OVER EVERY TEMPLATE, because the failure was invisible from the one template
 * anybody would have tested by hand: the prompt is only wrong once it is dispatched by a path
 * that does not prepend the run record, and which path that is depends on the executor type.
 */
test('no run carries an unresolved run-id placeholder, for any template', async () => {
  const templates = db.prepare(
    'SELECT id, name FROM workflows WHERE template_id IS NULL',
  ).all() as { id: string; name: string }[];
  assert.ok(templates.length >= 20, `only ${templates.length} templates — the sweep is not sweeping`);

  const offenders: string[] = [];
  for (const t of templates) {
    const res = await fetch(`${base}/api/workflows/v2/${t.id}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: participants().ids[0] }),
    });
    if (!res.ok) { await res.text(); continue; } // a template that cannot launch is a different test
    const { workflow } = await res.json() as { workflow: { id: string } };
    const steps = db.prepare(
      'SELECT name, executor_config FROM workflow_steps WHERE workflow_id = ?',
    ).all(workflow.id) as { name: string; executor_config: string }[];
    for (const s of steps) {
      if ((s.executor_config || '').includes(RUN_ID_PLACEHOLDER)) offenders.push(`${t.name} → ${s.name}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these dispatched steps still say "${RUN_ID_PLACEHOLDER}" instead of the run id, so the agent `
    + `must invent one — which is how two reports were written into a directory matching no run:\n  `
    + offenders.join('\n  '));
});

test('the TEMPLATES keep the placeholder — there is no run id to bake in yet', () => {
  const tpl = db.prepare(
    `SELECT executor_config FROM workflow_steps
      WHERE workflow_id IN (SELECT id FROM workflows WHERE template_id IS NULL)
        AND executor_config LIKE '%.neoncore/reports/%' LIMIT 1`,
  ).get() as { executor_config: string } | undefined;
  // The generic report names no directory (it is delivered through report_step_done); a
  // template whose report writes a file there — Gridlight QA's scorecard — still does.
  assert.ok(tpl, 'no template report names a reports directory');
  assert.ok(tpl!.executor_config.includes(RUN_ID_PLACEHOLDER),
    'the substitution was pushed back into the template, where the id it names does not exist');
});

/**
 * The report the user went looking for. A conferred report step was dispatched through the
 * confer conductor with no run id, so the agents named the directory after the only identifier
 * they had — the confer session's. Run 567fe12b's report step carries
 * `conferSessionId: a6c37e54…`, and a6c37e54 is the directory in both baseback and
 * backend-interlag. The link exists in the step's own config; nothing has to be guessed.
 */
test('a report filed under the confer session id is still found', () => {
  const { ids, repos } = participants();
  const runId = `sess-run-${++n}`;
  const sessionId = `sess-confer-${n}`;
  db.prepare(
    `INSERT INTO workflows (id, name, status, run_number, created_at) VALUES (?, 'Confer', 'completed', 3, ?)`,
  ).run(runId, iso());
  const stepId = `sess-step-${n}`;
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, position_x, position_y, created_at)
     VALUES (?, ?, 'Workflow Completion Report', 'completed', 'confer', '', ?, 300, 50, ?)`,
  ).run(stepId, runId, JSON.stringify({
    stepKind: 'workflow-report', conferAgentIds: ids, conferSessionId: sessionId,
  }), iso());

  // Named after the CONFER SESSION, not the run — exactly as found on disk.
  const dir = path.join(repos[1], '.neoncore', 'reports', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow-report.json'), JSON.stringify({
    schema: 'neoncore.workflow-report/1', header: { overallStatus: 'PARTIAL' }, executiveSummary: 'confer',
  }));
  fs.writeFileSync(path.join(dir, 'workflow-report.html'), '<title>Confer</title>');

  backfillReportsFromDisk();
  const rows = db.prepare('SELECT project, html_path FROM workflow_reports WHERE workflow_id = ?')
    .all(runId) as { project: string; html_path: string }[];
  assert.equal(rows.length, 1, 'the report filed under the confer session id is still invisible');
  assert.ok(rows[0].html_path.includes(sessionId), 'stored the wrong file');
  const repoName = (db.prepare('SELECT repo_name FROM agents WHERE id = ?').get(ids[1]) as { repo_name: string }).repo_name;
  assert.equal(rows[0].project, repoName, 'filed under the wrong project, so the wrong journal shows it');
});

/**
 * SET-BASED OVER THE CLONE PATHS, not over the templates.
 *
 * The first version of the placeholder test above launched every template through the HTTP
 * start handler and passed — while `cloneTemplateAsRun` (lib/workflow-from-template.ts), the
 * path EVERY SCHEDULED RUN and every decomposition takes, still copied the template's config
 * through untouched. Scheduling was just added to every workflow's launch form, so the whole
 * bug would have come back through the newest feature, invisibly, on a timer.
 *
 * Iterating the templates found nothing because the set that mattered was the set of ways a
 * run gets created. There are two. A third must fail this test.
 */
test('every clone path resolves the run id — not just the one a human clicks', () => {
  const tpl = db.prepare(
    "SELECT id FROM workflows WHERE template_id IS NULL AND name = 'Bug Hunter'",
  ).get() as { id: string };
  const agentId = participants().ids[0];

  const clonePaths: { name: string; run: () => string }[] = [
    { name: 'cloneTemplateAsRun (scheduled runs, decompositions)',
      run: () => cloneTemplateAsRun(tpl.id, null, '', { agentId })! },
  ];

  const offenders: string[] = [];
  for (const p of clonePaths) {
    const runId = p.run();
    const steps = db.prepare(
      'SELECT name, executor_config FROM workflow_steps WHERE workflow_id = ?',
    ).all(runId) as { name: string; executor_config: string }[];
    assert.ok(steps.length > 0, `${p.name} created no steps`);
    for (const s of steps) {
      if ((s.executor_config || '').includes(RUN_ID_PLACEHOLDER)) offenders.push(`${p.name} → ${s.name}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these clone paths still hand the agent "${RUN_ID_PLACEHOLDER}":\n  ` + offenders.join('\n  '));
});
