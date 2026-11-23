/**
 * QA FOLLOWS THE FEATURE: a feature's acceptance criteria are its QA test, written and run by
 * NeonCore — nobody enters anything. It runs each time a workflow stage of the feature finishes,
 * and the report says, per project and per feature, which criteria pass, with the screenshot.
 */
import './helpers/isolated-db.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import type { QaAction, RunnerResult, RunnerSpec } from '../src/lib/qa/types.ts';
import { createTarget, getRun, getTest, listTests, listRuns } from '../src/lib/qa/store.ts';
import { submitQaResult, qaSettled } from '../src/lib/qa/engine.ts';
import { setQaRunner } from '../src/lib/qa/runner.ts';
import { setQaSender, requestsOf } from '../src/lib/qa/dispatch.ts';
import { createPilotRow, setPhase } from '../src/lib/goal-pilot.ts';
import { createContract, updateContract, getContract } from '../src/lib/acceptance-contract.ts';
import { syncFeatureTest, sweepFeatureQa, runFeatureQa, featureQaReport, sentenceFor, type FeatureQa } from '../src/lib/qa/feature-link.ts';

installStubIO();
process.env.NEONCORE_QA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-feature-'));

const AGENT = 'qa-feature-cartridge';
db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, agent_type) VALUES (?, 'box/app', 'box', '/tmp/app', 'app', 'idle', ?, 'claude')`)
  .run(AGENT, new Date().toISOString());
setQaSender(() => ({ ok: true }));
/** The stubbed browser: a check on a criterion named in `broken` fails; every step leaves a screenshot. */
let broken = new Set<string>();
setQaRunner(async (spec: RunnerSpec): Promise<RunnerResult> => {
  const steps: RunnerResult['steps'] = spec.cache.map((actions, index) => {
    const bad = actions.find((a) => a.do === 'expect' && a.target && broken.has(String(a.target.name)));
    return bad
      ? { index, sentence: spec.sentences[index], status: 'failed' as const, error: `expected ${(bad as { target: { name: string } }).target.name} to be visible`, screenshot: `step-${index}.png` }
      : { index, sentence: spec.sentences[index], status: 'passed' as const, screenshot: `step-${index}.png` };
  });
  return { status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed', steps, console: [], network: [], trace: '', durationMs: 1 };
});
beforeEach(() => { broken = new Set(); });

let n = 0;
const CRITERIA = [
  { id: 'AC-1', text: 'When an owner saves an expense of 12.50, the system shall list it.', expect: 'save 12.50 → the list shows 12.50', verify: 'test' as const },
  { id: 'AC-2', text: 'The guide reads clearly\nfor a new owner.', expect: '', verify: 'checklist' as const },
];
function project(name = `Atlas ${++n}`): string {
  const id = `qf-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/tmp/app','#4af',?,?)`).run(id, name, '2026-01-01', '2026-01-01');
  return id;
}
function goal(projectId: string, name: string, origin = 'planned'): string {
  const id = `qf-g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, target_date, origin) VALUES (?,?,'','active',?,?,?,?,'',?)`)
    .run(id, name, '2026-01-01', '2026-01-01', projectId, n, origin);
  return id;
}
/** A feature being developed: a pilot, a contract with criteria, and `stages` workflow stages (none finished). */
function feature(projectId: string, name: string, opts: { criteria?: typeof CRITERIA; stages?: number } = {}) {
  const goalId = goal(projectId, name);
  const pilot = createPilotRow({ goalId, plannerAgentId: AGENT, intake: { goal: name } });
  setPhase(pilot.id, 'running');
  if (opts.criteria !== undefined ? opts.criteria.length : true) createContract({ pilotId: pilot.id, goalId, criteria: opts.criteria ?? CRITERIA, repoPath: '/tmp/app', agentType: 'claude' });
  const stageIds = Array.from({ length: opts.stages ?? 2 }, (_, i) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO goal_pilot_stages (id, pilot_id, position, kind, stage_key, template_id, template_name, title, why, focus, repo_path, agent_type, project_id, status, participants, skip_steps)
                VALUES (?, ?, ?, 'workflow', ?, '', 'Build', ?, '', '', '/tmp/app', 'claude', ?, 'pending', '[]', '[]')`).run(id, pilot.id, i, `s${i}`, `Stage ${i + 1}`, projectId);
    return id;
  });
  return { goalId, pilotId: pilot.id, stageIds };
}
const finishStage = (stageId: string) => db.prepare(`UPDATE goal_pilot_stages SET status = 'completed' WHERE id = ?`).run(stageId);
const target = (projectId: string) => createTarget({ name: 'App', projectId, baseUrl: 'http://localhost:4061', allowHosts: ['localhost:4061'], agentId: AGENT });
const cacheFor = (ids: string[]): QaAction[][] => ids.map((id) => [{ do: 'goto', path: '/' }, { do: 'expect', kind: 'visible', target: { name: id } }]);
const of = (projectId: string) => featureQaReport().find((p) => p.projectId === projectId)!;
const feat = (projectId: string, goalId: string): FeatureQa => of(projectId).features.find((f) => f.goalId === goalId)!;
const featureTests = (targetId: string) => listTests(targetId).filter((t) => t.source === 'feature');
/** The cartridge answers the pending author request with one check per criterion. */
function author(runId: string, ids = ['AC-1', 'AC-2']) {
  const req = requestsOf(runId).find((r) => r.kind === 'author' && r.status === 'pending');
  assert.ok(req, 'the cartridge was asked to work out the actions');
  submitQaResult(req!.id, { cache: cacheFor(ids) });
}

test('without a QA target nothing runs, and the report says exactly what is missing — per feature', () => {
  const p = project();
  const f = feature(p, 'Expenses');
  const bare = feature(p, 'No criteria yet', { criteria: [] });
  goal(p, 'Just an idea');                    // nobody started on it: not QA's business yet
  goal(p, 'Already there', 'imported');
  finishStage(f.stageIds[0]);
  assert.deepEqual(sweepFeatureQa().filter((id) => id === f.goalId), []);
  assert.equal(syncFeatureTest(f.goalId), null);
  const rep = of(p);
  assert.equal(rep.target, null);
  assert.deepEqual(rep.features.map((x) => [x.name, x.state]), [['Expenses', 'no-target'], ['No criteria yet', 'no-criteria']]);
  assert.match(feat(p, f.goalId).note, /Add a QA target/);
  assert.match(feat(p, bare.goalId).note, /No acceptance criteria yet/);
  assert.deepEqual([rep.passed, rep.total], [0, 2]);
  assert.throws(() => runFeatureQa(f.goalId), /no QA target/);
  assert.throws(() => runFeatureQa('nope'), /feature not found/);
});

test('the criteria ARE the test: one check sentence each, written once, and nothing runs until something is built', () => {
  const p = project();
  const t = target(p);
  const f = feature(p, 'Expenses');
  assert.deepEqual(sweepFeatureQa(), []);
  assert.deepEqual(sweepFeatureQa(), []);
  const tests = featureTests(t.id);
  assert.equal(tests.length, 1, 'one test for the feature, however often the sweep runs');
  assert.equal(tests[0].name, 'Feature: Expenses');
  assert.deepEqual(tests[0].sentences, [
    'Verify AC-1: When an owner saves an expense of 12.50, the system shall list it. Expected: save 12.50 → the list shows 12.50',
    'Verify AC-2: The guide reads clearly for a new owner.',
  ]);
  assert.deepEqual(tests[0].sentences, CRITERIA.map(sentenceFor));
  assert.equal(listRuns(t.id).length, 0);
  const row = feat(p, f.goalId);
  assert.equal(row.state, 'waiting-for-build');
  assert.deepEqual(row.criteria.map((c) => [c.id, c.status]), [['AC-1', 'not-run'], ['AC-2', 'not-run']]);
  assert.match(row.note, /Runs by itself as soon as the first workflow stage/);
  assert.throws(() => runFeatureQa(feature(p, 'Empty', { criteria: [] }).goalId), /no acceptance criteria/);
});

test('each finished workflow stage runs the feature\'s test by itself — once — and the report shows every criterion with its screenshot', async () => {
  const p = project();
  const t = target(p);
  const f = feature(p, 'Expenses');
  const other = feature(p, 'Income');
  sweepFeatureQa();
  finishStage(f.stageIds[0]);
  assert.deepEqual(sweepFeatureQa(), [f.goalId], 'only the feature that built something');
  assert.deepEqual(sweepFeatureQa(), [], 'not again while it runs');
  await qaSettled();
  const [run] = listRuns(t.id);
  assert.deepEqual(run.testIds, [featureTests(t.id).find((x) => x.name === 'Feature: Expenses')!.id], 'that feature\'s test and no other');
  assert.equal(feat(p, f.goalId).state, 'running');
  assert.match(feat(p, f.goalId).note, /cartridge is working out how to test each criterion/);
  assert.deepEqual(feat(p, f.goalId).criteria.map((c) => c.status), ['running', 'running']);

  author(run.id);
  await qaSettled();
  assert.equal(getRun(run.id)!.status, 'passed');
  const row = feat(p, f.goalId);
  assert.deepEqual([row.state, row.passed, row.total, row.runId, row.reportUrl], ['passed', 2, 2, run.id, `/api/qa/runs/${run.id}/report.html`]);
  assert.deepEqual(row.criteria.map((c) => [c.id, c.status, c.screenshot]), [
    ['AC-1', 'passed', `/api/qa/evidence/${run.id}/step-0.png`], ['AC-2', 'passed', `/api/qa/evidence/${run.id}/step-1.png`],
  ]);
  const rep = of(p);
  assert.deepEqual([rep.passed, rep.total, rep.featuresPassing, rep.features.length], [2, 4, 1, 2]);
  assert.equal(feat(p, other.goalId).state, 'waiting-for-build');
  // Nothing new was built: no new run.
  assert.deepEqual(sweepFeatureQa(), []);
  assert.equal(listRuns(t.id).length, 1);

  // The next stage breaks AC-2: QA runs again by itself, replays, and the failure is the criterion's.
  broken = new Set(['AC-2']);
  finishStage(f.stageIds[1]);
  assert.deepEqual(sweepFeatureQa(), [f.goalId]);
  await qaSettled();
  const run2 = listRuns(t.id).find((r) => r.id !== run.id)!;
  const repair = requestsOf(run2.id).find((r) => r.kind === 'repair' && r.status === 'pending');
  assert.ok(repair, 'a failed step first goes to repair, as for any QA test');
  submitQaResult(repair!.id, { impossible: 'The guide page is gone.' });
  await qaSettled();
  assert.equal(getRun(run2.id)!.status, 'failed');
  const after = feat(p, f.goalId);
  assert.deepEqual([after.state, after.passed, after.total, after.runId], ['failed', 1, 2, run2.id]);
  assert.deepEqual(after.criteria.map((c) => [c.id, c.status]), [['AC-1', 'passed'], ['AC-2', 'failed']]);
  assert.match(after.criteria[1].error, /expected AC-2 to be visible/);
  assert.ok(after.criteria[1].screenshot.endsWith('/step-1.png'));
  assert.ok(after.note.length > 0);
});

test('criteria that change rewrite the test — the old result no longer counts, and the old actions are dropped', async () => {
  const p = project();
  const t = target(p);
  const f = feature(p, 'Expenses');
  finishStage(f.stageIds[0]);
  sweepFeatureQa();
  await qaSettled();
  author(listRuns(t.id)[0].id);
  await qaSettled();
  assert.equal(feat(p, f.goalId).state, 'passed');
  const testId = featureTests(t.id)[0].id;
  assert.ok(getTest(testId)!.cache);

  const c = getContract(f.pilotId)!;
  updateContract(c.id, { criteria: [...c.criteria, { id: 'AC-3', text: 'Totals are shown per month.', expect: 'March total 19.75', verify: 'test' }] });
  assert.deepEqual(sweepFeatureQa(), [], 'a change of words alone builds nothing: no run');
  const now = getTest(testId)!;
  assert.equal(featureTests(t.id).length, 1, 'the same test, rewritten');
  assert.equal(now.sentences.length, 3);
  assert.equal(now.cache, null);
  const row = feat(p, f.goalId);
  assert.deepEqual([row.state, row.passed, row.total], ['not-run', 0, 3]);
  assert.match(row.note, /criteria changed since the last run/);
});

test('a feature delivered before its project had a target is not run on its own — it can be run by hand, once at a time', async () => {
  const p = project();
  const f = feature(p, 'Old feature', { stages: 1 });
  finishStage(f.stageIds[0]);
  setPhase(f.pilotId, 'completed');
  const t = target(p);
  assert.deepEqual(sweepFeatureQa(), []);
  assert.equal(listRuns(t.id).length, 0);
  assert.equal(feat(p, f.goalId).state, 'not-run');
  assert.match(feat(p, f.goalId).note, /Delivered before QA was set up/);
  const run = runFeatureQa(f.goalId);
  assert.throws(() => runFeatureQa(f.goalId), /already running/);
  await qaSettled();
  author(run.id);
  await qaSettled();
  assert.equal(feat(p, f.goalId).state, 'passed');
  assert.deepEqual(sweepFeatureQa(), []);
});
