/**
 * EPIC QA FOR ANY PROJECT — the run, the block on Passed QA, the sweep (lib/qa/epic-acceptance.ts,
 * lib/qa/epic-qa-store.ts; docs/plans/epic-qa-any-project.md tests 1–3).
 *
 * SET-BASED: every check kind × every outcome lands in the run with the right status; every run
 * status decides Passed QA one way or the other; the sweep is driven through every reason it may
 * or may not start a run. The repo is a stand-in (setRepoAccessForTests): a command's NAME says how
 * it ends, and the locked files' hashes are a map the test can change.
 *
 *   command "ok:<x>"   → exit 0          "bad:<x>"  → exit 1         "slow:<x>" → timed out
 *   repo "/repo/down"  → unreachable (RepoAccessError) → the run is `error`
 */
import './helpers/isolated-db.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { createPilotRow } from '../src/lib/goal-pilot.js';
import { createContract, updateContract, getContract, type Criterion } from '../src/lib/acceptance-contract.js';
import { setRepoAccessForTests, sha256, RepoAccessError, type RepoAccess } from '../src/lib/repo-access.js';
import { createEpic, planFeature, setEpicQa, chartOf } from '../src/lib/roadmap.js';
import { startEpicQa, sweepEpicQa, epicQaSettled } from '../src/lib/qa/epic-acceptance.js';
import {
  EPIC_CHECK_KINDS, EPIC_RUN_STATUSES, currentEpicRun, epicQaBlock, latestEpicRun, insertEpicRun, finishEpicRun,
  epicFinishedAt, type EpicCheckKind, type EpicRunStatus,
} from '../src/lib/qa/epic-qa-store.js';

installStubIO();

// ── the stand-in repo ──
const files = new Map<string, string>();       // path → content as it is "now"
const ran: string[] = [];
setRepoAccessForTests((repoPath: string): RepoAccess => {
  if (repoPath === '/repo/down') throw new RepoAccessError('No runner is connected for the machine this repo is on.');
  return {
    where: 'local', label: 'this machine',
    async readFiles(paths) { return paths.map((p) => ({ path: p, exists: files.has(p), sha256: files.has(p) ? sha256(files.get(p)!) : '', content: files.get(p) ?? '' })); },
    async writeFile() { /* never */ },
    async run(command) {
      ran.push(command);
      const kind = command.split(':')[0];
      return { exitCode: kind === 'ok' ? 0 : kind === 'slow' ? null : 1, timedOut: kind === 'slow', output: `${command} output`, durationMs: 1 };
    },
  } as RepoAccess;
});
beforeEach(() => { ran.length = 0; });

let n = 0;
function project(repo = '/repo/app', qaCommand = ''): string {
  const id = `ea-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at, qa_command) VALUES (?,?,'',?,'#fff',?,?,?)`)
    .run(id, `P${n}`, repo, '2026-01-01', '2026-01-01', qaCommand);
  return id;
}
/** A DONE feature of `epicId`, with a locked contract: `tests` are [criterionId, command, verify]. */
function feature(projectId: string, epicId: string, opts: {
  tests?: [string, string, 'test' | 'command'][];
  checklist?: { id: string; confirmed?: boolean; verdict?: 'met' | 'not-met' }[];
  repo?: string; doneAt?: string; contract?: boolean;
} = {}): { goalId: string; pilotId: string } {
  const goalId = `ea-g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, origin, done_at) VALUES (?,?,'','achieved',?,?,?,?,'planned',?)`)
    .run(goalId, `Feature ${n}`, '2026-01-01', '2026-01-01', projectId, n, opts.doneAt ?? new Date().toISOString());
  planFeature(goalId, { epicId });
  const pilot = createPilotRow({ goalId, plannerAgentId: 'nobody', intake: { goal: 'x' } });
  if (opts.contract === false) return { goalId, pilotId: pilot.id };
  const tests = opts.tests ?? [];
  const checklist = opts.checklist ?? [];
  const criteria: Criterion[] = [
    ...tests.map(([id, command, verify]) => ({ id, text: `${id} holds`, expect: 'it does', verify, ...(verify === 'command' ? { command } : {}) })),
    ...checklist.map((c) => ({ id: c.id, text: `${c.id} reads well`, expect: '', verify: 'checklist' as const })),
  ];
  const c = createContract({ pilotId: pilot.id, goalId, criteria, repoPath: opts.repo ?? '/repo/app', agentType: 'claude' });
  const locked = tests.map(([criterionId, command, verify]) => {
    if (verify === 'command') return { criterionId, command, files: [] };
    const path = `acceptance/${goalId}-${criterionId}.test.mjs`;
    const content = `// ${criterionId}`;
    files.set(path, content);
    return { criterionId, command, files: [{ path, sha256: sha256(content), bytes: content.length, content }] };
  });
  updateContract(c.id, {
    status: 'locked', tests: locked,
    checklist: checklist.length ? {
      requestId: 'r', reviewerAgentId: 'rev', reviewerName: 'Reviewer', at: '2026-01-01', independent: true, confirmedAt: '2026-01-01',
      verdicts: checklist.filter((x) => x.verdict).map((x) => ({ criterionId: x.id, verdict: x.verdict!, evidence: 'looked at it closely' })),
      confirmations: Object.fromEntries(checklist.filter((x) => x.confirmed !== undefined).map((x) => [x.id, { accepted: x.confirmed!, note: '', at: '2026-01-01' }])),
    } : null,
  });
  return { goalId, pilotId: pilot.id };
}
async function runOf(epicId: string) {
  startEpicQa(epicId);
  await epicQaSettled();
  return latestEpicRun(epicId)!;
}

// ── 1. every check kind × outcome ────────────────────────────────────────────────

test('every check kind lands in the run, and each outcome decides the status', async () => {
  type Case = { kind: EpicCheckKind; build: (p: string, e: string, outcome: 'ok' | 'bad' | 'slow') => void };
  const cases: Case[] = [
    { kind: 'test', build: (p, e, o) => { feature(p, e, { tests: [['AC-1', `${o}:unit`, 'test']] }); } },
    { kind: 'command', build: (p, e, o) => { feature(p, e, { tests: [['AC-1', `${o}:cargo test`, 'command']] }); } },
    { kind: 'qa-command', build: (p, e, o) => { db.prepare('UPDATE epics SET qa_command = ? WHERE id = ?').run(`${o}:gate`, e); feature(p, e, { contract: false }); } },
    { kind: 'checklist', build: (p, e, o) => { feature(p, e, { checklist: [{ id: 'AC-9', confirmed: o === 'ok' }] }); } },
    { kind: 'tamper', build: (p, e, o) => {
      const f = feature(p, e, { tests: [['AC-1', 'ok:unit', 'test']] });
      if (o !== 'ok') { const path = getContract(f.pilotId)!.tests[0].files[0].path; o === 'bad' ? files.set(path, 'edited') : files.delete(path); }
    } },
  ];
  assert.deepEqual(cases.map((c) => c.kind).sort(), [...EPIC_CHECK_KINDS].sort(), 'a case for every check kind');
  for (const c of cases) {
    for (const outcome of ['ok', 'bad', 'slow'] as const) {
      if (c.kind === 'checklist' && outcome === 'slow') continue;   // a carried verdict has no timeout
      const p = project();
      const e = createEpic(p, { name: `${c.kind}-${outcome}` }).id;
      c.build(p, e, outcome);
      const run = await runOf(e);
      const expectKind = c.kind === 'tamper' && outcome === 'ok' ? 'test' : c.kind;
      assert.ok(run.checks.some((k) => k.kind === expectKind), `${c.kind}/${outcome}: a ${expectKind} check is recorded`);
      assert.equal(run.status, outcome === 'ok' ? 'passed' : 'failed', `${c.kind}/${outcome}`);
      if (c.kind !== 'checklist' && c.kind !== 'tamper') {
        assert.equal(run.checks[0].timedOut, outcome === 'slow', `${c.kind}/${outcome}: timeout recorded`);
      }
    }
  }
});

test('a tampered feature runs none of its tests; the other features still run', async () => {
  const p = project();
  const e = createEpic(p, { name: 'Tamper' }).id;
  const bad = feature(p, e, { tests: [['AC-1', 'ok:a', 'test'], ['AC-2', 'ok:b', 'test']] });
  feature(p, e, { tests: [['AC-1', 'ok:c', 'test']] });
  files.set(getContract(bad.pilotId)!.tests[0].files[0].path, 'edited');
  const run = await runOf(e);
  assert.deepEqual(ran, ['ok:c']);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.checks.map((c) => c.kind), ['tamper', 'test']);
});

test('the checklist is carried forward: confirmation wins, then an unconfirmed verdict, else never reviewed', async () => {
  const p = project();
  const e = createEpic(p, { name: 'Checklist' }).id;
  feature(p, e, { checklist: [
    { id: 'AC-1', confirmed: true, verdict: 'not-met' },   // the person overruled the reviewer: passes
    { id: 'AC-2', verdict: 'met' },                        // reviewer only: passes
    { id: 'AC-3', confirmed: false, verdict: 'met' },      // the person said not met: fails
    { id: 'AC-4' },                                        // never reviewed: fails
  ] });
  const run = await runOf(e);
  assert.deepEqual(run.checks.map((c) => [c.criterionId, c.passed]), [['AC-1', true], ['AC-2', true], ['AC-3', false], ['AC-4', false]]);
  assert.deepEqual(ran, [], 'nothing is executed for a checklist');
});

test('the QA command: the epic overrides the project, runs once, in the project repo', async () => {
  const p = project('/repo/app', 'ok:project-gate');
  const own = createEpic(p, { name: 'Own' }).id;
  const dflt = createEpic(p, { name: 'Default' }).id;
  db.prepare('UPDATE epics SET qa_command = ? WHERE id = ?').run('ok:phase-1-gate', own);
  feature(p, own, { contract: false });
  feature(p, dflt, { contract: false });
  assert.deepEqual((await runOf(own)).checks.map((c) => c.command), ['ok:phase-1-gate']);
  assert.deepEqual((await runOf(dflt)).checks.map((c) => c.command), ['ok:project-gate']);
});

test('nothing to run → no-tests; an unreachable repo → error', async () => {
  const p = project();
  const e = createEpic(p, { name: 'Bare' }).id;
  feature(p, e, { contract: false });
  assert.equal((await runOf(e)).status, 'no-tests');

  const q = project('/repo/down');
  const f = createEpic(q, { name: 'Down' }).id;
  feature(q, f, { tests: [['AC-1', 'ok:x', 'test']], repo: '/repo/down' });
  const run = await runOf(f);
  assert.equal(run.status, 'error');
  assert.match(run.error, /No runner/);
});

test('it refuses: not finished, no feature, already running, a busy repo', async () => {
  const p = project();
  const empty = createEpic(p, { name: 'Empty' }).id;
  assert.throws(() => startEpicQa(empty), /no feature/);

  const open = createEpic(p, { name: 'Open' }).id;
  feature(p, open, { contract: false });
  const g = `ea-g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, origin) VALUES (?,?,'','active',?,?,?,?,'planned')`)
    .run(g, 'Not done', '2026-01-01', '2026-01-01', p, n);
  planFeature(g, { epicId: open });
  assert.throws(() => startEpicQa(open), /not finished/);

  const e = createEpic(p, { name: 'Twice' }).id;
  feature(p, e, { tests: [['AC-1', 'ok:x', 'test']] });
  startEpicQa(e);
  assert.throws(() => startEpicQa(e), /already running/);
  await epicQaSettled();

  // A cartridge with a running step in the repo.
  const busy = createEpic(p, { name: 'Busy' }).id;
  feature(p, busy, { tests: [['AC-1', 'ok:x', 'test']] });
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, agent_type) VALUES ('ea-busy', 'box/app', 'box', '/repo/app', 'app', 'working', ?, 'claude')`).run(new Date().toISOString());
  db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES ('ea-wf', 'Build', 'running', ?)`).run(new Date().toISOString());
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, executor_type, executor_id, status, created_at, dispatch_agent_id) VALUES ('ea-st', 'ea-wf', 'Build', 'claude-code', 'ea-busy', 'running', ?, 'ea-busy')`).run(new Date().toISOString());
  try {
    assert.throws(() => startEpicQa(busy), /working in \/repo\/app/);
  } finally {
    db.prepare("UPDATE workflows SET status = 'completed' WHERE id = 'ea-wf'").run();
  }
});

// ── 2. every run status × Passed QA ──────────────────────────────────────────────

test('Passed QA: allowed only on passed / no-tests for the current finish; un-passing is never blocked', () => {
  const expected: Record<EpicRunStatus | 'none', boolean> = { none: false, running: false, passed: true, failed: false, error: false, 'no-tests': true };
  assert.deepEqual(Object.keys(expected).filter((k) => k !== 'none').sort(), [...EPIC_RUN_STATUSES].sort(), 'a case for every run status');
  for (const [status, allowed] of Object.entries(expected) as [EpicRunStatus | 'none', boolean][]) {
    const p = project();
    const e = createEpic(p, { name: `S-${status}` }).id;
    feature(p, e, { contract: false });
    if (status !== 'none') {
      const r = insertEpicRun(e, p, epicFinishedAt(e));
      if (status !== 'running') {
        const checks = status === 'failed'
          ? [{ kind: 'test' as const, goalId: '', feature: 'Login', criterionId: 'AC-1', text: '', command: 'x', passed: false, exitCode: 1, timedOut: false, output: '', durationMs: 1 }]
          : [];
        finishEpicRun(r.id, { status, checks, summary: '', error: status === 'error' ? 'no runner' : '' });
      }
    }
    if (allowed) {
      assert.doesNotThrow(() => setEpicQa(e, true), status);
      assert.equal(chartOf(p).epics.find((x) => x.id === e)!.qa, 'passed', status);
    } else {
      assert.throws(() => setEpicQa(e, true), (err: Error) => /Not yet: /.test(err.message), status);
      assert.ok(epicQaBlock(e), `${status}: a reason is given`);
      assert.equal(chartOf(p).epics.find((x) => x.id === e)!.qaRun?.blockedReason ?? epicQaBlock(e), epicQaBlock(e), `${status}: the chart carries the reason`);
    }
    assert.doesNotThrow(() => setEpicQa(e, false), `${status}: un-passing is never blocked`);
  }
});

test('a run for an earlier finish does not count: a feature done again needs a new run', async () => {
  const p = project();
  const e = createEpic(p, { name: 'Again' }).id;
  const f = feature(p, e, { tests: [['AC-1', 'ok:x', 'test']] });
  await runOf(e);
  assert.equal(currentEpicRun(e)!.status, 'passed');
  db.prepare('UPDATE goals SET done_at = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), f.goalId);
  assert.equal(currentEpicRun(e), null);
  assert.throws(() => setEpicQa(e, true), /has not run/);
});

test('the failing checks are named in the block, and carried on the roadmap epic', async () => {
  const p = project();
  const e = createEpic(p, { name: 'Red' }).id;
  feature(p, e, { tests: [['AC-1', 'ok:x', 'test'], ['AC-2', 'bad:y', 'test']] });
  await runOf(e);
  const epic = chartOf(p).epics.find((x) => x.id === e)!;
  assert.equal(epic.qaRun!.status, 'failed');
  assert.equal(epic.qaRun!.passing, 1);
  assert.equal(epic.qaRun!.total, 2);
  assert.deepEqual(epic.qaRun!.failing.map((f) => f.criterionId), ['AC-2']);
  assert.match(epic.qaRun!.blockedReason!, /QA failed: 1 of 2 passed — Feature \d+ AC-2/);
});

// ── 3. the sweep ──────────────────────────────────────────────────────────────────

test('the sweep: once per finish, not before epic QA existed, again after a new finish, never while busy or passed', async () => {
  const p = project();
  const old = createEpic(p, { name: 'Before' }).id;
  feature(p, old, { tests: [['AC-1', 'ok:old', 'test']], doneAt: '2020-01-01T00:00:00.000Z' });
  const e = createEpic(p, { name: 'Fresh' }).id;
  const f = feature(p, e, { tests: [['AC-1', 'ok:fresh', 'test']] });

  const first = sweepEpicQa();
  await epicQaSettled();
  assert.ok(first.includes(e), 'a freshly finished epic runs');
  assert.ok(!first.includes(old), 'an epic finished before epic QA existed does not run by itself');
  assert.ok(!sweepEpicQa().includes(e), 'not twice for the same finish');

  db.prepare('UPDATE goals SET done_at = ? WHERE id = ?').run(new Date(Date.now() + 120_000).toISOString(), f.goalId);
  assert.ok(sweepEpicQa().includes(e), 'a new finish runs again');
  await epicQaSettled();

  setEpicQa(e, true);
  db.prepare('UPDATE goals SET done_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), f.goalId);
  assert.ok(!sweepEpicQa().includes(e), 'a passed epic is not run');
});
