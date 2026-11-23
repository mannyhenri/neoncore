/**
 * RETEST A DELIVERED FEATURE, AND FIX WHAT IS STILL MISSING.
 *
 * A feature delivered with gaps (stopped early, criteria not met at the time) can be checked again:
 * the locked tests run now, the checklist is reviewed afresh and confirmed by the person, and the
 * report is rewritten from that evidence — nothing is built. If gaps remain, one workflow stage is
 * added for exactly those criteria, and the pipeline's ordinary checks follow it.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import { getPilot, stagesOf } from '../src/lib/goal-pilot.ts';
import { advancePilot, stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';
import { getContract } from '../src/lib/acceptance-contract.ts';
import { settleAcceptanceForTests, retestAcceptance, gapsOf, RETEST_TITLE } from '../src/lib/acceptance-runner.ts';
import { clearChannels } from '../src/lib/channels.ts';

const io = installStubIO();
const app = express();
app.use(express.json());
app.use('/api/goal-pilots', goalPilotsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => { server.close(); stopGoalPilotRunner(); clearChannels(); });

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const post = (r: string, b?: unknown) => call('POST', r, b ?? {});
const NODE = JSON.stringify(process.execPath);
let n = 0;

function cartridge(repo: string): string {
  const id = `rt-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `me/${path.basename(repo)}`, os.hostname(), repo, path.basename(repo), 'idle', new Date().toISOString(), `s-${id}`, 'claude');
  io.connect(id);
  return id;
}
const CRITERIA = [
  { text: 'When an owner saves an expense of 12.50, the system shall list it.', expect: 'save 12.50 → the list shows 12.50', verify: 'test' },
  { text: 'When expenses exist in March, the system shall total them.', expect: '12.50 + 7.25 in March → March total 19.75', verify: 'test' },
  { text: 'The guide reads clearly for a new owner.', expect: 'A new owner follows it start to finish unaided.', verify: 'checklist' },
];
function writeTest(repo: string, id: string, expected: string) {
  const rel = `acceptance/${id.toLowerCase()}.check.mjs`;
  fs.mkdirSync(path.join(repo, 'acceptance'), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), [
    "import fs from 'node:fs';",
    `const want = ${JSON.stringify(expected)};`,
    "let got = null; try { got = JSON.parse(fs.readFileSync('feature.json', 'utf8'))[" + JSON.stringify(id) + "]; } catch {}",
    `if (got !== want) { console.log('${id}: expected', JSON.stringify(want), 'got', JSON.stringify(got)); process.exit(1); }`,
    `console.log('${id}: ok');`,
  ].join('\n'));
  return { criterionId: id, files: [rel], command: `${NODE} ${rel}` };
}
function implement(repo: string, id: string, value: string) {
  const f = path.join(repo, 'feature.json');
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  cur[id] = value;
  fs.writeFileSync(f, JSON.stringify(cur));
}
const WANT: Record<string, string> = { 'AC-1': 'save 12.50 → the list shows 12.50', 'AC-2': 'March total 19.75' };
const stage = (pilotId: string, kind: string, i = 0) => stagesOf(pilotId).filter((s) => s.kind === kind)[i];
function finishRun(runId: string) {
  const t = new Date().toISOString();
  db.prepare(`UPDATE workflow_steps SET status = 'completed', result = 'Done: the step', completed_at = ? WHERE workflow_id = ?`).run(t, runId);
  db.prepare(`UPDATE workflows SET status = 'completed', completed_at = ? WHERE id = ?`).run(t, runId);
}
const runs = () => (db.prepare('SELECT COUNT(*) AS c FROM workflows').get() as { c: number }).c;
const view = async (pilotId: string) => (await call('GET', `/api/goal-pilots/${pilotId}`)).json;
const outcomes = async (pilotId: string) => (await view(pilotId)).acceptance.states.map((s: { id: string; outcome: string }) => [s.id, s.outcome]);
/** The reviewer answers, the person confirms. */
async function review(pilotId: string, met: boolean, evidence: string) {
  const rv = stage(pilotId, 'review');
  assert.equal(rv.status, 'running', `the review is ${rv.status} (${rv.waitReason})`);
  const sub = await post(`/api/goal-pilots/requests/${rv.requestId}/submit`, { result: { verdicts: [{ criterionId: 'AC-3', verdict: met ? 'met' : 'not-met', evidence }] } });
  assert.equal(sub.status, 200, JSON.stringify(sub.json));
  const ok = await post(`/api/goal-pilots/${pilotId}/acceptance/checklist`, { confirmations: { 'AC-3': { accepted: met } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
}

/** A feature DELIVERED WITH GAPS: only AC-1 built, the guide judged unclear — the pipeline completed anyway. */
async function deliveredWithGaps() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-repo-'));
  const agent = cartridge(repo);
  const c = await post('/api/goal-pilots', { intake: { goal: `Expenses ${++n}`, context: 'c', workType: 'feature', done: 'd', involvement: 'balanced' }, plannerAgentId: agent });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const pilotId = c.json.pilot.id as string;
  const rid = () => getPilot(pilotId)!.currentRequestId;
  for (const result of [{ status: 'complete', brief: { summary: 'Expenses next to income.' }, criteria: CRITERIA }, { stages: [{ template: 'QA Testing Guide', title: 'Build and test it' }] }]) {
    const r = await post(`/api/goal-pilots/requests/${rid()}/submit`, { result });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal((await post(`/api/goal-pilots/${pilotId}/accept-plan`, {})).status, 200);
  assert.equal((await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] })).status, 200);
  const tests = ['AC-1', 'AC-2'].map((id) => writeTest(repo, id, WANT[id]));
  assert.equal((await post(`/api/goal-pilots/requests/${getContract(pilotId)!.requestId}/submit`, { result: { tests } })).status, 200);
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, {})).status, 200);
  await settleAcceptanceForTests();
  assert.equal(getContract(pilotId)!.status, 'locked');
  implement(repo, 'AC-1', WANT['AC-1']);
  finishRun(stage(pilotId, 'workflow').runId);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  await review(pilotId, false, 'Step 3 refers to a menu that does not exist.');
  assert.equal(getPilot(pilotId)!.phase, 'completed');
  assert.deepEqual(await outcomes(pilotId), [['AC-1', 'pass'], ['AC-2', 'fail'], ['AC-3', 'not-met']]);
  assert.equal((await call('GET', `/api/goal-pilots/${pilotId}/report`)).json.status, 'PARTIAL');
  return { pilotId, repo, agent };
}

test('retest: the locked tests run again, the checklist is reviewed again and confirmed, the report is rewritten — and nothing is built', async () => {
  const { pilotId, repo } = await deliveredWithGaps();
  assert.deepEqual(gapsOf(pilotId).map((g) => g.id), ['AC-2', 'AC-3']);
  // Since delivery the missing part was done by hand, and the guide was fixed.
  implement(repo, 'AC-2', WANT['AC-2']);
  const before = { runs: runs(), workflow: stage(pilotId, 'workflow'), checks: getContract(pilotId)!.verifications.length, firstReview: stage(pilotId, 'review').requestId };

  const r = await post(`/api/goal-pilots/${pilotId}/acceptance/retest`);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.throws(() => retestAcceptance(pilotId), /already running/);
  await settleAcceptanceForTests();

  // The tests: new evidence, named as a retest, both passing now.
  const c = getContract(pilotId)!;
  assert.equal(c.verifications.length, before.checks + 1);
  const v = c.verifications[c.verifications.length - 1];
  assert.deepEqual([v.stageId, v.stageTitle, v.status, v.passing, v.total, v.tampered.length], ['', RETEST_TITLE, 'passed', 2, 2, 0]);
  const states = (await view(pilotId)).acceptance.states;
  assert.deepEqual(states.slice(0, 2).map((s: { id: string; outcome: string; lastStage: string }) => [s.id, s.outcome, s.lastStage]), [['AC-1', 'pass', RETEST_TITLE], ['AC-2', 'pass', RETEST_TITLE]]);
  // The checklist: the pipeline is back at its review, with a NEW request; the old verdict no longer counts.
  assert.equal(getPilot(pilotId)!.phase, 'running');
  const rv = stage(pilotId, 'review');
  assert.equal(rv.status, 'running');
  assert.ok(rv.requestId && rv.requestId !== before.firstReview);
  assert.equal(states[2].outcome, 'not-checked');
  assert.equal((await view(pilotId)).acceptance.retesting, false);

  await review(pilotId, true, 'Followed the guide start to finish; every step matches the screens.');
  assert.equal(getPilot(pilotId)!.phase, 'completed');
  assert.deepEqual(await outcomes(pilotId), [['AC-1', 'pass'], ['AC-2', 'pass'], ['AC-3', 'met']]);
  const report = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.deepEqual([report.status, report.acceptance.passing, report.acceptance.total], ['SUCCESS', 3, 3]);
  // Nothing was built: no new run, and the workflow stage is exactly as it was.
  assert.equal(runs(), before.runs);
  assert.deepEqual(stage(pilotId, 'workflow'), before.workflow);
  assert.deepEqual(stagesOf(pilotId).map((s) => [s.kind, s.status]), [['acceptance', 'completed'], ['workflow', 'completed'], ['review', 'completed']]);
  assert.deepEqual(gapsOf(pilotId), []);
  // With no gap left there is nothing to fix.
  const fix = await post(`/api/goal-pilots/${pilotId}/acceptance/fix`);
  assert.equal(fix.status, 409);
  assert.match(fix.json.error, /nothing to fix/);
});

test('a retest that still finds gaps: "fix" adds ONE workflow stage for exactly those criteria, in front of the review — then the ordinary checks', async () => {
  const { pilotId, repo } = await deliveredWithGaps();
  // Retest with nothing changed: the gaps are confirmed, and the feature is delivered-with-gaps again.
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/retest`)).status, 202);
  await settleAcceptanceForTests();
  await review(pilotId, false, 'Step 3 still refers to a menu that does not exist.');
  assert.equal(getPilot(pilotId)!.phase, 'completed');
  assert.deepEqual(await outcomes(pilotId), [['AC-1', 'pass'], ['AC-2', 'fail'], ['AC-3', 'not-met']]);

  const before = { runs: runs(), source: stage(pilotId, 'workflow') };
  const fix = await post(`/api/goal-pilots/${pilotId}/acceptance/fix`);
  assert.equal(fix.status, 200, JSON.stringify(fix.json));
  const stages = stagesOf(pilotId);
  assert.deepEqual(stages.map((s) => [s.position, s.kind]), [[0, 'acceptance'], [1, 'workflow'], [2, 'workflow'], [3, 'review']]);
  const added = stages[2];
  assert.equal(added.title, 'Close the gaps: AC-2, AC-3');
  assert.deepEqual([added.template, added.templateId, added.repoPath, added.agentType, added.projectId], [before.source.template, before.source.templateId, before.source.repoPath, before.source.agentType, before.source.projectId]);
  // Its brief is the gaps: each criterion, what it expects, and the evidence against it — and no criterion that passes.
  for (const part of ['### AC-2 (test)', CRITERIA[1].text, CRITERIA[1].expect, 'AC-2: expected', '### AC-3 (checklist)', CRITERIA[2].text, 'Step 3 still refers to a menu that does not exist.', 'Do not change the locked acceptance tests']) {
    assert.ok(added.focus.includes(part), `the fix stage's brief does not say: ${part}`);
  }
  assert.equal(added.focus.includes('### AC-1'), false);
  // It is running: a new run, in the same pipeline; the earlier stage is untouched.
  assert.equal(getPilot(pilotId)!.phase, 'running');
  assert.equal(added.status, 'running', added.waitReason);
  assert.ok(added.runId && added.runId !== before.source.runId);
  assert.equal(runs(), before.runs + 1);
  assert.deepEqual(stage(pilotId, 'workflow', 0), before.source);
  assert.equal(stages[3].status, 'pending');
  // A second fix, or a retest, while it works is refused.
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/fix`)).status, 409);
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/retest`)).status, 409);

  // The fix does its work; the locked tests are run, the checklist reviewed — the ordinary ending.
  implement(repo, 'AC-2', WANT['AC-2']);
  finishRun(added.runId);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  assert.match(stage(pilotId, 'workflow', 1).resultSummary, /2\/2 criteria passing/);
  await review(pilotId, true, 'Step 3 now names the real menu; followed it start to finish.');
  assert.equal(getPilot(pilotId)!.phase, 'completed');
  assert.equal((await call('GET', `/api/goal-pilots/${pilotId}/report`)).json.status, 'SUCCESS');
});

test('a retest is refused where it makes no sense, and a changed locked test stops it — said, with nothing re-judged', async () => {
  const { pilotId, repo } = await deliveredWithGaps();
  assert.equal((await post('/api/goal-pilots/no-such-pilot/acceptance/retest')).status, 404);
  // A locked test edited since it was approved: the retest does not run, and says which file.
  fs.appendFileSync(path.join(repo, 'acceptance/ac-2.check.mjs'), '\nprocess.exit(0);\n');
  const checks = getContract(pilotId)!.verifications.length;
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/retest`)).status, 202);
  await settleAcceptanceForTests();
  const c = getContract(pilotId)!;
  const v = c.verifications[c.verifications.length - 1];
  assert.deepEqual([c.verifications.length, v.status, v.stageTitle, v.tampered.map((f) => f.path)], [checks + 1, 'tampered', RETEST_TITLE, ['acceptance/ac-2.check.mjs']]);
  const p = getPilot(pilotId)!;
  assert.equal(p.phase, 'completed', 'the feature stays delivered; the review is not reopened');
  assert.match(p.attention, /retest did not run: locked acceptance tests were changed.*acceptance\/ac-2\.check\.mjs/);
  assert.deepEqual(await outcomes(pilotId), [['AC-1', 'pass'], ['AC-2', 'fail'], ['AC-3', 'not-met']], 'a tampered run judges nothing');
  assert.equal(stage(pilotId, 'review').status, 'completed');
});
