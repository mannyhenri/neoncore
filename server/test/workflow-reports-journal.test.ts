/**
 * THE COMPLETION REPORT HAS TO COME BACK.
 *
 * The report step is an ordinary `claude-code` step: the AGENT writes the JSON and the HTML,
 * on the CARTRIDGE'S disk, under `.neoncore/reports/<runId>/`. NeonCore supplies the run record
 * that goes into the prompt and then never hears another word. Reported as "not sure the
 * reports are working, I haven't seen one yet" — they were working, and landing somewhere the
 * app cannot see. A report nobody can find is indistinguishable from a report that was never
 * written.
 *
 * So there is a return path, and the journal is where it lands, because the journal is where
 * you go to ask what happened to this repo.
 *
 * ── AND THE THREE TABS THAT NEVER EARNED THEIR PLACE ──────────────────────────────────
 * `progress.md`, `decisions.md` and `gotchas.md` were auto-appended by the session summarizer
 * and read by nobody: the live progress.md is a list of prompt fragments with "— {}" stapled to
 * the end of each. Their content already exists, better, elsewhere — a session's summary is on
 * the session row that the Sessions tab reads. `details.md` stays: unlike the other three it is
 * hand-written and it is the one thing Send Context can inject.
 *
 * WHY THE REMOVAL IS TESTED AS A SET. It spans 10 files across server, dashboard, mobile and the
 * client package. Deleting a tab while the summarizer keeps writing the file, or removing the
 * writer while a Send Context checkbox still offers it, leaves a half-removed feature that looks
 * present and does nothing — which is the state being fixed, not a new one to create.
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
import workflowsRouter from '../src/routes/workflows.ts';
import journalRouter from '../src/routes/journal.ts';
import { KNOWLEDGE_FILES } from '../src/lib/knowledge-files.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * Comments stripped before scanning. Every one of these files now carries a note SAYING the
 * three files were retired and why — which is the point of removing something — and a raw
 * substring match counts that note as a violation. Same helper the mobile suite uses, and for
 * the same reason: what the code does is not what the comments mention.
 */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');

let base = '';
let server: Server;

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

const iso = () => new Date().toISOString();
let n = 0;

/** A run mid-flight on a cartridge in `repo`, with its report step running. */
function runWithReportStep(repo: string, repoPath?: string): { stepId: string; runId: string } {
  const i = ++n;
  const agentId = `rep-agent-${i}`, runId = `rep-run-${i}`, stepId = `rep-step-${i}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,?,?,?,'claude','working',?,?)`,
  ).run(agentId, agentId, os.hostname(), repoPath ?? `/tmp/${repo}`, repo, iso(), `s-${i}`);
  db.prepare(
    `INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number)
     VALUES (?,'Bug Hunter','','running','[]',?,?, 'tpl-x', ?)`,
  ).run(runId, iso(), iso(), i);
  db.prepare(
    `INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,
       executor_type,executor_id,executor_config,auto_advance,depends_on,created_at,status)
     VALUES (?,?,'Workflow Completion Report','',300,0,'claude-code',?,?,1,'[]',?,'running')`,
  ).run(stepId, runId, agentId, JSON.stringify({ stepKind: 'workflow-report', reportContext: true }), iso());
  return { stepId, runId };
}

const SAMPLE = {
  schema: 'neoncore.workflow-report/1',
  header: { project: 'NeonCore', overallStatus: 'SUCCESS', runId: 'x' },
  executiveSummary: 'It worked.',
  outcome: { tasksCompleted: 3, tasksTotal: 3, testsPassed: 10, testsTotal: 10, issues: 0, warnings: 0, humanActionsRequired: 0 },
};

// ── The return path ────────────────────────────────────────────────────────────────────

test('a posted report is stored and readable from the journal for that repo', async () => {
  const { stepId, runId } = runWithReportStep('gridlight-manager');

  const post = await fetch(`${base}/api/workflows/webhook/${stepId}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: SAMPLE }),
  });
  assert.equal(post.status, 201, await post.text());

  const list = await (await fetch(`${base}/api/journal/projects/gridlight-manager/reports`)).json() as
    { id: string; workflowName: string; runNumber: number; status: string; report: unknown }[];
  assert.equal(list.length, 1, 'the report did not reach the journal');
  assert.equal(list[0].workflowName, 'Bug Hunter');
  assert.equal(list[0].status, 'SUCCESS');
  assert.deepEqual(list[0].report, SAMPLE, 'the JSON must come back byte-for-byte, not summarised');
  assert.ok(list[0].id);

  // And it is attributed to the RUN, so you can get back to what produced it.
  const row = db.prepare('SELECT workflow_id FROM workflow_reports WHERE id = ?').get(list[0].id) as { workflow_id: string };
  assert.equal(row.workflow_id, runId);
});

test('re-posting the same step replaces its report rather than stacking duplicates', async () => {
  const { stepId } = runWithReportStep('dup-repo');
  for (const summary of ['first pass', 'second pass']) {
    const r = await fetch(`${base}/api/workflows/webhook/${stepId}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: { ...SAMPLE, executiveSummary: summary } }),
    });
    assert.ok(r.ok);
  }
  const list = await (await fetch(`${base}/api/journal/projects/dup-repo/reports`)).json() as { report: { executiveSummary: string } }[];
  assert.equal(list.length, 1, 'a retried report created a second row');
  assert.equal(list[0].report.executiveSummary, 'second pass', 'the newer report must win');
});

test('a report for an unknown step is refused, not silently dropped', async () => {
  const r = await fetch(`${base}/api/workflows/webhook/no-such-step/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: SAMPLE }),
  });
  assert.equal(r.status, 404);
});

test('a non-object report body is refused — the JSON is the point', async () => {
  const { stepId } = runWithReportStep('bad-body');
  for (const body of [{ report: 'just a string' }, { report: null }, {}]) {
    const r = await fetch(`${base}/api/workflows/webhook/${stepId}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, `accepted a bad report body: ${JSON.stringify(body)}`);
  }
});

test('reports come back newest first, so the journal reads as a history', async () => {
  const repo = 'history-repo';
  for (let i = 0; i < 3; i++) {
    const { stepId } = runWithReportStep(repo);
    await fetch(`${base}/api/workflows/webhook/${stepId}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: { ...SAMPLE, executiveSummary: `run ${i}` } }),
    });
  }
  const list = await (await fetch(`${base}/api/journal/projects/${repo}/reports`)).json() as { report: { executiveSummary: string } }[];
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => r.report.executiveSummary), ['run 2', 'run 1', 'run 0']);
});

/**
 * EVERY WAY A FINISHED STEP TALKS TO NEONCORE CAN CARRY THE REPORT.
 *
 * The first version had exactly one return path: a bare `curl` the agent had to remember to run
 * AFTER writing the files. A completed run proved the cost — the step finished, both files were
 * written, `workflow_reports` stayed empty, and the report existed only on the cartridge's disk.
 *
 * The agent already MUST call `neoncore_report_step_done` or the step never completes. Carrying
 * the report there makes delivery part of the call it cannot skip, instead of a second optional
 * one. The dedicated endpoint stays as a fallback for engines with no MCP.
 */
const RETURN_PATHS: { name: string; send: (base: string, stepId: string, report: unknown) => Promise<Response> }[] = [
  {
    name: 'the dedicated /report endpoint (fallback for engines with no MCP)',
    send: (base, stepId, report) => fetch(`${base}/api/workflows/webhook/${stepId}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report }),
    }),
  },
  {
    name: 'the completion webhook — what neoncore_report_step_done posts to',
    send: (base, stepId, report) => fetch(`${base}/api/workflows/webhook/${stepId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: 'Report written and opened.',
        scope: '9/9 sections rendered',
        verify: 'python3 -m json.tool … → ok; ls -l → 2 files',
        deferred: 'none',
        report,
      }),
    }),
  },
];

test('EVERY return path lands the report in the journal', async () => {
  const missed: string[] = [];
  for (const path of RETURN_PATHS) {
    const repo = `ret-${Math.random().toString(36).slice(2, 8)}`;
    const { stepId } = runWithReportStep(repo);
    const res = await path.send(base, stepId, { ...SAMPLE, executiveSummary: path.name });
    if (!res.ok) { missed.push(`${path.name} → HTTP ${res.status} ${await res.text()}`); continue; }

    const list = await (await fetch(`${base}/api/journal/projects/${repo}/reports`)).json() as { report: { executiveSummary: string } }[];
    if (list.length !== 1) { missed.push(`${path.name} → ${list.length} reports in the journal, expected 1`); continue; }
    if (list[0].report.executiveSummary !== path.name) missed.push(`${path.name} → stored the wrong payload`);
  }
  assert.deepEqual(missed, [],
    `a return path did not reach the journal:\n  ${missed.join('\n  ')}`);
  console.log(`[set] ${RETURN_PATHS.length}/${RETURN_PATHS.length} return paths land the report`);
});

test('completing WITHOUT a report still completes the step — the report is optional, the completion is not', async () => {
  const { stepId } = runWithReportStep('no-report-repo');
  const res = await fetch(`${base}/api/workflows/webhook/${stepId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'done', scope: '1/1', verify: 'npm test → 1 passed', deferred: 'none' }),
  });
  assert.ok(res.ok, `a normal completion was rejected: ${await res.text()}`);
});

test('a malformed report never blocks the completion it rode in on', async () => {
  // A step that finished must complete even if its report payload is junk — losing the report
  // is recoverable, losing the completion strands the whole workflow.
  const { stepId } = runWithReportStep('junk-report-repo');
  const res = await fetch(`${base}/api/workflows/webhook/${stepId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'done', scope: '1/1', verify: 'npm test → ok', report: 'not an object' }),
  });
  assert.ok(res.ok, 'a bad report payload blocked the step completion');
  const list = await (await fetch(`${base}/api/journal/projects/junk-report-repo/reports`)).json() as unknown[];
  assert.equal(list.length, 0, 'stored a report that was not an object');
});

test('the MCP tool forwards the report — the path an agent actually uses', () => {
  const mcp = read('server/src/mcp-server.ts');
  const block = mcp.slice(mcp.indexOf("name === 'neoncore_report_step_done'"));
  assert.match(block.slice(0, 1200), /report/,
    'neoncore_report_step_done does not forward a report — the agent would have to remember a ' +
    'second, optional curl, which is exactly what left workflow_reports empty');
  // From the tool DEFINITION, not the first mention of the name — the file opens with a
  // comment listing every tool, and slicing from there reads the header instead of the schema.
  const defAt = mcp.indexOf("name: 'neoncore_report_step_done'");
  assert.ok(defAt > 0, 'tool definition not found');
  assert.match(mcp.slice(defAt, defAt + 2000), /report:\s*\{\s*type:\s*'object'/,
    'the tool schema has no `report` object property, so an agent cannot pass one');
});

// ── The three tabs, removed as a set ───────────────────────────────────────────────────

const RETIRED = ['progress.md', 'decisions.md', 'gotchas.md'];

test('the knowledge-file registry keeps details.md and nothing else', () => {
  assert.deepEqual([...KNOWLEDGE_FILES], ['details.md'],
    'details.md is hand-written and Send Context injects it; the other three were auto-generated and read by nobody');
});

test('NO source file still writes, offers or reads the retired knowledge files', () => {
  // Enumerated from the grep that found them, so a file that keeps a reference fails here
  // rather than surviving as a checkbox that toggles something nothing produces.
  const SURFACES = [
    'server/src/lib/context-injector.ts',
    'server/src/lib/session-manager.ts',
    'server/src/lib/session-summarizer.ts',
    'server/src/routes/agents.ts',
    'server/src/routes/journal.ts',
    'packages/client/src/client.ts',
    'dashboard/src/components/SendContextModal.tsx',
    'dashboard/src/components/ProjectMemoryPanel.tsx',
    'mobile/src/screens/ProjectMemoryScreen.tsx',
  ];
  const offenders: string[] = [];
  for (const f of SURFACES) {
    const src = code(f);
    const hits = RETIRED.filter((r) => src.includes(r));
    // The option flags are the other half of the same feature.
    const flags = ['includeProgress', 'includeGotchas', 'includeDecisions', 'hasProgress', 'hasGotchas', 'hasDecisions']
      .filter((k) => src.includes(k));
    if (hits.length || flags.length) offenders.push(`${f}: ${[...hits, ...flags].join(', ')}`);
  }
  assert.deepEqual(offenders, [],
    `${offenders.length}/${SURFACES.length} files still reference the retired knowledge files:\n  ${offenders.join('\n  ')}`);
  console.log(`[set] ${SURFACES.length}/${SURFACES.length} surfaces clear of the retired knowledge files`);
});

test('details.md still works end to end — it was not collateral', async () => {
  const put = await fetch(`${base}/api/journal/projects/keepme/knowledge/details.md`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# Details\n\nThe repo that matters.' }),
  });
  assert.ok(put.ok, await put.text());
  const got = await (await fetch(`${base}/api/journal/projects/keepme/knowledge/details.md`)).json() as { content: string };
  assert.match(got.content, /The repo that matters/);
});

test('a retired filename is refused by the knowledge route, not silently stored', async () => {
  for (const f of RETIRED) {
    const r = await fetch(`${base}/api/journal/projects/keepme/knowledge/${f}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    assert.equal(r.status, 400, `${f} is still writable — the registry is not being enforced`);
  }
});

/**
 * THE SERVER CAN JUST READ THE FILE.
 *
 * "Still don't see this report: file:///…/.neoncore/reports/<runId>/workflow-report.html"
 *
 * It was on disk, valid, complete — and the journal was empty, because delivery was built as
 * "the agent must POST it" and that run's prompt predated the POST instruction. Which exposes
 * the design flaw: for a cartridge on THIS machine the server can read the file itself and
 * needs no cooperation from the agent at all.
 *
 * So there are three ingest paths now, and the third depends on nothing:
 *   · the dedicated endpoint      (an engine with no MCP)
 *   · the completion webhook      (what neoncore_report_step_done posts)
 *   · the server reading the disk (needs no agent cooperation whatsoever)
 *
 * AND THE HTML MUST BE OPENABLE. A browser will not navigate to file:// from an http page, so
 * a link to the path on disk is inert — the report is readable only by pasting a path into a
 * new tab, which is what was being reported. The server serves it instead, and ONLY from a path
 * it recorded itself: the id is the key, never a path from the request, or the endpoint becomes
 * arbitrary file read.
 */
test('the server ingests a report from the cartridge disk — no agent cooperation', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ondisk-'));
  const { stepId, runId } = runWithReportStep('ondisk-repo', repo);

  const dir = path.join(repo, '.neoncore', 'reports', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow-report.json'), JSON.stringify({ ...SAMPLE, executiveSummary: 'read from disk' }));
  fs.writeFileSync(path.join(dir, 'workflow-report.html'), '<title>Report</title><h1>Report</h1>');

  // The step completes WITHOUT carrying a report — exactly the case that produced an empty
  // journal while the files sat on disk.
  const res = await fetch(`${base}/api/workflows/webhook/${stepId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'wrote and opened the report', scope: '9/9', verify: 'ls → 2 files' }),
  });
  assert.ok(res.ok, await res.text());

  const list = await (await fetch(`${base}/api/journal/projects/ondisk-repo/reports`)).json() as
    { id: string; report: { executiveSummary: string }; htmlUrl?: string }[];
  assert.equal(list.length, 1, 'the report was on disk and the server did not pick it up');
  assert.equal(list[0].report.executiveSummary, 'read from disk');
  assert.ok(list[0].htmlUrl, 'no way to open the HTML — the readable half of the report');
});

test('a posted report WINS over the file on disk — it is the agent’s own account', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'both-'));
  const { stepId, runId } = runWithReportStep('both-repo', repo);
  const dir = path.join(repo, '.neoncore', 'reports', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow-report.json'), JSON.stringify({ ...SAMPLE, executiveSummary: 'stale disk copy' }));

  await fetch(`${base}/api/workflows/webhook/${stepId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'done', scope: '9/9', verify: 'ok', report: { ...SAMPLE, executiveSummary: 'posted copy' } }),
  });
  const list = await (await fetch(`${base}/api/journal/projects/both-repo/reports`)).json() as { report: { executiveSummary: string } }[];
  assert.equal(list[0].report.executiveSummary, 'posted copy');
});

test('the HTML is served by the SERVER, so it is clickable from the app', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'));
  const { stepId, runId } = runWithReportStep('serve-repo', repo);
  const dir = path.join(repo, '.neoncore', 'reports', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow-report.json'), JSON.stringify(SAMPLE));
  fs.writeFileSync(path.join(dir, 'workflow-report.html'), '<title>Report</title><h1>The report</h1>');
  await fetch(`${base}/api/workflows/webhook/${stepId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'done', scope: '9/9', verify: 'ok' }),
  });

  const [row] = await (await fetch(`${base}/api/journal/projects/serve-repo/reports`)).json() as { id: string; htmlUrl: string }[];
  const html = await fetch(`${base}${row.htmlUrl}`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await html.text(), /The report/);
});

test('the HTML endpoint serves ONLY what it recorded — never a path from the request', async () => {
  // Otherwise this is an arbitrary file read wearing a report's clothes.
  const res = await fetch(`${base}/api/journal/reports/no-such-report/html`);
  assert.equal(res.status, 404);

  for (const attack of ['../../../../etc/passwd', '..%2f..%2f..%2fetc%2fpasswd']) {
    const r = await fetch(`${base}/api/journal/reports/${encodeURIComponent(attack)}/html`);
    assert.ok(r.status === 404 || r.status === 400, `traversal attempt returned ${r.status}`);
    const body = await r.text();
    assert.ok(!/root:/.test(body), 'served a file outside the recorded report');
  }
});

test('a report whose file has since been deleted says so, rather than 500ing', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gone-'));
  const { stepId, runId } = runWithReportStep('gone-repo', repo);
  const dir = path.join(repo, '.neoncore', 'reports', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow-report.json'), JSON.stringify(SAMPLE));
  fs.writeFileSync(path.join(dir, 'workflow-report.html'), '<h1>x</h1>');
  await fetch(`${base}/api/workflows/webhook/${stepId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'done', scope: '9/9', verify: 'ok' }),
  });
  const [row] = await (await fetch(`${base}/api/journal/projects/gone-repo/reports`)).json() as { htmlUrl: string }[];
  fs.rmSync(repo, { recursive: true, force: true });

  const res = await fetch(`${base}${row.htmlUrl}`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /no longer|not found|deleted/i);
});
