/**
 * THE GOAL REPORT — when the last stage finishes, one artifact says what the goal did.
 *
 * SCOPE: every section the report is made of is sourced from what NeonCore recorded —
 *   stages (each with its run's completion report, or what it produced), decisions, the brief,
 *   learnings, spend, and the open items (assumptions, [HUMAN] next steps, unresolved issues,
 *   stages that did not complete) — and it is delivered three ways (stored JSON, HTML, Markdown)
 *   plus as files. The planner's narrative replaces the compiled summary when it arrives; when
 *   it does not, the compiled one stands.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import { getPilot, stagesOf } from '../src/lib/goal-pilot.ts';
import { advancePilot } from '../src/lib/goal-pilot-runner.ts';
import { renderGoalReportHtml } from '../src/lib/goal-pilot-report.ts';
import { registerChannel, clearChannels, type Notice } from '../src/lib/channels.ts';

const io = installStubIO();
const app = express();
app.use(express.json());
app.use('/api/goal-pilots', goalPilotsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => server.close());
async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text, type: res.headers.get('content-type') || '', disposition: res.headers.get('content-disposition') || '' };
}

let n = 0;
function cartridge(repo: string, connected = true): string {
  const id = `rep-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, 'box', ?, ?, 'idle', ?, ?, 'claude')`).run(id, `box/r${n}`, repo, repo.split('/').pop(), new Date().toISOString(), `s-${id}`);
  if (connected) io.connect(id);
  return id;
}
const lastPrompt = (agentId: string) => {
  const hits = io.emissions.filter((e) => e.event === 'command_send' && e.room === `agent:${agentId}`);
  return String((hits[hits.length - 1]?.payload as { text?: string } | undefined)?.text ?? '');
};
const rid = (pilotId: string) => getPilot(pilotId)!.currentRequestId;

const BRIEF = {
  slug: 'expenses', summary: 'Owners record expenses next to income.', successMetric: 'An owner sees monthly profit.',
  inScope: 'Expense entry\nMonthly totals', acceptanceCriteria: 'When an owner saves an expense, the system shall list it.',
  invariants: 'Invoices unchanged.', outOfScope: 'Receipts', rabbitHoles: 'Float money', assumptions: 'Single currency (USD)',
};

/** One checklist criterion: the pipeline ends with the independent review (no stage 0 — see acceptance-contract.test.ts). */
const CRITERIA = [{ text: 'When an owner saves an expense, the system shall list it.', expect: 'Saving 12.50 → it is listed.', verify: 'checklist' }];

/** The independent review at the end: the reviewer's verdict, then the person's decision. */
async function finishReview(pilotId: string, verdict: 'met' | 'not-met' = 'met', beforeConfirm?: () => void) {
  const review = stagesOf(pilotId).find((s) => s.kind === 'review')!;
  assert.equal(review.status, 'running', `review stage is ${review.status}: ${review.waitReason}`);
  const v = await call('POST', `/api/goal-pilots/requests/${review.requestId}/submit`, { result: { verdicts: [{ criterionId: 'AC-1', verdict, evidence: 'Saved 12.50 and looked at the list.' }] } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  beforeConfirm?.();
  const c = await call('POST', `/api/goal-pilots/${pilotId}/acceptance/checklist`, { confirmations: { 'AC-1': { accepted: verdict === 'met' } } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
}

/** A pilot through scoping and planning, started on a live cartridge. */
async function runningPilot(templates: string[]) {
  const repo = `/tmp/rep-repo-${++n}`;
  const agent = cartridge(repo);
  const c = await call('POST', '/api/goal-pilots', {
    intake: { goal: 'Add expenses <tracking> & "profit"', context: 'c', workType: 'feature', done: 'd', involvement: 'balanced' }, plannerAgentId: agent,
  });
  const pilotId = c.json.pilot.id as string;
  await call('POST', `/api/goal-pilots/requests/${rid(pilotId)}/submit`, { result: { status: 'questions', questions: [{ id: 'cur', text: 'Currency?', options: ['USD', 'Per expense'], suggested: 'USD' }] } });
  await call('POST', `/api/goal-pilots/${pilotId}/answers`, { answers: { cur: { delegated: true } } });
  await call('POST', `/api/goal-pilots/requests/${rid(pilotId)}/submit`, { result: { status: 'complete', brief: BRIEF, criteria: CRITERIA } });
  await call('POST', `/api/goal-pilots/requests/${rid(pilotId)}/submit`, { result: { stages: templates.map((template) => ({ template, title: `Do ${template}` })) } });
  await call('POST', `/api/goal-pilots/${pilotId}/accept-plan`, {});
  await call('POST', `/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  return { pilotId, agent, goalId: c.json.goalId as string };
}

/** What a finished run leaves behind: its steps done, its completion report filed, maybe a learning. */
function finishRun(runId: string, report: Record<string, unknown> | null, learning = '') {
  const t = new Date().toISOString();
  db.prepare(`UPDATE workflow_steps SET status = 'completed', result = 'Done: the step', completed_at = ? WHERE workflow_id = ?`).run(t, runId);
  const step = db.prepare('SELECT id FROM workflow_steps WHERE workflow_id = ? LIMIT 1').get(runId) as { id: string };
  if (report) {
    db.prepare(`INSERT INTO workflow_reports (id, project, workflow_id, step_id, workflow_name, run_number, status, report, html_path, created_at)
                VALUES (?, 'repo', ?, ?, 'wf', 1, ?, ?, '', ?)`)
      .run(randomUUID(), runId, step.id, String((report.header as Record<string, unknown>)?.overallStatus ?? ''), JSON.stringify(report), t);
  }
  if (learning) {
    db.prepare(`INSERT INTO project_learnings (id, project_id, workflow_id, workflow_name, content, tags, created_at) VALUES (?, NULL, ?, 'wf', ?, '[]', ?)`)
      .run(randomUUID(), runId, learning, t);
  }
  db.prepare(`UPDATE workflows SET status = 'completed', completed_at = ? WHERE id = ?`).run(t, runId);
}

const RUN_REPORT = (summary: string, extra: Record<string, unknown> = {}) => ({
  header: { overallStatus: 'SUCCESS', branch: 'main', commit: 'abc' },
  executiveSummary: summary,
  outcome: { tasksCompleted: 3, tasksTotal: 3, testsPassed: 12, testsTotal: 12, issues: 0, humanActionsRequired: 0 },
  whatChanged: ['ledger: expense totals'], issues: [], nextSteps: ['[AGENT] tidy'], humanActionRequired: null, jira: null, ...extra,
});

test('the last stage finishing produces the goal report — every section from the records — files, a notice, and a summary request', async () => {
  const seen: Notice[] = [];
  clearChannels();
  registerChannel({ name: 'collector', isConfigured: () => true, async send(x) { seen.push(x); return { ok: true, dropped: [] }; } });
  const { pilotId, agent } = await runningPilot(['Feature Validation', 'Release Documentation']);

  finishRun(stagesOf(pilotId)[0].runId, RUN_REPORT('Wrote the testing guide for <expenses>.'), 'Totals must use integer cents.');
  advancePilot(pilotId);
  assert.equal(getPilot(pilotId)!.report, null, 'no report while stages remain');
  finishRun(stagesOf(pilotId)[1].runId, RUN_REPORT('Release notes for 1.1.', {
    issues: [{ severity: 'MEDIUM', description: 'Upgrade note missing for CSV', status: 'open' }],
    nextSteps: ['[HUMAN] Approve the release notes'],
    outcome: { tasksCompleted: 2, tasksTotal: 2, testsPassed: 4, testsTotal: 5, issues: 1, humanActionsRequired: 1 },
  }));
  advancePilot(pilotId);
  assert.equal(getPilot(pilotId)!.report, null, 'no report while the checklist is unjudged');
  await finishReview(pilotId);

  const pilot = getPilot(pilotId)!;
  assert.equal(pilot.phase, 'completed');
  const r = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.equal(r.status, 'SUCCESS', 'every criterion met (reviewed, confirmed)');
  assert.deepEqual([r.acceptance.passing, r.acceptance.total, r.acceptance.criteria[0].outcome], [1, 1, 'met']);
  assert.deepEqual(r.stages.map((s: { title: string }) => s.title), ['Do Feature Validation', 'Do Release Documentation', 'Independent review of the checklist'], 'every stage, in order');
  assert.equal(r.stages[0].runReport.executiveSummary, 'Wrote the testing guide for <expenses>.');
  assert.deepEqual(r.outcome, { stagesCompleted: 3, stagesTotal: 3, stagesSkipped: 0, stepsCompleted: r.outcome.stepsTotal, stepsTotal: r.outcome.stepsTotal, testsPassed: 16, testsTotal: 17, issues: 1 });
  assert.deepEqual(r.learnings.map((l: { content: string }) => l.content), ['Totals must use integer cents.']);
  assert.deepEqual(r.decisions, [{ question: 'Currency?', answer: 'left to the agents — use: USD', delegated: true }]);
  for (const item of ['Assumption made for you — confirm: Single currency (USD)', 'Do Release Documentation: Approve the release notes', 'Do Release Documentation: [MEDIUM] Upgrade note missing for CSV']) {
    assert.ok(r.openItems.includes(item), `open items lack: ${item}\n${r.openItems.join('\n')}`);
  }
  assert.equal(r.summary.source, 'compiled');
  assert.match(r.summary.text, /3 of 3 stages completed/);
  assert.match(r.summary.text, /Acceptance: 1 of 1 criteria pass/);

  // Files next to the database, and every format carries every stage.
  for (const f of [r.files.html, r.files.markdown, r.files.json]) assert.ok(fs.existsSync(f), `missing ${f}`);
  const html = await call('GET', `/api/goal-pilots/${pilotId}/report/html`);
  assert.match(html.type, /text\/html/);
  assert.ok(html.text.includes('Do Feature Validation') && html.text.includes('Do Release Documentation'));
  assert.ok(html.text.includes('Acceptance criteria') && html.text.includes('AC-1'), 'the criteria and their evidence are in the report');
  assert.ok(html.text.includes('&lt;expenses&gt;') && !html.text.includes('<expenses>'), 'agent text is escaped, never markup');
  const md = await call('GET', `/api/goal-pilots/${pilotId}/report/markdown`);
  assert.match(md.disposition, /attachment; filename="goal-report-add-expenses-tracking-profit\.md"/);
  assert.ok(md.text.includes('- [ ] Assumption made for you'));

  // Told once, as something to act on (review it, close the goal).
  const done = seen.filter((x) => x.data?.pilotId === pilotId && x.data?.event === 'completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].data?.type, 'goal_pilot_action');

  // The planner is asked for the narrative, with the report as its evidence.
  const prompt = lastPrompt(agent);
  assert.match(prompt, /goal pilot · report request/);
  const data = JSON.parse(prompt.split('```json\n')[1].split('\n```')[0]);
  assert.equal(data.report.stages.length, 3);
  assert.match(prompt, /ACCEPTANCE CRITERIA — NeonCore's OWN evidence/);
  const bad = await call('POST', `/api/goal-pilots/requests/${rid(pilotId)}/submit`, { result: { highlights: ['x'] } });
  assert.equal(bad.status, 422, 'a summary is required');
  const ok = await call('POST', `/api/goal-pilots/requests/${rid(pilotId)}/submit`, {
    result: { summary: 'Expenses shipped; one upgrade note is missing.', highlights: ['Testing guide'], followUps: ['Add the CSV upgrade note'] },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const after = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.deepEqual([after.summary.source, after.summary.text], ['planner', 'Expenses shipped; one upgrade note is missing.']);
  assert.ok(fs.readFileSync(after.files.html, 'utf8').includes('Expenses shipped; one upgrade note is missing.'), 'the file was re-rendered');
  assert.equal(getPilot(pilotId)!.phase, 'completed', 'writing the summary does not reopen the pilot');
  clearChannels();
});

test('a skipped stage is an open item — never counted as delivered — and the status follows the criteria, not the stages', async () => {
  const { pilotId } = await runningPilot(['Feature Validation', 'Release Documentation']);
  finishRun(stagesOf(pilotId)[0].runId, RUN_REPORT('Guide written.'));
  advancePilot(pilotId);
  await call('POST', `/api/goal-pilots/${pilotId}/stages/${stagesOf(pilotId)[1].id}/skip`);
  await finishReview(pilotId, 'not-met');
  const r = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.equal(r.status, 'FAILED', 'no criterion is met');
  assert.ok(r.openItems.some((o: string) => /^AC-1 is not met — judged not met/.test(o)), r.openItems.join('\n'));
  assert.ok(r.openItems.some((o: string) => /Stage 2 "Do Release Documentation" skipped/.test(o)));
  assert.ok(!r.summary.highlights.some((h: string) => h.startsWith('Do Release Documentation')), 'a skipped stage is not a highlight');
});

test('no planner to write the summary: the compiled report stands, nobody is called for it, and it can be asked again', async () => {
  const seen: Notice[] = [];
  clearChannels();
  registerChannel({ name: 'collector', isConfigured: () => true, async send(x) { seen.push(x); return { ok: true, dropped: [] }; } });
  const { pilotId, agent } = await runningPilot(['Feature Validation']);
  finishRun(stagesOf(pilotId)[0].runId, null);                            // the run filed no report
  advancePilot(pilotId);
  await finishReview(pilotId, 'met', () => {
    db.pragma('foreign_keys = OFF');                                      // and then the planner is gone, history and all
    db.prepare('DELETE FROM agents WHERE id = ?').run(agent);
    db.pragma('foreign_keys = ON');
  });
  const pilot = (await call('GET', `/api/goal-pilots/${pilotId}`)).json;
  assert.equal(pilot.report.summary.source, 'compiled');
  assert.equal(pilot.currentRequest.kind, 'report');
  assert.equal(pilot.currentRequest.status, 'failed');
  assert.ok(!seen.some((x) => x.data?.pilotId === pilotId && x.data?.event === 'planner-failed'), 'a missing narrative blocks nothing');
  assert.match(pilot.report.stages[0].produced, /Done: the step/, 'with no run report, what the stage produced is used');
  const other = cartridge('/tmp/rep-other');
  const again = await call('POST', `/api/goal-pilots/${pilotId}/retry`, { agentId: other });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.match(lastPrompt(other), /goal pilot · report request/);
  clearChannels();
});

test('a pipeline cancelled part-way can still get a report of what ran; one where nothing ran cannot', async () => {
  const { pilotId } = await runningPilot(['Feature Validation', 'Release Documentation']);
  finishRun(stagesOf(pilotId)[0].runId, RUN_REPORT('Guide written.'));
  advancePilot(pilotId);
  await call('POST', `/api/goal-pilots/${pilotId}/cancel`);
  const built = await call('POST', `/api/goal-pilots/${pilotId}/report`);
  assert.equal(built.status, 200, JSON.stringify(built.json));
  assert.equal(built.json.status, 'INCOMPLETE', 'nothing was judged against the criteria');
  assert.ok(built.json.openItems.some((o: string) => /^AC-1 is not met — it was never checked/.test(o)), built.json.openItems.join('\n'));
  assert.equal(built.json.stages[0].status, 'completed', 'what ran is still reported');

  const repo = '/tmp/rep-nothing';
  const planner = cartridge(`${repo}-planner`);
  const c = await call('POST', '/api/goal-pilots', { intake: { goal: 'G', context: 'c', workType: 'feature', done: 'd', involvement: 'balanced' }, plannerAgentId: planner });
  assert.equal((await call('POST', `/api/goal-pilots/${c.json.pilot.id}/report`)).status, 409);
  assert.equal((await call('GET', `/api/goal-pilots/${c.json.pilot.id}/report/html`)).status, 404);
});

test('the HTML escapes every field a person or an agent wrote', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderGoalReportHtml({
    version: 1, generatedAt: new Date().toISOString(), goal: { id: 'g', name: evil, successMetric: evil }, pilotId: 'p', status: 'SUCCESS',
    involvement: evil, startedAt: null, finishedAt: null, minutes: null, costUsd: 0,
    outcome: { stagesCompleted: 1, stagesTotal: 1, stagesSkipped: 0, stepsCompleted: 1, stepsTotal: 1, testsPassed: 0, testsTotal: 0, issues: 0 },
    summary: { text: evil, highlights: [evil], followUps: [evil], source: 'planner' },
    acceptance: {
      version: 1, lockedAt: null, contractStatus: 'locked', total: 1, passing: 0, checks: 1, testsUnchanged: false, reviewIndependent: false, note: evil,
      criteria: [{ id: 'AC-1', text: evil, expect: evil, verify: 'test', outcome: 'fail', command: evil, files: [evil], exitCode: 1, output: evil, checkedAt: 'x', checkedAfter: evil,
        baseline: { exitCode: 1, passed: false }, verdict: '', evidence: '', reviewer: '', confirmed: null, note: '' }],
      tamperEvents: [{ at: 'x', stage: evil, paths: [evil], resolution: 'open' }],
      amendments: [{ at: 'x', kind: 'unlock', criterionIds: ['AC-1'], reason: evil, before: { text: evil, expect: evil }, after: { text: evil, expect: evil }, version: 2 }],
    },
    brief: { ...BRIEF, summary: evil, inScope: evil }, decisions: [{ question: evil, answer: evil, delegated: false }],
    stages: [{ position: 1, kind: 'workflow', title: evil, template: evil, repo: evil, engine: evil, status: 'completed', startedAt: null, completedAt: null, minutes: null,
      steps: { completed: 1, total: 1 }, produced: evil, runId: 'r',
      runReport: { status: evil, executiveSummary: evil, whatChanged: [evil], issues: [{ severity: evil, description: evil, status: evil }], nextSteps: [], testsPassed: null, testsTotal: null } }],
    learnings: [{ workflow: evil, content: evil }], openItems: [evil], files: null,
  });
  assert.ok(!html.includes('<img'), 'raw markup made it into the report');
});
