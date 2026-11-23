/**
 * THE ACCEPTANCE CONTRACT — criteria frozen at accept, failing tests written and LOCKED before any
 * work, NeonCore hashing and running them itself after every stage, only a person changing them.
 *
 * SCOPE (what "all" means here, derived from the code):
 *   · every VERIFY_METHOD is the default for the work types lib/acceptance-contract.ts says, and a
 *     test criterion without an exact expectation is refused at accept;             (7 work types)
 *   · every submission rule of the test writer (coverage, paths, commands, files that exist) is
 *     enforced with a message the agent can act on;
 *   · every contract state — drafting → review → locked, changes requested, amending, waived — is
 *     reached through the HTTP routes, with REAL files in a temp repo and REAL commands run by
 *     NeonCore (lib/repo-access.ts, local path);
 *   · every way a locked file can change after a stage (edited, deleted) is detected, stops the
 *     pipeline, and is resolved only by the person (restore / accept with a reason);
 *   · the runner path (agent/runner/repo-ops.js) obeys the same rules as the local one — the same
 *     cases run through both;
 *   · the report's status follows the criteria: SUCCESS only when every one passes on NeonCore's
 *     own evidence.
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
import { WORK_TYPES, getPilot, stagesOf } from '../src/lib/goal-pilot.ts';
import { advancePilot, stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';
import {
  VERIFY_METHODS, TESTABLE_WORK_TYPES, defaultVerify, normalizeCriteria, acceptedCriteria, normalizeTestsSubmission,
  findTampering, contractVerdict, contractBlock, getContract, MAX_CRITERIA, type CriterionState, type CriterionOutcome,
} from '../src/lib/acceptance-contract.ts';
import { settleAcceptanceForTests, pickReviewer } from '../src/lib/acceptance-runner.ts';
import {
  safeRelPath, resolveInRepo, runLocal, checkEnv, localRepoAccess, remoteRepoAccess, sha256, OUTPUT_MAX_CHARS,
  repoAccessFor, setMachineCall, RepoAccessError, setRepoAccessForTests,
} from '../src/lib/repo-access.ts';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { registerChannel, clearChannels, type Notice } from '../src/lib/channels.ts';
// @ts-expect-error — plain ESM from the runner, no type declarations
import * as runnerOps from '../../agent/runner/repo-ops.js';

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

const notices: Notice[] = [];
registerChannel({ name: 'collector', isConfigured: () => true, async send(x) { notices.push(x); return { ok: true, dropped: [] }; } });
const noticed = (pilotId: string, event: string) => notices.filter((x) => x.data?.pilotId === pilotId && x.data?.event === event);

const NODE = JSON.stringify(process.execPath);
let n = 0;

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-repo-'));
}

/** A cartridge on THIS machine (so NeonCore reaches its repo directly), connected. */
function cartridge(repo: string, opts: { type?: string; connected?: boolean; status?: string } = {}): string {
  const id = `ac-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `me/${path.basename(repo)}`, os.hostname(), repo, path.basename(repo), opts.status ?? 'idle', new Date().toISOString(), `s-${id}`, opts.type ?? 'claude');
  if (opts.connected !== false) io.connect(id);
  return id;
}
function lastPrompt(agentId: string): string {
  const hits = io.emissions.filter((e) => e.event === 'command_send' && e.room === `agent:${agentId}`);
  return String((hits[hits.length - 1]?.payload as { text?: string } | undefined)?.text ?? '');
}

const TWO_TESTS = [
  { text: 'When an owner saves an expense of 12.50, the system shall list it.', expect: 'save 12.50 → the list shows 12.50', verify: 'test' },
  { text: 'When expenses exist in March, the system shall total them.', expect: '12.50 + 7.25 in March → March total 19.75', verify: 'test' },
];

/** A pilot through planning, started in `repo` on a live cartridge — stage 0 requested. */
/** Hands-on unless said: these tests walk the person's own review of the tests. */
async function contractPilot(opts: { criteria?: unknown[]; templates?: string[]; workType?: string; repo?: string; agentType?: string; involvement?: string } = {}) {
  const repo = opts.repo ?? tmpRepo();
  const agent = cartridge(repo, { type: opts.agentType ?? 'claude' });
  const c = await post('/api/goal-pilots', {
    intake: { goal: `Expenses ${++n}`, context: 'c', workType: opts.workType ?? 'feature', done: 'd', involvement: opts.involvement ?? 'hands-on' }, plannerAgentId: agent,
  });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const pilotId = c.json.pilot.id as string;
  const rid = () => getPilot(pilotId)!.currentRequestId;
  let r = await post(`/api/goal-pilots/requests/${rid()}/submit`, { result: { status: 'complete', brief: { summary: 'Expenses next to income.' }, criteria: opts.criteria ?? TWO_TESTS } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await post(`/api/goal-pilots/requests/${rid()}/submit`, { result: { stages: (opts.templates ?? ['Feature Validation', 'Release Documentation']).map((template) => ({ template, title: `Do ${template}` })) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await post(`/api/goal-pilots/${pilotId}/accept-plan`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: opts.agentType ?? 'claude' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { pilotId, agent, repo, goalId: c.json.goalId as string };
}

/** What a test writer puts in the repo: a check that passes only when feature.json holds the expected value. */
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
/** What the "implementation" does: record the behaviour the test expects. */
function implement(repo: string, id: string, value: string) {
  const f = path.join(repo, 'feature.json');
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  cur[id] = value;
  fs.writeFileSync(f, JSON.stringify(cur));
}

const stage = (pilotId: string, kind: string, i = 0) => stagesOf(pilotId).filter((s) => s.kind === kind)[i];
function finishRun(runId: string) {
  const t = new Date().toISOString();
  db.prepare(`UPDATE workflow_steps SET status = 'completed', result = 'Done: the step', completed_at = ? WHERE workflow_id = ?`).run(t, runId);
  db.prepare(`UPDATE workflows SET status = 'completed', completed_at = ? WHERE id = ?`).run(t, runId);
}
async function writeAndLock(pilotId: string, repo: string) {
  const tests = [writeTest(repo, 'AC-1', 'save 12.50 → the list shows 12.50'), writeTest(repo, 'AC-2', 'March total 19.75')];
  const sub = await post(`/api/goal-pilots/requests/${getContract(pilotId)!.requestId}/submit`, { result: { tests } });
  assert.equal(sub.status, 200, JSON.stringify(sub.json));
  const ok = await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  await settleAcceptanceForTests();
  assert.equal(getContract(pilotId)!.status, 'locked');
  return tests;
}

// ── the rules, as pure functions ────────────────────────────────────────────────

test('criteria: every work type defaults to the verify method its kind of result calls for', () => {
  assert.deepEqual(VERIFY_METHODS.map((m) => m.value).sort(), ['checklist', 'command', 'test']);
  for (const w of WORK_TYPES) {
    assert.equal(defaultVerify(w.value), TESTABLE_WORK_TYPES.has(w.value) ? 'test' : 'checklist', w.value);
    const [c] = normalizeCriteria(['When x, the system shall y.'], { workType: w.value });
    assert.equal(c.verify, defaultVerify(w.value));
  }
  assert.ok(TESTABLE_WORK_TYPES.has('feature') && !TESTABLE_WORK_TYPES.has('research') && !TESTABLE_WORK_TYPES.has('docs'));
});

test('criteria: numbered by position, deduplicated, capped — and every repair is a note', () => {
  const notes: string[] = [];
  const out = normalizeCriteria([
    { id: 'AC-9', text: 'A', expect: 'a → 1', verify: 'test' }, 'B', { text: 'a' }, { text: '' }, 7, { text: 'C', verify: 'maybe' },
  ], { workType: 'feature' }, notes);
  assert.deepEqual(out.map((c) => [c.id, c.text, c.verify]), [['AC-1', 'A', 'test'], ['AC-2', 'B', 'test'], ['AC-3', 'C', 'test']]);
  for (const frag of ['twice', 'no text', 'not an object', 'not test, command or checklist']) assert.ok(notes.some((x) => x.includes(frag)), `no note: ${frag}`);
  const many = normalizeCriteria(Array.from({ length: MAX_CRITERIA + 3 }, (_, i) => `C${i}`), {}, notes);
  assert.equal(many.length, MAX_CRITERIA);
  const fromLines = normalizeCriteria(undefined, { fallback: '- AC-1: When a, b.\n- When c, d.', workType: 'docs' }, notes);
  assert.deepEqual(fromLines.map((c) => [c.id, c.text, c.verify, c.expect]), [['AC-1', 'When a, b.', 'checklist', ''], ['AC-2', 'When c, d.', 'checklist', '']]);
});

test('accept: a criterion checked by a test must say EXACTLY what it expects; a checklist item need not', () => {
  assert.match(acceptedCriteria([{ text: 'x', verify: 'test' }], 'feature').error, /AC-1 is checked by a test but says nothing about the expected result/);
  assert.equal(acceptedCriteria([{ text: 'x', verify: 'checklist' }], 'feature').error, '');
  assert.equal(acceptedCriteria([{ text: 'x', expect: 'a → b', verify: 'test' }], 'feature').error, '');
  assert.match(acceptedCriteria([{ text: '' }], 'feature').error, /every criterion needs its text/);
});

test('the test writer\'s submission: every criterion covered, paths inside the repo, one-line commands', () => {
  const wanted = normalizeCriteria(TWO_TESTS, { workType: 'feature' });
  const cases: [unknown, RegExp][] = [
    [{ tests: [{ criterionId: 'AC-1', files: ['t.mjs'], command: 'node t.mjs' }] }, /no test for AC-2/],
    [{ tests: [{ criterionId: 'AC-1', files: ['../escape.mjs'], command: 'x' }, { criterionId: 'AC-2', files: ['b'], command: 'y' }] }, /not a path inside the repo/],
    [{ tests: [{ criterionId: 'AC-1', files: ['/etc/passwd'], command: 'x' }, { criterionId: 'AC-2', files: ['b'], command: 'y' }] }, /not a path inside the repo/],
    [{ tests: [{ criterionId: 'AC-1', files: ['a'], command: 'x\nrm -rf /' }, { criterionId: 'AC-2', files: ['b'], command: 'y' }] }, /must be one line/],
    [{ tests: [{ criterionId: 'AC-1', files: [], command: 'x' }, { criterionId: 'AC-2', files: ['b'], command: 'y' }] }, /names no test file/],
    [{ tests: [{ criterionId: 'AC-1', files: ['a'], command: '' }, { criterionId: 'AC-2', files: ['b'], command: 'y' }] }, /has no command/],
    [{ tests: [{ criterionId: 'AC-1', files: ['a'], command: 'x' }, { criterionId: 'AC-1', files: ['c'], command: 'z' }, { criterionId: 'AC-2', files: ['b'], command: 'y' }] }, /has two tests/],
    ['nope', /not an object/],
  ];
  for (const [raw, re] of cases) {
    const out = normalizeTestsSubmission(raw, wanted);
    assert.equal(out.value, null, `accepted: ${JSON.stringify(raw)}`);
    assert.ok(out.errors.some((e) => re.test(e)), `${re} not in ${out.errors.join(' | ')}`);
  }
  const ok = normalizeTestsSubmission({ tests: [{ criterionId: 'ac-2', files: ['./b.mjs', 'b.mjs'], command: 'y' }, { criterionId: 'AC-1', files: ['a\\c.mjs'], command: 'x' }, { criterionId: 'AC-7', files: ['z'], command: 'z' }] }, wanted);
  assert.deepEqual(ok.value!.tests.map((t) => [t.criterionId, t.files]), [['AC-1', ['a/c.mjs']], ['AC-2', ['b.mjs']]], 'sorted, normalized, deduplicated');
  assert.ok(ok.notes.some((x) => /AC-7/.test(x)), 'a test for a criterion nobody asked for is dropped with a note');
});

test('tampering: an edited file and a deleted file are both found; an untouched one is not', () => {
  const tests = [
    { criterionId: 'AC-1', command: 'x', files: [{ path: 'a', sha256: sha256('A'), bytes: 1, content: 'A' }, { path: 'shared', sha256: sha256('S'), bytes: 1, content: 'S' }] },
    { criterionId: 'AC-2', command: 'y', files: [{ path: 'b', sha256: sha256('B'), bytes: 1, content: 'B' }, { path: 'shared', sha256: sha256('S'), bytes: 1, content: 'S' }] },
  ];
  const found = findTampering(tests, [
    { path: 'a', exists: true, sha256: sha256('A changed') }, { path: 'b', exists: false, sha256: '' }, { path: 'shared', exists: true, sha256: sha256('S') },
  ]);
  assert.deepEqual(found.map((f) => [f.path, f.criterionId, f.actual === null]), [['a', 'AC-1', false], ['b', 'AC-2', true]]);
});

test('the verdict: SUCCESS only when every criterion passes; nothing judged is INCOMPLETE', () => {
  const st = (outcome: CriterionOutcome) => ({ outcome } as CriterionState);
  const passing: CriterionOutcome[] = ['pass', 'met'];
  const failing: CriterionOutcome[] = ['fail', 'not-met'];
  const unjudged: CriterionOutcome[] = ['not-run', 'not-checked', 'unconfirmed', 'waived'];
  for (const p of passing) assert.equal(contractVerdict([st(p), st('pass')]), 'SUCCESS');
  for (const f of failing) {
    assert.equal(contractVerdict([st('pass'), st(f)]), 'PARTIAL');
    assert.equal(contractVerdict([st(f)]), 'FAILED');
  }
  for (const u of unjudged) {
    assert.equal(contractVerdict([st(u)]), 'INCOMPLETE', u);
    assert.equal(contractVerdict([st('pass'), st(u)]), 'PARTIAL', `${u} next to a pass`);
  }
  assert.equal(contractVerdict([]), 'INCOMPLETE');
});

// ── repo access: one set of rules, two implementations ──────────────────────────

test('repo access: the server and the runner agree on every path rule', () => {
  const cases: [string, string | null][] = [
    ['a/b.mjs', 'a/b.mjs'], ['./a//b.mjs', 'a/b.mjs'], ['a\\b.mjs', 'a/b.mjs'], ['../x', null], ['a/../../x', null],
    ['/etc/passwd', null], ['C:/x', null], ['', null], ['.', null], ['a/./b', 'a/b'],
  ];
  for (const [input, want] of cases) {
    assert.equal(safeRelPath(input), want, `server: ${input}`);
    assert.equal(runnerOps.safeRelPath(input), want, `runner: ${input}`);
  }
  const repo = tmpRepo();
  const outside = tmpRepo();
  fs.symlinkSync(outside, path.join(repo, 'link'));
  for (const impl of [resolveInRepo, runnerOps.resolveInRepo]) {
    assert.equal(impl(repo, 'link/secret'), null, 'a symlinked directory must not lead out of the repo');
    assert.equal(impl(repo, 'sub/ok.txt'), path.join(repo, 'sub', 'ok.txt'));
  }
  const env = checkEnv({ NEONCORE_AUTH_TOKEN: 'secret', neoncore_x: 'y', PATH: '/bin', NODE_TEST_CONTEXT: 'child' });
  const renv = runnerOps.checkEnv({ NEONCORE_AUTH_TOKEN: 'secret', neoncore_x: 'y', PATH: '/bin', NODE_TEST_CONTEXT: 'child' });
  for (const e of [env, renv]) assert.deepEqual(e, { PATH: '/bin', CI: '1' }, 'tokens never reach a test command');
});

test('repo access: a command\'s exit code, its output tail, and a timeout that kills it', async () => {
  const repo = tmpRepo();
  for (const run of [(c: string, t?: number) => runLocal(repo, c, t), (c: string, t?: number) => runnerOps.runRepoCommand(repo, c, t)]) {
    const ok = await run(`${NODE} -e "console.log('hi')"`);
    assert.deepEqual([ok.exitCode, ok.output, ok.timedOut], [0, 'hi', false]);
    const bad = await run(`${NODE} -e "process.exit(3)"`);
    assert.equal(bad.exitCode, 3);
    const loud = await run(`${NODE} -e "process.stdout.write('x'.repeat(50000) + 'END')"`);
    assert.ok(loud.output.length <= OUTPUT_MAX_CHARS && loud.output.endsWith('END'), 'the tail is kept');
    const slow = await run(`${NODE} -e "setTimeout(() => {}, 60000)"`, 1000);
    assert.equal(slow.timedOut, true);
    assert.equal(slow.exitCode, null);
    assert.ok(slow.durationMs < 10_000);
  }
});

test('repo access through a machine\'s runner: only its exposed repos, same reads/writes/runs as local', async () => {
  const repo = tmpRepo();
  const other = tmpRepo();
  fs.writeFileSync(path.join(repo, 't.txt'), 'hello');
  // The server side talks to a runner; the runner side is the real handler, as the socket would reach it.
  const runner = (_machine: string, req: unknown) => runnerOps.handleRepoOp(req, { repos: [{ path: repo, name: 'r' }] });
  const remote = remoteRepoAccess('m1', 'studio (runner)', repo, runner);
  const local = localRepoAccess(repo);
  for (const a of [remote, local]) {
    const [r] = await a.readFiles(['t.txt']);
    assert.deepEqual([r.exists, r.content, r.sha256], [true, 'hello', sha256('hello')]);
    const [missing] = await a.readFiles(['nope.txt']);
    assert.equal(missing.exists, false);
    await a.writeFile('w/out.txt', `by ${a.where}`);
    assert.equal(fs.readFileSync(path.join(repo, 'w', 'out.txt'), 'utf8'), `by ${a.where}`);
    const run = await a.run(`${NODE} -e "process.exit(require('fs').existsSync('t.txt') ? 0 : 1)"`, 5000);
    assert.equal(run.exitCode, 0, 'commands run in the repo');
    await assert.rejects(a.writeFile('../escape.txt', 'x'), /not a path inside the repo/);
  }
  const elsewhere = remoteRepoAccess('m1', 'studio (runner)', other, runner);
  await assert.rejects(elsewhere.readFiles(['x']), /not one of this machine's exposed repos/);
  const offline = remoteRepoAccess('m2', 'laptop (runner)', repo, async () => ({ ok: false, error: 'its runner is not connected' }));
  await assert.rejects(offline.run('true'), /laptop \(runner\): its runner is not connected/);
});

test('which way a repo is reached: its cartridge\'s machine decides — local here, the runner elsewhere, a clear error when none is connected', async () => {
  const here = tmpRepo();
  cartridge(here);
  assert.equal(repoAccessFor(here).where, 'local');

  const away = '/Users/someone/elsewhere-repo';
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type) VALUES ('ac-away', 'x', 'Studio-Mac.local', ?, 'elsewhere-repo', 'idle', ?, 's-away', 'claude')`)
    .run(away, new Date().toISOString());
  setMachineCall(null);
  assert.throws(() => repoAccessFor(away), (e: unknown) => e instanceof RepoAccessError && /elsewhere-repo is on Studio-Mac, which has no NeonCore runner connected/.test((e as Error).message));

  db.prepare(`INSERT INTO machines (id, hostname, platform, arch, repos, status, last_seen, created_at) VALUES ('mach-studio', 'Studio-Mac', 'darwin', 'arm64', ?, 'online', ?, ?)`)
    .run(JSON.stringify([{ path: away, name: 'elsewhere-repo' }]), new Date().toISOString(), new Date().toISOString());
  const calls: unknown[] = [];
  setMachineCall(async (machineId, req) => { calls.push([machineId, (req as { op: string }).op]); return { ok: true, files: [] }; });
  const a = repoAccessFor(away);
  assert.equal(a.where, 'remote');
  await a.readFiles(['x']);
  assert.deepEqual(calls, [['mach-studio', 'read']]);

  // The sandbox check forces the runner path for a local repo, to exercise it end to end.
  db.prepare(`INSERT INTO machines (id, hostname, platform, arch, repos, status, last_seen, created_at) VALUES ('mach-here', ?, 'linux', 'x64', ?, 'online', ?, ?)`)
    .run(os.hostname(), JSON.stringify([{ path: here, name: 'here' }]), new Date().toISOString(), new Date().toISOString());
  process.env.NEONCORE_REPO_ACCESS = 'runner';
  try {
    assert.equal(repoAccessFor(here).where, 'remote');
  } finally {
    delete process.env.NEONCORE_REPO_ACCESS;
    setMachineCall(null);
  }
});

// ── the whole contract, through the routes ──────────────────────────────────────

test('stage 0 → tests submitted (real files, hashed) → reviewed → red baseline → locked → checked after every stage → SUCCESS', async () => {
  const { pilotId, agent, repo } = await contractPilot();
  // Stage 0 first, then the workflows; no checklist criterion → no review stage.
  assert.deepEqual(stagesOf(pilotId).map((s) => `${s.kind}:${s.status}`), ['acceptance:running', 'workflow:pending', 'workflow:pending']);
  const prompt = lastPrompt(agent);
  assert.match(prompt, /\[NeonCore goal pilot · tests request /);
  for (const needle of ['AC-1: When an owner saves', 'expected: 12.50 + 7.25 in March → March total 19.75', 'must FAIL right now', 'Do NOT implement anything']) {
    assert.ok(prompt.includes(needle), `the tests request lacks "${needle}"`);
  }
  assert.ok(!prompt.includes('[NeonCore work standard'), 'a tests request is not a work-standard task');

  // Workflow stages may not start against tests nobody approved.
  advancePilot(pilotId);
  assert.equal(stage(pilotId, 'workflow').runId, '');

  // A submission naming a file that is not there is refused, with the list.
  const rid = getContract(pilotId)!.requestId;
  const missing = await post(`/api/goal-pilots/requests/${rid}/submit`, { result: { tests: [
    { criterionId: 'AC-1', files: ['acceptance/ac-1.check.mjs'], command: 'x' }, { criterionId: 'AC-2', files: ['acceptance/ac-2.check.mjs'], command: 'y' },
  ] } });
  assert.equal(missing.status, 422);
  assert.match(missing.json.error, /do not exist in .*acceptance\/ac-1\.check\.mjs, acceptance\/ac-2\.check\.mjs/);

  const tests = [writeTest(repo, 'AC-1', 'save 12.50 → the list shows 12.50'), writeTest(repo, 'AC-2', 'March total 19.75')];
  const sub = await post(`/api/goal-pilots/requests/${rid}/submit`, { result: { tests, notes: 'both assert feature.json' } });
  assert.equal(sub.status, 200, JSON.stringify(sub.json));
  let c = getContract(pilotId)!;
  assert.equal(c.status, 'review');
  assert.equal(stage(pilotId, 'acceptance').status, 'review');
  assert.equal(c.draftTests[0].files[0].sha256, sha256(fs.readFileSync(path.join(repo, tests[0].files[0]), 'utf8')), 'NeonCore hashed what is on disk');
  assert.equal(noticed(pilotId, 'tests-ready').length, 1, 'the person is told there is something to review');
  assert.equal((await post(`/api/goal-pilots/requests/${rid}/submit`, { result: { tests } })).status, 409, 'answered once');

  // "Run them now": both red, as they should be before any work.
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/run`)).status, 202);
  await settleAcceptanceForTests();
  c = getContract(pilotId)!;
  assert.deepEqual(c.baseline!.results.map((r) => [r.criterionId, r.passed, r.exitCode]), [['AC-1', false, 1], ['AC-2', false, 1]]);
  assert.match(c.baseline!.results[0].output, /AC-1: expected/);

  // Approve & lock: the fresh red baseline locks at once.
  const approved = await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  c = getContract(pilotId)!;
  assert.deepEqual([c.status, c.version, c.tests.length, c.draftTests.length], ['locked', 1, 2, 0]);
  assert.equal(stage(pilotId, 'acceptance').status, 'completed');
  assert.match(stage(pilotId, 'acceptance').resultSummary, /2\/2 failing, as they should/);
  const run1 = stage(pilotId, 'workflow', 0).runId;
  assert.ok(run1, 'the first workflow starts once the contract is locked');
  const ctx = String((db.prepare('SELECT initial_context FROM workflows WHERE id = ?').get(run1) as { initial_context: string }).initial_context);
  assert.match(ctx, /## Acceptance contract\n2 acceptance tests were written before any work and LOCKED/);

  // Every prompt for this goal carries the locked contract — files and commands.
  const cmd = sendCommandToAgent(agent, 'Implement the expense list', false, undefined, { goalId: getPilot(pilotId)!.goalId });
  assert.ok(cmd);
  const sent = lastPrompt(agent);
  assert.match(sent, /\[NeonCore acceptance contract v1 — LOCKED by the person\]/);
  assert.ok(sent.includes(`- AC-1 (test): When an owner saves an expense of 12.50, the system shall list it. → \`${tests[0].command}\` [acceptance/ac-1.check.mjs]`), sent);

  // Stage 1 ends with nothing built: NeonCore checks, records 0/2, and moves on.
  finishRun(run1);
  advancePilot(pilotId);
  assert.equal(stage(pilotId, 'workflow', 0).status, 'verifying');
  await settleAcceptanceForTests();
  assert.equal(stage(pilotId, 'workflow', 0).status, 'completed');
  assert.match(stage(pilotId, 'workflow', 0).resultSummary, /0\/2 criteria passing — not yet: AC-1, AC-2\. Locked test files unchanged/);
  const run2 = stage(pilotId, 'workflow', 1).runId;
  assert.ok(run2, 'stage 2 started after the check');

  // Stage 2 builds both → 2/2 → the pipeline completes → SUCCESS on NeonCore's own evidence.
  implement(repo, 'AC-1', 'save 12.50 → the list shows 12.50');
  implement(repo, 'AC-2', 'March total 19.75');
  finishRun(run2);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  assert.equal(getPilot(pilotId)!.phase, 'completed');
  const report = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.equal(report.status, 'SUCCESS');
  assert.deepEqual(report.acceptance.criteria.map((x: { id: string; outcome: string; exitCode: number }) => [x.id, x.outcome, x.exitCode]), [['AC-1', 'pass', 0], ['AC-2', 'pass', 0]]);
  assert.deepEqual([report.acceptance.checks, report.acceptance.testsUnchanged], [2, true]);
  assert.equal(report.acceptance.criteria[0].baseline.passed, false, 'the red baseline is part of the evidence');
  const view = (await call('GET', `/api/goal-pilots/${pilotId}`)).json;
  assert.deepEqual([view.acceptance.passing, view.acceptance.total], [2, 2]);
});

test('a test that already passes before any work blocks the lock — unless the person approves anyway', async () => {
  const { pilotId, repo } = await contractPilot();
  implement(repo, 'AC-1', 'already there');
  const tests = [writeTest(repo, 'AC-1', 'already there'), writeTest(repo, 'AC-2', 'March total 19.75')];
  await post(`/api/goal-pilots/requests/${getContract(pilotId)!.requestId}/submit`, { result: { tests } });
  await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, {});
  await settleAcceptanceForTests();
  let c = getContract(pilotId)!;
  assert.equal(c.status, 'review', 'not locked');
  assert.match(c.approval!.blocked, /AC-1 already passes before any work/);
  assert.equal(noticed(pilotId, 'approval-blocked').length, 1);
  const forced = await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, { confirmPassing: true });
  assert.equal(forced.status, 200);
  c = getContract(pilotId)!;
  assert.equal(c.status, 'locked');
});

test('an approval whose deciding run was lost (a restart) is picked up again by the sweep', async () => {
  const { pilotId, repo } = await contractPilot();
  const tests = [writeTest(repo, 'AC-1', 'x'), writeTest(repo, 'AC-2', 'y')];
  await post(`/api/goal-pilots/requests/${getContract(pilotId)!.requestId}/submit`, { result: { tests } });
  // What a restart leaves behind: the person's approval, and no run in flight.
  db.prepare(`UPDATE acceptance_contracts SET approval = ? WHERE pilot_id = ?`)
    .run(JSON.stringify({ requestedAt: new Date().toISOString(), confirmPassing: false, blocked: '' }), pilotId);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  assert.equal(getContract(pilotId)!.status, 'locked');
  assert.ok(stage(pilotId, 'workflow').runId, 'and the pipeline moved on');
});

test('a repo NeonCore cannot reach: approving says why instead of waiting forever', async () => {
  const { pilotId, repo } = await contractPilot();
  const tests = [writeTest(repo, 'AC-1', 'x'), writeTest(repo, 'AC-2', 'y')];
  await post(`/api/goal-pilots/requests/${getContract(pilotId)!.requestId}/submit`, { result: { tests } });
  setRepoAccessForTests(() => { throw new RepoAccessError('repo is on Studio-Mac, which has no NeonCore runner connected'); });
  try {
    const r = await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = getContract(pilotId)!;
    assert.equal(c.status, 'review');
    assert.match(c.approval!.blocked, /could not be run: repo is on Studio-Mac/);
    advancePilot(pilotId);                                   // the sweep does not retry it in a loop
    assert.match(getContract(pilotId)!.approval!.blocked, /Studio-Mac/);
  } finally {
    setRepoAccessForTests(null);
  }
  // Reachable again: "Run them again", then approve.
  await post(`/api/goal-pilots/${pilotId}/acceptance/run`);
  await settleAcceptanceForTests();
  await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, {});
  await settleAcceptanceForTests();
  assert.equal(getContract(pilotId)!.status, 'locked');
});

test('"ask for changes" sends the person\'s words back to the test writer, and is recorded', async () => {
  const { pilotId, agent, repo } = await contractPilot();
  const tests = [writeTest(repo, 'AC-1', 'x'), writeTest(repo, 'AC-2', 'y')];
  const first = getContract(pilotId)!.requestId;
  await post(`/api/goal-pilots/requests/${first}/submit`, { result: { tests } });
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/changes`, { feedback: '' })).status, 400, 'feedback is required');
  const asked = await post(`/api/goal-pilots/${pilotId}/acceptance/changes`, { feedback: 'AC-2 must also check April is excluded' });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const c = getContract(pilotId)!;
  assert.equal(c.status, 'drafting');
  assert.notEqual(c.requestId, first, 'a new request went out');
  assert.equal(stage(pilotId, 'acceptance').status, 'running');
  assert.match(lastPrompt(agent), /ASKED FOR CHANGES: AC-2 must also check April is excluded/);
  assert.deepEqual(c.amendments.map((a) => a.kind), ['changes-requested']);
});

test('only a person changes a locked test: an edit during a stage stops the pipeline; restore puts it back', async () => {
  const { pilotId, repo } = await contractPilot();
  const tests = await writeAndLock(pilotId, repo);
  const approved = fs.readFileSync(path.join(repo, tests[1].files[0]), 'utf8');

  // The stage "makes the test pass" by weakening it.
  fs.writeFileSync(path.join(repo, tests[1].files[0]), 'process.exit(0)');
  finishRun(stage(pilotId, 'workflow').runId);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  let s = stage(pilotId, 'workflow');
  assert.deepEqual([s.status, s.verifyState], ['verifying', 'tampered']);
  let pilot = getPilot(pilotId)!;
  assert.equal(pilot.phase, 'paused');
  assert.match(pilot.attention, /changed locked acceptance tests: acceptance\/ac-2\.check\.mjs \(AC-2\)/);
  assert.equal(noticed(pilotId, 'tests-tampered').length, 1);
  assert.equal(getContract(pilotId)!.tamper!.files[0].path, 'acceptance/ac-2.check.mjs');

  // Nothing moves until the person decides.
  assert.equal((await post(`/api/goal-pilots/${pilotId}/resume`)).status, 409);
  assert.equal((await post(`/api/goal-pilots/${pilotId}/stages/${s.id}/skip`)).status, 409);
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/accept-change`, { reason: '' })).status, 400, 'accepting needs a reason');

  const restored = await post(`/api/goal-pilots/${pilotId}/acceptance/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(fs.readFileSync(path.join(repo, tests[1].files[0]), 'utf8'), approved, 'the approved content is back on disk');
  await settleAcceptanceForTests();
  s = stage(pilotId, 'workflow');
  assert.equal(s.status, 'completed', 'checked again, and the pipeline moves on');
  pilot = getPilot(pilotId)!;
  assert.equal(pilot.phase, 'running');
  const c = getContract(pilotId)!;
  assert.equal(c.tamper, null);
  assert.equal(c.version, 1, 'a restore does not change the contract');
  assert.deepEqual(c.amendments.map((a) => a.kind), ['restore']);
});

test('accepting a changed test makes it the locked version (v+1) with the reason; a deleted one cannot be accepted', async () => {
  const { pilotId, repo } = await contractPilot();
  const tests = await writeAndLock(pilotId, repo);
  fs.unlinkSync(path.join(repo, tests[0].files[0]));
  finishRun(stage(pilotId, 'workflow').runId);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  assert.equal(stage(pilotId, 'workflow').verifyState, 'tampered');
  const refused = await post(`/api/goal-pilots/${pilotId}/acceptance/accept-change`, { reason: 'the agent knew better' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /deleted — restore the approved version, or unlock/);
  await post(`/api/goal-pilots/${pilotId}/acceptance/restore`);
  await settleAcceptanceForTests();

  // Next stage edits AC-1's test; the person accepts it.
  const edited = `${fs.readFileSync(path.join(repo, tests[0].files[0]), 'utf8')}\n// also covers the empty list`;
  fs.writeFileSync(path.join(repo, tests[0].files[0]), edited);
  finishRun(stage(pilotId, 'workflow', 1).runId);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  assert.equal(stage(pilotId, 'workflow', 1).verifyState, 'tampered');
  const ok = await post(`/api/goal-pilots/${pilotId}/acceptance/accept-change`, { reason: 'The extra case is right; keep it.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  await settleAcceptanceForTests();
  const c = getContract(pilotId)!;
  assert.equal(c.version, 2);
  assert.equal(c.tests[0].files[0].sha256, sha256(edited));
  assert.equal(getPilot(pilotId)!.phase, 'completed');
  const report = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.equal(report.acceptance.testsUnchanged, false);
  assert.deepEqual(report.acceptance.tamperEvents.map((t: { resolution: string }) => t.resolution), ['restored', 'accepted']);
  assert.deepEqual(report.acceptance.amendments.map((a: { kind: string }) => a.kind), ['restore', 'accept-change']);
  assert.equal(report.status, 'FAILED', 'nothing was implemented, so no criterion passes');
});

test('unlocking a criterion: a reason, new wording, a test rewritten for it alone, work waits, re-approved as v2', async () => {
  const { pilotId, agent, repo, goalId } = await contractPilot();
  await writeAndLock(pilotId, repo);
  assert.equal((await post(`/api/goal-pilots/${pilotId}/acceptance/criteria/AC-2/unlock`, { reason: '' })).status, 400);
  const unlocked = await post(`/api/goal-pilots/${pilotId}/acceptance/criteria/AC-2/unlock`, { reason: 'Totals exclude refunds — we forgot', expect: '12.50 + 7.25 − 2.00 refund → 17.75' });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.json));
  let c = getContract(pilotId)!;
  assert.equal(c.status, 'drafting');
  assert.deepEqual(c.amending, { criterionIds: ['AC-2'], reason: 'Totals exclude refunds — we forgot' });
  assert.equal(c.criteria[1].expect, '12.50 + 7.25 − 2.00 refund → 17.75');
  assert.match(String((db.prepare('SELECT acceptance_criteria FROM goals WHERE id = ?').get(goalId) as { acceptance_criteria: string }).acceptance_criteria), /17\.75/, 'the goal brief follows the contract');
  const prompt = lastPrompt(agent);
  assert.match(prompt, /THE PERSON UNLOCKED AC-2 — reason: Totals exclude refunds/);
  assert.match(prompt, /WRITE ONE TEST FOR EACH OF THESE 1 CRITERIA:\n- AC-2/);
  assert.match(prompt, /THESE TESTS ARE LOCKED — do not modify them:\n- AC-1: acceptance\/ac-1\.check\.mjs/);

  // The running stage finishes while the amendment is open: its check waits for the new lock.
  finishRun(stage(pilotId, 'workflow').runId);
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  assert.equal(stage(pilotId, 'workflow').status, 'verifying');
  assert.match(stage(pilotId, 'workflow').waitReason, /amended acceptance tests to be approved/);

  const t2 = writeTest(repo, 'AC-2', '17.75');
  const sub = await post(`/api/goal-pilots/requests/${getContract(pilotId)!.requestId}/submit`, { result: { tests: [t2] } });
  assert.equal(sub.status, 200, JSON.stringify(sub.json));
  c = getContract(pilotId)!;
  assert.deepEqual(c.draftTests.map((t) => t.criterionId), ['AC-1', 'AC-2'], 'the amendment replaces AC-2 only');
  await post(`/api/goal-pilots/${pilotId}/acceptance/approve`, {});
  await settleAcceptanceForTests();
  advancePilot(pilotId);
  await settleAcceptanceForTests();
  c = getContract(pilotId)!;
  assert.deepEqual([c.status, c.version, c.amending], ['locked', 2, null]);
  assert.equal(stage(pilotId, 'workflow').status, 'completed', 'the waiting check ran against v2');
  const unlock = c.amendments.find((a) => a.kind === 'unlock')!;
  assert.deepEqual([unlock.version, unlock.before!.expect, unlock.after!.expect], [2, TWO_TESTS[1].expect, '12.50 + 7.25 − 2.00 refund → 17.75']);
});

test('skipping stage 0 runs the pipeline without tests — and the report says the criteria were never checked', async () => {
  const { pilotId } = await contractPilot({ templates: ['Feature Validation'] });
  const skipped = await post(`/api/goal-pilots/${pilotId}/stages/${stage(pilotId, 'acceptance').id}/skip`);
  assert.equal(skipped.status, 200, JSON.stringify(skipped.json));
  assert.equal(getContract(pilotId)!.status, 'waived');
  const run = stage(pilotId, 'workflow').runId;
  assert.ok(run);
  finishRun(run);
  advancePilot(pilotId);
  assert.equal(stage(pilotId, 'workflow').status, 'completed', 'nothing to check');
  const report = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.equal(report.status, 'INCOMPLETE');
  assert.match(report.acceptance.note, /skipped writing the acceptance tests/);
  assert.deepEqual(report.acceptance.criteria.map((x: { outcome: string }) => x.outcome), ['waived', 'waived']);
});

test('stage 0 waits for its cartridge, and a test writer that goes quiet fails the stage — retry asks again', async () => {
  const repo = tmpRepo();
  const { pilotId } = await contractPilot({ repo, agentType: 'codex', templates: ['Feature Validation'] });
  // The planner was claude in this repo; the codex cartridge is the one that is running.
  let s0 = stage(pilotId, 'acceptance');
  assert.equal(s0.status, 'running');
  const agentId = s0.agentId;
  db.prepare(`UPDATE goal_pilot_requests SET dispatched_at = ? WHERE id = ?`).run(new Date(Date.now() - 10 * 60_000).toISOString(), getContract(pilotId)!.requestId);
  // Its turn ended (routes/agents.ts turnEnded) after the request arrived, and nothing followed.
  db.prepare(`UPDATE agents SET status = 'idle', turn_ended_at = ? WHERE id = ?`).run(new Date(Date.now() - 9 * 60_000).toISOString(), agentId);
  db.prepare(`UPDATE activity SET timestamp = ? WHERE agent_id = ?`).run(new Date(Date.now() - 10 * 60_000).toISOString(), agentId);
  advancePilot(pilotId);
  s0 = stage(pilotId, 'acceptance');
  assert.equal(s0.status, 'failed');
  assert.match(s0.resultSummary, /finished without submitting the tests/);
  assert.equal(getPilot(pilotId)!.phase, 'paused');

  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  db.pragma('foreign_keys = ON');
  const retried = await post(`/api/goal-pilots/${pilotId}/stages/${s0.id}/retry`);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  s0 = stage(pilotId, 'acceptance');
  assert.equal(s0.status, 'waiting');
  assert.match(s0.waitReason, /No Codex cartridge is running/);
  assert.equal(noticed(pilotId, 'tests-need-cartridge').length, 1);
  cartridge(repo, { type: 'codex' });
  advancePilot(pilotId);
  assert.equal(stage(pilotId, 'acceptance').status, 'running', 'starts by itself when one connects');
});

test('checklist: the reviewer is independent when it can be, verdicts need evidence, overruling needs a note', async () => {
  const repo = tmpRepo();
  const criteria = [{ text: 'The guide reads clearly for a new owner.', expect: 'A new owner follows it start to finish unaided.', verify: 'checklist' }];
  const { pilotId } = await contractPilot({ repo, criteria, templates: ['Feature Validation'] });
  assert.deepEqual(stagesOf(pilotId).map((s) => s.kind), ['workflow', 'review'], 'no tests → no stage 0');
  const codex = cartridge(repo, { type: 'codex' });
  finishRun(stage(pilotId, 'workflow').runId);
  advancePilot(pilotId);
  const rv = stage(pilotId, 'review');
  assert.equal(rv.agentId, codex, 'a different engine from the one that did the work');
  assert.match(lastPrompt(codex), /INDEPENDENT REVIEWER/);
  assert.deepEqual(pickReviewer(getPilot(pilotId)!), { agentId: codex, independent: true });

  const noEvidence = await post(`/api/goal-pilots/requests/${rv.requestId}/submit`, { result: { verdicts: [{ criterionId: 'AC-1', verdict: 'met', evidence: 'ok' }] } });
  assert.equal(noEvidence.status, 422);
  assert.match(noEvidence.json.error, /give the evidence/);
  const sub = await post(`/api/goal-pilots/requests/${rv.requestId}/submit`, { result: { verdicts: [{ criterionId: 'AC-1', verdict: 'not-met', evidence: 'Step 3 refers to a menu that does not exist.' }] } });
  assert.equal(sub.status, 200, JSON.stringify(sub.json));
  assert.equal(stage(pilotId, 'review').status, 'review');
  const overrule = await post(`/api/goal-pilots/${pilotId}/acceptance/checklist`, { confirmations: { 'AC-1': { accepted: true } } });
  assert.equal(overrule.status, 400);
  assert.match(overrule.json.error, /overruling the reviewer — say why/);
  const ok = await post(`/api/goal-pilots/${pilotId}/acceptance/checklist`, { confirmations: { 'AC-1': { accepted: true, note: 'The menu was renamed; step 3 is right.' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(getPilot(pilotId)!.phase, 'completed');
  const report = (await call('GET', `/api/goal-pilots/${pilotId}/report`)).json;
  assert.deepEqual([report.status, report.acceptance.criteria[0].outcome, report.acceptance.criteria[0].note], ['SUCCESS', 'met', 'The menu was renamed; step 3 is right.']);
});

test('the contract block: nothing before the first lock; locked tests listed with their files', () => {
  const c = {
    criteria: [{ id: 'AC-1', text: 'T1', expect: 'e', verify: 'test' as const }, { id: 'AC-2', text: 'T2', expect: 'e', verify: 'checklist' as const }],
    tests: [{ criterionId: 'AC-1', command: 'npm test -- ac1', files: [{ path: 'a.test.js', sha256: 'x', bytes: 1, content: '' }] }],
    status: 'locked', version: 0,
  } as unknown as Parameters<typeof contractBlock>[0];
  assert.equal(contractBlock(c), '', 'version 0: not locked yet');
  const block = contractBlock({ ...c!, version: 3 });
  assert.match(block, /^\[NeonCore acceptance contract v3 — LOCKED by the person\]/);
  assert.ok(block.includes('- AC-1 (test): T1 → `npm test -- ac1` [a.test.js]'));
  assert.ok(block.includes('- AC-2 (checklist): T2 — judged at the end by an independent reviewer.'));
  assert.equal(contractBlock({ ...c!, version: 3, status: 'waived' }), '');
});

test('no agent-facing tool can unlock, restore or accept a change — those are the person\'s routes only', async () => {
  const src = fs.readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');
  for (const route of ['/acceptance/approve', '/acceptance/criteria', '/acceptance/restore', '/acceptance/accept-change', '/acceptance/checklist', '/acceptance/changes']) {
    assert.ok(!src.includes(route), `the MCP server reaches ${route}`);
  }
});

// ── no wait for a check a machine can make ───────────────────────────────────
//
// REQUESTED: "once it starts it should go through writing the test criteria, then workflows listed
// with no waiting unless multiple parties are involved." What the person checked at the tests step
// was that the tests fail before any work — the baseline. Unless they chose hands-on, NeonCore runs
// it and locks; only what it cannot settle stops for them.
//
// THE SET: involvement (balanced, hands-off, hands-on) × what the baseline finds (every test red,
// one already green, the tests cannot run).
const BASELINES = [
  { finds: 'every test red', setup: (_repo: string) => {}, locks: true, why: '' },
  { finds: 'a test already green', setup: (repo: string) => implement(repo, 'AC-1', 'save 12.50 → the list shows 12.50'), locks: false, why: 'AC-1 already passes before any work' },
  // Reachable while the submission is read, gone by the time the baseline runs.
  { finds: 'tests that cannot run', setup: (_repo: string) => {
    let calls = 0;
    const away = (p: string): ReturnType<typeof repoAccessFor> => {
      if (calls++ > 0) throw new RepoAccessError('repo is on Studio-Mac, which has no NeonCore runner connected');
      setRepoAccessForTests(null);
      try { return repoAccessFor(p); } finally { setRepoAccessForTests(away); }
    };
    setRepoAccessForTests(away);
  }, locks: false, why: 'could not be run' },
];
for (const involvement of ['balanced', 'hands-off', 'hands-on']) for (const b of BASELINES) {
  test(`tests submitted × ${involvement} × baseline finds ${b.finds}`, async () => {
    const { pilotId, repo } = await contractPilot({ involvement });
    const tests = [writeTest(repo, 'AC-1', 'save 12.50 → the list shows 12.50'), writeTest(repo, 'AC-2', 'March total 19.75')];
    b.setup(repo);
    try {
      const sub = await post(`/api/goal-pilots/requests/${getContract(pilotId)!.requestId}/submit`, { result: { tests } });
      assert.equal(sub.status, 200, JSON.stringify(sub.json));
      await settleAcceptanceForTests();
    } finally { setRepoAccessForTests(null); }
    const c = getContract(pilotId)!;
    if (involvement === 'hands-on') {
      assert.equal(c.status, 'review', 'hands-on: the person reviews the tests');
      assert.equal(c.approval, null, 'nothing was approved on their behalf');
      assert.equal(noticed(pilotId, 'tests-ready').length, 1);
      return;
    }
    assert.equal(noticed(pilotId, 'tests-ready').length, 0, 'not asked to review what a machine settles');
    if (b.locks) {
      assert.equal(c.status, 'locked');
      assert.match(stage(pilotId, 'acceptance').resultSummary, /locked automatically .*2\/2 failing, as they should/);
      assert.ok(stage(pilotId, 'workflow').runId, 'the first workflow starts with no wait');
      assert.equal(noticed(pilotId, 'approval-blocked').length, 0);
    } else {
      assert.equal(c.status, 'review', 'not locked');
      assert.match(c.approval!.blocked, new RegExp(b.why));
      assert.equal(noticed(pilotId, 'approval-blocked').length, 1, 'the person is asked, with the reason');
      assert.equal(stage(pilotId, 'workflow').runId, '', 'no work against tests that prove nothing');
    }
  });
}
