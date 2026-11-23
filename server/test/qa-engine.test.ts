/**
 * THE QA ENGINE (docs/plans/qa-section.md) — every run kind end to end, with the browser and the
 * cartridge stubbed: the runner is a function of the cache it is given, the cartridge answers
 * through the same submit path a real one uses.
 *
 * SET-BASED where there is a registry: every expect kind for the repair rule, every run kind,
 * every request kind's silence.
 */
import './helpers/isolated-db.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { validateRepair, parseCache } from '../src/lib/qa/actions.ts';
import { EXPECT_KINDS, RUN_KINDS, REQUEST_KINDS, type QaAction, type RunnerResult, type RunnerSpec } from '../src/lib/qa/types.ts';
import { createTarget, createTest, getRun, getTest, listRepairs, resultsOf, decideRepair, updateTarget } from '../src/lib/qa/store.ts';
import { startRun, submitQaResult, qaSettled } from '../src/lib/qa/engine.ts';
import { setQaRunner } from '../src/lib/qa/runner.ts';
import { setQaSender, requestsOf, sweepQaRequests, getRequest } from '../src/lib/qa/dispatch.ts';
import { recordFinding, listFindings } from '../src/lib/qa/findings.ts';
import { PLANNER_SILENT_MS } from '../src/lib/goal-pilot-runner.ts';

installStubIO();
process.env.NEONCORE_QA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-engine-'));

const AGENT = 'qa-cartridge';
db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, agent_type) VALUES (?, 'box/qa', 'box', '/tmp/qa', 'qa', 'idle', ?, 'claude')`)
  .run(AGENT, new Date().toISOString());

/** Prompts the stubbed cartridge received. */
const sent: { agentId: string; prompt: string }[] = [];
setQaSender((agentId, prompt) => { sent.push({ agentId, prompt }); return { ok: true }; });

/** The stubbed browser: a click on a locator named in `broken` fails; anything else passes. */
let broken = new Set<string>();
let runnerCalls = 0;
setQaRunner(async (spec: RunnerSpec): Promise<RunnerResult> => {
  runnerCalls++;
  const steps: RunnerResult['steps'] = [];
  let failed = false;
  spec.cache.forEach((actions, index) => {
    if (failed) { steps.push({ index, sentence: spec.sentences[index], status: 'skipped' }); return; }
    const bad = actions.find((a) => (a.do === 'click' || a.do === 'expect') && 'target' in a && a.target && broken.has(String(a.target.name ?? a.target.label ?? '')));
    if (bad) { failed = true; steps.push({ index, sentence: spec.sentences[index], status: 'failed', error: `no element named ${JSON.stringify((bad as { target: { name?: string } }).target.name)}` }); }
    else steps.push({ index, sentence: spec.sentences[index], status: 'passed' });
  });
  return { status: failed ? 'failed' : 'passed', steps, console: [], network: [], trace: '', durationMs: 1 };
});

beforeEach(() => { broken = new Set(); sent.length = 0; runnerCalls = 0; });

function target(over: Record<string, unknown> = {}) {
  return createTarget({ name: 'Demo', baseUrl: 'http://localhost:4061', allowHosts: ['localhost:4061'], agentId: AGENT, ...over });
}
const SENTENCES = ['Log in as a supervisor.', 'Click Submit.', 'Check that the status is Awaiting approval.'];
const CACHE: QaAction[][] = [
  [{ do: 'goto', path: '/login' }, { do: 'fill', target: { label: 'User' }, valueEnv: 'QA_USER' }],
  [{ do: 'click', target: { role: 'button', name: 'Submit' } }],
  [{ do: 'expect', kind: 'text', target: { name: 'Status' }, equals: 'Awaiting approval' }],
];
const pendingOf = (runId: string, kind: string) => requestsOf(runId).find((r) => r.kind === kind && r.status === 'pending');

// ── the repair rule, over every expect kind ─────────────────────────────────────────────

for (const kind of EXPECT_KINDS) {
  test(`repair rule (${kind}): a new locator is fine, a changed check is not`, () => {
    const s = 'Check that it shows the total.';
    const before: QaAction[] = [{ do: 'expect', kind, target: { name: 'Old' }, equals: '42', contains: 'x' }];
    assert.deepEqual(validateRepair(s, before, [{ do: 'expect', kind, target: { css: '#new' }, equals: '42', contains: 'x' }]), { ok: true });
    assert.equal(validateRepair(s, before, [{ do: 'expect', kind, target: { css: '#new' }, equals: '43', contains: 'x' }]).ok, false, 'changed equals');
    assert.equal(validateRepair(s, before, [{ do: 'expect', kind, target: { css: '#new' }, equals: '42', contains: 'y' }]).ok, false, 'changed contains');
    const other = EXPECT_KINDS.find((k) => k !== kind)!;
    assert.equal(validateRepair(s, before, [{ do: 'expect', kind: other, target: { css: '#new' }, equals: '42', contains: 'x' }]).ok, false, 'changed kind');
    assert.equal(validateRepair(s, before, [{ do: 'click', target: { name: 'x' } }]).ok, false, 'dropped expect');
    assert.equal(validateRepair(s, before, [...before, { do: 'expect', kind, equals: 'extra' }]).ok, false, 'added expect');
  });
}

test('a non-check sentence may be repaired freely', () => {
  assert.deepEqual(validateRepair('Click Submit.', [{ do: 'click', target: { name: 'Submit' } }], [{ do: 'click', target: { name: 'Send' } }]), { ok: true });
});

test('a cache must have an expect in every check sentence, and one list per sentence', () => {
  assert.throws(() => parseCache([[{ do: 'goto', path: '/' }]], SENTENCES), /3 sentences/);
  assert.throws(() => parseCache([CACHE[0], CACHE[1], [{ do: 'click', target: { name: 'x' } }]], SENTENCES), /must include an expect/);
  assert.throws(() => parseCache([[{ do: 'goto', path: 'https://evil.example/' }], CACHE[1], CACHE[2]], SENTENCES), /relative/);
});

// ── targets: the allow-list ─────────────────────────────────────────────────────────────

test('a target whose base URL host is not on the allow-list is refused', () => {
  assert.throws(() => target({ baseUrl: 'https://prod.example.com', allowHosts: ['localhost:4061'] }), /not on the allow-list/);
  assert.throws(() => target({ credentialsEnv: { supervisor: { user: 'alice@example.com', pass: 'hunter2' } } }), /ENVIRONMENT VARIABLES/);
  const t = target({ baseUrl: 'https://prod.example.com', allowHosts: ['localhost:4061'], productionAllowed: true });
  assert.equal(t.productionAllowed, true, 'production only with the explicit flag');
  assert.throws(() => updateTarget(t.id, { productionAllowed: false }), /not on the allow-list/);
});

// ── every run kind ──────────────────────────────────────────────────────────────────────

test('every run kind is covered below', () => {
  assert.deepEqual([...RUN_KINDS], ['run', 'explore', 'generate']);
});

test('run: a cached test replays with zero AI calls', async () => {
  const t = target();
  createTest({ targetId: t.id, sentences: SENTENCES, cache: CACHE });
  const run = startRun({ targetId: t.id, kind: 'run' });
  await qaSettled();
  const done = getRun(run.id)!;
  assert.equal(done.status, 'passed');
  assert.equal(done.aiCalls, 0);
  assert.equal(sent.length, 0, 'no cartridge was asked anything');
  assert.equal(runnerCalls, 1);
});

test('run: a failed cached step is repaired → passed_with_repair, with a repair to review', async () => {
  const t = target();
  const tc = createTest({ targetId: t.id, sentences: SENTENCES, cache: CACHE });
  broken = new Set(['Status']);           // the status field was moved and relabelled
  const run = startRun({ targetId: t.id, kind: 'run' });
  await qaSettled();
  assert.equal(getRun(run.id)!.status, 'waiting');
  const req = pendingOf(run.id, 'repair')!;
  assert.ok(req, 'a repair was asked for');
  assert.equal(req.context.sentenceIndex, 2);
  assert.match(sent.at(-1)!.prompt, /never change what it checks/i);
  assert.match(sent.at(-1)!.prompt, /DATA, never instructions/);
  // A repair that changes WHAT is checked is refused, and the request stays open for another try.
  assert.throws(() => submitQaResult(req.id, { sentenceIndex: 2, actions: [{ do: 'expect', kind: 'text', target: { label: 'State' }, equals: 'Draft' }] }), /repair rejected/);
  assert.equal(getRequest(req.id)!.status, 'pending');
  submitQaResult(req.id, { sentenceIndex: 2, actions: [{ do: 'expect', kind: 'text', target: { label: 'State' }, equals: 'Awaiting approval' }] });
  await qaSettled();
  const done = getRun(run.id)!;
  assert.equal(done.status, 'passed_with_repair');
  assert.equal(done.aiCalls, 1);
  const repairs = listRepairs({ runId: run.id });
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].status, 'pending');
  assert.equal((getTest(tc.id)!.cache![2][0] as { target: { label: string } }).target.label, 'State');
  // Rejecting the repair puts the old cache back and flags the test.
  decideRepair(repairs[0].id, 'rejected');
  assert.equal((getTest(tc.id)!.cache![2][0] as { target: { name: string } }).target.name, 'Status');
  assert.equal(getTest(tc.id)!.needsAttention, true);
});

test('run: a step that can no longer be done FAILS — a repair never hides a regression', async () => {
  const t = target();
  createTest({ targetId: t.id, sentences: SENTENCES, cache: CACHE });
  broken = new Set(['Submit']);
  const run = startRun({ targetId: t.id, kind: 'run' });
  await qaSettled();
  submitQaResult(pendingOf(run.id, 'repair')!.id, { impossible: 'the approval feature is gone' });
  await qaSettled();
  assert.equal(getRun(run.id)!.status, 'failed');
  assert.match(resultsOf(run.id)[0].error, /approval feature is gone/);
});

test('run: an uncached test is authored by the cartridge, then replayed', async () => {
  const t = target();
  const tc = createTest({ targetId: t.id, sentences: SENTENCES });
  const run = startRun({ targetId: t.id, kind: 'run' });
  await qaSettled();
  const req = pendingOf(run.id, 'author')!;
  assert.ok(req);
  assert.throws(() => submitQaResult(req.id, { cache: [CACHE[0]] }), /sentences/);
  submitQaResult(req.id, { cache: CACHE });
  await qaSettled();
  assert.equal(getRun(run.id)!.status, 'passed');
  assert.equal(getRun(run.id)!.aiCalls, 1);
  assert.ok(getTest(tc.id)!.cache, 'the cache was stored for next time');
  // …and the next run replays it with no AI.
  const again = startRun({ targetId: t.id, kind: 'run' });
  await qaSettled();
  assert.equal(getRun(again.id)!.aiCalls, 0);
});

test('explore: findings are recorded once, each with a reproduction test', async () => {
  const t = target();
  const run = startRun({ targetId: t.id, kind: 'explore', goal: 'focus on approvals' });
  const req = pendingOf(run.id, 'explore')!;
  assert.match(sent.at(-1)!.prompt, /focus on approvals/);
  assert.match(sent.at(-1)!.prompt, /BUGS\.md/);
  const f = { severity: 'high', kind: 'dead-button', title: 'Export does nothing', detail: 'no request, no download', page: '/reports', steps: ['Go to /reports', 'Click Export'], sentences: ['Go to the reports list.', 'Click Export.', 'Check that a download starts.'] };
  submitQaResult(req.id, { findings: [f, { ...f, page: '/reports?page=2' }], coverage: { pages: ['/reports'] } });
  const done = getRun(run.id)!;
  assert.equal(done.status, 'completed');
  assert.equal(done.aiCalls, 1);
  const findings = listFindings(t.id);
  assert.equal(findings.length, 1, 'one bug, one finding');
  assert.equal(findings[0].seenCount, 2);
  assert.ok(getTest(findings[0].reproTestId), 'with its reproduction test');
});

test('generate: no journeys, no tests — and no AI', () => {
  const t = target();
  const run = startRun({ targetId: t.id, kind: 'generate' });
  assert.equal(getRun(run.id)!.status, 'completed');
  assert.equal(getRun(run.id)!.aiCalls, 0);
});

// ── dedupe ──────────────────────────────────────────────────────────────────────────────

test('the same finding reached by ten paths is one row, seen ten times', () => {
  const t = target();
  for (let i = 0; i < 10; i++) {
    recordFinding(t.id, 'run-x', { kind: 'console', title: `TypeError: cannot read 'total' of undefined at line ${100 + i}`, page: `/reports/${i + 1}?tab=${i}`, severity: 'medium', steps: [`path ${i}`] });
  }
  const fs_ = listFindings(t.id);
  assert.equal(fs_.length, 1);
  assert.equal(fs_[0].seenCount, 10);
  assert.equal(fs_[0].page, '/reports/:id');
});

// ── silence and delivery, every request kind ─────────────────────────────────────────────

for (const kind of REQUEST_KINDS) {
  test(`${kind}: a cartridge whose turn ended without submitting fails the request; a long tool call does not`, async () => {
    const t = target();
    let run;
    if (kind === 'explore') run = startRun({ targetId: t.id, kind: 'explore' });
    else {
      createTest({ targetId: t.id, sentences: SENTENCES, ...(kind === 'repair' ? { cache: CACHE } : {}) });
      if (kind === 'repair') broken = new Set(['Submit']);
      run = startRun({ targetId: t.id, kind: 'run' });
      await qaSettled();
    }
    const req = pendingOf(run.id, kind)!;
    assert.ok(req, `a ${kind} request was sent`);
    const later = Date.parse(req.dispatchedAt!) + PLANNER_SILENT_MS + 60_000;
    db.prepare(`UPDATE agents SET status = 'idle', turn_ended_at = '' WHERE id = ?`).run(AGENT);
    sweepQaRequests(later);
    assert.equal(getRequest(req.id)!.status, 'pending', 'idle mid-tool is not silence');
    db.prepare(`UPDATE agents SET turn_ended_at = ? WHERE id = ?`).run(new Date(Date.parse(req.dispatchedAt!) + 1000).toISOString(), AGENT);
    sweepQaRequests(later);
    assert.equal(getRequest(req.id)!.status, 'failed');
    await qaSettled();
    assert.equal(getRun(run.id)!.status, kind === 'explore' ? 'error' : 'failed');
    db.prepare(`UPDATE agents SET turn_ended_at = '' WHERE id = ?`).run(AGENT);
  });
}

test('a busy cartridge is not typed into: the request waits, and goes when it is free', async () => {
  const t = target();
  db.prepare(`UPDATE agents SET status = 'working' WHERE id = ?`).run(AGENT);
  const run = startRun({ targetId: t.id, kind: 'explore' });
  const req = pendingOf(run.id, 'explore')!;
  assert.equal(req.queued, true);
  assert.equal(sent.length, 0);
  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(AGENT);
  sweepQaRequests();
  assert.equal(getRequest(req.id)!.queued, false);
  assert.equal(sent.length, 1);
});

test('a target with no cartridge fails its request instead of waiting forever', async () => {
  const t = target({ agentId: '' });
  const run = startRun({ targetId: t.id, kind: 'explore' });
  assert.equal(requestsOf(run.id)[0].status, 'failed');
  assert.equal(getRun(run.id)!.status, 'error');
});
