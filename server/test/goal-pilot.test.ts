/**
 * GOAL PILOT — intake → scoping questions → brief → pipeline → staffing → stages run in order.
 *
 * SCOPE (what "all" means here, derived from the code):
 *   · every INTAKE_QUESTIONS entry is validated, reaches the planner prompt, and a missing
 *     required one is refused;                                                      (9 questions)
 *   · every BRIEF_FIELDS entry with a goal column is written to the goal on accept, and every
 *     one without a column reaches the stage's launch context instead;              (8 fields)
 *   · every live workflow template is offered to the pipeline planner;             (all templates)
 *   · every pilot phase is reached through the HTTP routes, in order;              (9 phases)
 *   · every way a stage can end — completed, failed, cancelled, skipped, waiting —
 *     moves the pipeline the way the runner documents;
 *   · a pilot's runs receive THEIR goal's brief even when the repo belongs to another goal.
 *
 * The planner's replies are hand-written here (what a cartridge would submit through MCP). The
 * sandbox's scripted planner is checked against these same prompts in goal-pilot-sim.test.ts.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import goalsRouter from '../src/routes/goals.ts';
import agentsRouter from '../src/routes/agents.ts';
import {
  INTAKE_QUESTIONS, BRIEF_FIELDS, MAX_SCOPE_ROUNDS, INVOLVEMENT_LEVELS,
  normalizeIntake, normalizeScopeResult, normalizePipelineResult, getPilot, stagesOf,
} from '../src/lib/goal-pilot.ts';
import { buildScopePrompt, buildPipelinePrompt, PILOT_DATA_MARKER } from '../src/lib/goal-pilot-prompts.ts';
import {
  advancePilot, sweepPilots, startGoalPilotRunner, stopGoalPilotRunner, buildStageContext,
} from '../src/lib/goal-pilot-runner.ts';
import { availableTemplates } from '../src/lib/goal-decomposition.ts';
import { emitRunFinished } from '../src/lib/run-events.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { cloneTemplateAsRun } from '../src/lib/workflow-from-template.ts';
import { setProjectCartridges } from '../src/lib/resolve-agent.ts';

const io = installStubIO();

const app = express();
app.use(express.json());
app.use('/api/goal-pilots', goalPilotsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/agents', agentsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => { server.close(); stopGoalPilotRunner(); });

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const post = (r: string, b?: unknown) => call('POST', r, b ?? {});
const get = (r: string) => call('GET', r);

let n = 0;
/** A cartridge row, connected (a relay room exists) unless said otherwise. */
function cartridge(repo: string, opts: { type?: string; status?: string; connected?: boolean } = {}): string {
  const id = `pilot-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, 'box', ?, ?, ?, ?, ?, ?)`)
    .run(id, `box/${repo.split('/').pop()}`, repo, repo.split('/').pop(), opts.status ?? 'idle', new Date().toISOString(), `sess-${id}`, opts.type ?? 'claude');
  if (opts.connected !== false) io.connect(id);
  return id;
}

/** The last prompt delivered to a cartridge. */
function lastPrompt(agentId: string): string {
  const hits = io.emissions.filter((e) => e.event === 'command_send' && e.room === `agent:${agentId}`);
  return hits.length ? String((hits[hits.length - 1].payload as { text: string }).text) : '';
}
/** Wait for an async effect (the queue's dispatch does a dynamic import) — bounded, never fixed turns. */
async function until(what: string, fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** Let anything that WOULD happen happen, then assert it did not. */
const settle = () => new Promise((r) => setTimeout(r, 200));
const requestIdIn = (prompt: string) => (prompt.match(/\[NeonCore goal pilot · (scope|pipeline|tests|review|report) request ([0-9a-f-]+)\]/) || [])[2] ?? '';

const INTAKE = {
  goal: 'Add an expenses tracking section to the app',
  context: 'Income is tracked per invoice; expenses live in a spreadsheet.',
  workType: 'feature',
  size: 'medium',
  audience: 'Small-business owners',
  done: 'I can add an expense and see monthly totals.',
  constraints: 'Do not change the invoice export format.',
  deadline: '2027-03-01',
  budgetUsd: '40',
  involvement: 'balanced',
};

const QUESTIONS = {
  status: 'questions', message: 'A few things before anyone builds.',
  questions: [
    { id: 'currency', text: 'Which currency do expenses use?', why: 'Changes the data model', kind: 'choice', options: ['Single (USD)', 'Per expense'], suggested: 'Single (USD)', required: true },
    { id: 'receipts', text: 'Attach receipts?', kind: 'boolean', suggested: 'No', required: true },
    { id: 'categories', text: 'Which categories?', kind: 'multi', options: ['Travel', 'Meals', 'Software'], required: false },
  ],
};

const BRIEF = {
  slug: 'Expenses Tracking!',
  summary: 'Owners record expenses next to income so monthly profit is visible.',
  successMetric: 'An owner adds an expense and sees it in the monthly total.',
  inScope: ['Expense entry form', 'Monthly totals'],
  acceptanceCriteria: 'When an owner saves an expense, the system shall list it under its month.',
  invariants: 'Invoice export stays byte-identical.',
  outOfScope: 'Receipt uploads',
  rabbitHoles: 'Floating-point money — store integer cents.',
  assumptions: 'Single currency (USD), as delegated.',
};

/**
 * The criteria these runner tests accept: one CHECKLIST item, so the pipeline is the planner's
 * workflows plus the independent review at the end — no stage 0. The test-criterion contract (stage 0,
 * locked tests, checks after every stage) has its own suite: acceptance-contract.test.ts.
 */
const CRITERIA = [{ text: 'When an owner saves an expense, the system shall list it under its month.', expect: 'Saving 12.50 dated 2024-03-05 → it is listed under March 2024.', verify: 'checklist' }];
const COMPLETE = { status: 'complete', brief: BRIEF, criteria: CRITERIA };

/** Finish the independent review stage: the reviewer's verdict, then the person's confirmation. */
async function finishReview(pilotId: string): Promise<void> {
  const review = stagesOf(pilotId).find((s) => s.kind === 'review')!;
  assert.equal(review.status, 'running', `the review stage is ${review.status}: ${review.waitReason}`);
  const v = await post(`/api/goal-pilots/requests/${review.requestId}/submit`, { result: { verdicts: [{ criterionId: 'AC-1', verdict: 'met', evidence: 'Saved 12.50 on 2024-03-05 and saw it under March 2024.' }] } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const c = await post(`/api/goal-pilots/${pilotId}/acceptance/checklist`, { confirmations: { 'AC-1': { accepted: true } } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
}

function pipelineOf(...names: string[]) {
  return {
    message: 'Plan, build, then document.',
    stages: names.map((template, i) => ({ template, title: `Stage ${i + 1}`, why: `why ${i + 1}`, focus: `FOCUS-${i + 1}`, optional: false })),
    alternatives: [{ template: 'Bug Hunter', why: 'not a bug' }],
  };
}

// ── registries ────────────────────────────────────────────────────────────────

test('intake: every required question is enforced, every answered one is kept', () => {
  const required = INTAKE_QUESTIONS.filter((q) => q.required);
  assert.ok(required.length >= 4, 'the registry lost its required questions');
  for (const q of required) {
    const { missing } = normalizeIntake({ ...INTAKE, [q.key]: '' });
    assert.deepEqual(missing, [q.label], `${q.key} missing was not reported`);
  }
  const { intake, missing } = normalizeIntake(INTAKE);
  assert.deepEqual(missing, []);
  for (const q of INTAKE_QUESTIONS) assert.equal(intake[q.key], (INTAKE as Record<string, string>)[q.key], `${q.key} was not kept`);
  // A choice outside its options is not an answer.
  assert.deepEqual(normalizeIntake({ ...INTAKE, workType: 'telepathy' }).missing, [INTAKE_QUESTIONS.find((q) => q.key === 'workType')!.label]);
});

test('scope normalization keeps what is usable and says what it dropped', () => {
  const out = normalizeScopeResult({
    status: 'questions',
    questions: [
      { id: 'a', text: 'First?' },
      { id: 'a', text: 'Dup id?' },
      { text: '' },
      { id: 'done-before', text: 'Asked already?' },
      { id: 'c', text: 'Pick one', kind: 'choice', options: ['only'] },
      { id: 'd', text: 'Choose', options: ['x', 'y'], suggested: 'z' },
    ],
  }, new Set(['done-before']));
  assert.ok(out.value && out.value.status === 'questions');
  const qs = out.value.status === 'questions' ? out.value.questions : [];
  assert.deepEqual(qs.map((q) => q.id), ['a', 'a-2', 'c', 'd']);
  assert.equal(qs[2].kind, 'text', 'a choice with one option is asked as text');
  assert.equal(qs[3].kind, 'choice', 'options imply a choice');
  assert.equal(qs[3].suggested, '', 'a suggestion outside the options is dropped');
  for (const frag of ['reused', 'no text', 'already answered', 'fewer than two options', 'not one of its options']) {
    assert.ok(out.notes.some((nt) => nt.includes(frag)), `no note mentioning "${frag}": ${out.notes.join(' | ')}`);
  }

  const complete = normalizeScopeResult({ status: 'complete', brief: BRIEF });
  assert.ok(complete.value && complete.value.status === 'complete');
  if (complete.value?.status === 'complete') {
    assert.equal(complete.value.brief.slug, 'expenses-tracking');
    assert.equal(complete.value.brief.inScope, '- Expense entry form\n- Monthly totals', 'a list arrives one item per line');
  }
  assert.match(normalizeScopeResult({ status: 'complete', brief: { summary: 'x' } }).error, /acceptance criteria/);
  assert.match(normalizeScopeResult({ status: 'questions', questions: [] }).error, /no usable questions/);
  assert.match(normalizeScopeResult({ status: 'maybe' }).error, /status must be/);
});

test('pipeline normalization accepts only live templates, case-insensitively', () => {
  const out = normalizePipelineResult({
    stages: [
      { template: 'release documentation', title: 'Docs' },
      { template: 'Warp Drive', title: 'Nope' },
      { title: 'No template' },
    ],
    alternatives: [{ template: 'Bug Hunter', why: 'x' }, { template: 'Release Documentation', why: 'already a stage' }, { template: 'ghost' }],
  });
  assert.deepEqual(out.value!.stages.map((s) => s.template), ['Release Documentation']);
  assert.deepEqual(out.value!.alternatives.map((a) => a.template), ['Bug Hunter']);
  assert.ok(out.notes.some((x) => x.includes('Warp Drive')));
  assert.ok(out.notes.some((x) => x.includes('named no workflow')));
  assert.match(normalizePipelineResult({ stages: [{ template: 'ghost' }] }).error, /no usable workflows/);
});

// ── the whole flow, through the routes ────────────────────────────────────────

test('a new goal goes intake → questions → brief → pipeline → staffing → stages run in order → completed', async () => {
  const repo = '/tmp/pilot-flow-repo';
  const planner = cartridge(repo);

  const created = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pilotId = created.json.pilot.id as string;
  const goalId = created.json.goalId as string;
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown>;
  assert.equal(goal.name, INTAKE.goal);
  assert.equal(goal.budget_usd, 40);
  assert.equal(goal.target_date, '2027-03-01');
  assert.equal(goal.autonomy, 'collaborative', 'balanced involvement → collaborative goal autonomy');
  assert.equal(created.json.pilot.phase, 'scoping');

  // ① The planner received the scope prompt, with every intake answer in it.
  const p1 = lastPrompt(planner);
  const r1 = requestIdIn(p1);
  assert.ok(r1, 'no scope request header in what the planner received');
  for (const q of INTAKE_QUESTIONS) {
    const v = (INTAKE as Record<string, string>)[q.key];
    const shown = q.options?.find((o) => o.value === v)?.label ?? v;
    assert.ok(p1.includes(shown), `the scope prompt does not carry ${q.key}`);
  }
  assert.ok(!p1.includes('[NeonCore work standard'), 'a planning request must not carry the work standard');

  // ② Questions come back → clarifying.
  const q = await post(`/api/goal-pilots/requests/${r1}/submit`, { result: QUESTIONS });
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.equal(q.json.phase, 'clarifying');
  // A second answer to the same request is refused.
  assert.equal((await post(`/api/goal-pilots/requests/${r1}/submit`, { result: QUESTIONS })).status, 409);

  // ③ A required question left blank is refused; delegation is an answer.
  const missing = await post(`/api/goal-pilots/${pilotId}/answers`, { answers: { currency: { value: 'Per expense' } } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /Attach receipts/);
  const answered = await post(`/api/goal-pilots/${pilotId}/answers`, {
    answers: { currency: { value: 'Per expense' }, receipts: { delegated: true }, categories: { value: ['Travel', 'Meals'] } },
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  assert.equal(answered.json.pilot.phase, 'scoping');
  const round = getPilot(pilotId)!.rounds[0];
  assert.deepEqual(round.answers.receipts, { value: 'No', delegated: true }, 'delegation resolves to the suggestion');
  assert.deepEqual(round.answers.categories, { value: ['Travel', 'Meals'] });

  // ④ Round 2 prompt carries the decisions; the planner completes the scope.
  const p2 = lastPrompt(planner);
  const r2 = requestIdIn(p2);
  assert.notEqual(r2, r1);
  assert.ok(p2.includes('Which currency do expenses use? → Per expense'));
  assert.ok(p2.includes('Attach receipts? → left to the agents — use: No'));
  const data = JSON.parse(p2.split(`${PILOT_DATA_MARKER} (`)[1].split('```json\n')[1].split('\n```')[0]);
  assert.equal(data.round, 2);
  assert.equal(data.rounds[0].questions[0].answer.value, 'Per expense');

  // A question that was already answered cannot be asked again.
  const reask = await post(`/api/goal-pilots/requests/${r2}/submit`, { result: { status: 'questions', questions: [{ id: 'currency', text: 'Currency again?' }] } });
  assert.equal(reask.status, 422);
  assert.match(reask.json.error, /already answered/);

  const done = await post(`/api/goal-pilots/requests/${r2}/submit`, { result: { ...COMPLETE, message: 'Scope is settled.' } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  // ⑤ The pipeline request went out straight away.
  const pilotAfterBrief = getPilot(pilotId)!;
  assert.equal(pilotAfterBrief.phase, 'planning');
  const p3 = lastPrompt(planner);
  const r3 = requestIdIn(p3);
  assert.match(p3, /pipeline request/);
  for (const t of availableTemplates()) assert.ok(p3.includes(`· ${t.name}`), `the pipeline prompt does not offer "${t.name}"`);

  const piped = await post(`/api/goal-pilots/requests/${r3}/submit`, { result: pipelineOf('QA Testing Guide', 'Release Documentation') });
  assert.equal(piped.status, 200, JSON.stringify(piped.json));
  assert.equal(piped.json.phase, 'proposed');

  // ⑥ Accept, with the person's edits. Every brief field with a goal column lands on the goal.
  const edited = { ...BRIEF, inScope: 'Expense entry form\nMonthly totals\nCSV export', rabbitHoles: '' };
  const accepted = await post(`/api/goal-pilots/${pilotId}/accept-plan`, {
    brief: edited,
    stages: [pipelineOf('Release Documentation', 'QA Testing Guide').stages[0], pipelineOf('QA Testing Guide').stages[0]],
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.phase, 'staffing');
  const g2 = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown>;
  for (const f of BRIEF_FIELDS.filter((x) => x.goalColumn)) {
    const expected = f.key === 'rabbitHoles' ? '' : String((getPilot(pilotId)!.plan!.brief as Record<string, string>)[f.key]);
    assert.equal(g2[f.goalColumn!], expected, `${f.key} did not land on goals.${f.goalColumn}`);
  }
  assert.deepEqual(getPilot(pilotId)!.plan!.stages.map((s) => s.template), ['Release Documentation', 'QA Testing Guide'], 'the person\'s order wins');

  // ⑦ Start: a project per repo under the goal, the first stage launched on the live cartridge.
  const started = await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.phase, 'running');
  const projects = db.prepare('SELECT id, primary_repo FROM projects WHERE goal_id = ?').all(goalId) as { id: string; primary_repo: string }[];
  assert.equal(projects.length, 1);
  assert.equal(projects[0].primary_repo, repo);
  let stages = stagesOf(pilotId);
  assert.deepEqual(stages.map((s) => `${s.kind}:${s.status}`), ['workflow:running', 'workflow:pending', 'review:pending'], 'the checklist criterion adds the independent review at the end');
  const run1 = db.prepare('SELECT * FROM workflows WHERE id = ?').get(stages[0].runId) as Record<string, unknown>;
  assert.equal(run1.project_id, projects[0].id);
  assert.equal(run1.autonomy, 'advance', 'balanced involvement → advance run posture');
  const ctx1 = String(run1.initial_context);
  for (const needle of ['stage 1 of 3', 'Feature slug: expenses-tracking', 'CSV export', 'FOCUS-1', 'Which currency do expenses use? → Per expense', 'Next: Stage 1 (QA Testing Guide)']) {
    assert.ok(ctx1.includes(needle), `stage 1 context lacks "${needle}"`);
  }
  const deferred = db.prepare(`SELECT COUNT(*) AS n FROM workflow_steps WHERE workflow_id = ? AND executor_id = '__deferred__'`).get(stages[0].runId) as { n: number };
  assert.equal(deferred.n, 0, 'every deferred step got the stage cartridge');

  // ⑧ Run 1 completes → the run-finished event starts stage 2, handing it stage 1's result.
  startGoalPilotRunner();
  db.prepare(`UPDATE workflow_steps SET status = 'completed', result = 'Wrote docs/release/1.0/notes.md', completed_at = ? WHERE workflow_id = ?`)
    .run(new Date().toISOString(), stages[0].runId);
  db.prepare(`UPDATE workflows SET status = 'completed' WHERE id = ?`).run(stages[0].runId);
  emitRunFinished(stages[0].runId, 'completed');
  await new Promise((r) => setImmediate(r));
  stages = stagesOf(pilotId);
  assert.deepEqual(stages.map((s) => s.status), ['completed', 'running', 'pending']);
  assert.match(stages[0].resultSummary, /notes\.md/);
  const ctx2 = String((db.prepare('SELECT initial_context FROM workflows WHERE id = ?').get(stages[1].runId) as { initial_context: string }).initial_context);
  assert.ok(ctx2.includes('stage 2 of 3') && ctx2.includes('Wrote docs/release/1.0/notes.md'), 'stage 2 was not told what stage 1 produced');

  // ⑨ The last run completes → the independent review of the checklist → the person confirms → completed.
  db.prepare(`UPDATE workflows SET status = 'completed' WHERE id = ?`).run(stages[1].runId);
  sweepPilots();
  assert.equal(getPilot(pilotId)!.phase, 'running', 'the checklist is not judged yet');
  assert.match(lastPrompt(planner), /goal pilot · review request/);
  await finishReview(pilotId);
  assert.equal(getPilot(pilotId)!.phase, 'completed');

  // The view the dashboard reads carries progress and names.
  const v = await get(`/api/goal-pilots/${pilotId}`);
  assert.equal(v.json.stages.length, 3);
  assert.equal(v.json.acceptance.passing, 1);
  assert.ok(v.json.stages[0].progress.total > 0);
  assert.equal(v.json.goalName, INTAKE.goal);
});

// ── the runner's edges ────────────────────────────────────────────────────────

/** A pilot already in `staffing`, built through the routes with canned planner replies. */
async function stagedPilot(repo: string, templates: string[], intake: Partial<typeof INTAKE> = {}) {
  const planner = cartridge(`${repo}-planner`);
  const c = await post('/api/goal-pilots', { intake: { ...INTAKE, ...intake }, plannerAgentId: planner });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const pilotId = c.json.pilot.id as string;
  await post(`/api/goal-pilots/requests/${requestIdIn(lastPrompt(planner))}/submit`, { result: COMPLETE });
  await post(`/api/goal-pilots/requests/${requestIdIn(lastPrompt(planner))}/submit`, { result: pipelineOf(...templates) });
  const a = await post(`/api/goal-pilots/${pilotId}/accept-plan`, {});
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return { pilotId, goalId: c.json.goalId as string, planner };
}

test('a stage with no live cartridge WAITS, says why, and starts by itself when one connects', async () => {
  const repo = '/tmp/pilot-wait-repo';
  const { pilotId } = await stagedPilot(repo, ['QA Testing Guide']);
  const started = await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'codex' }] });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  let [s] = stagesOf(pilotId);
  assert.equal(s.status, 'waiting');
  assert.match(s.waitReason, /No Codex cartridge is running in pilot-wait-repo/);

  const codex = cartridge(repo, { type: 'codex', status: 'working' });
  sweepPilots();
  [s] = stagesOf(pilotId);
  assert.equal(s.status, 'waiting');
  assert.match(s.waitReason, /busy/, 'a busy cartridge is waited for, never worked on top of');

  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(codex);
  sweepPilots();
  [s] = stagesOf(pilotId);
  assert.equal(s.status, 'running');
  assert.equal(s.agentId, codex);
});

test('a failed stage pauses the pipeline; resume is refused until it is retried or skipped', async () => {
  const repo = '/tmp/pilot-fail-repo';
  cartridge(repo);
  const { pilotId } = await stagedPilot(repo, ['QA Testing Guide', 'Release Documentation']);
  await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  let stages = stagesOf(pilotId);
  const firstRun = stages[0].runId;
  db.prepare(`UPDATE workflows SET status = 'failed', error = 'gate never passed' WHERE id = ?`).run(firstRun);
  advancePilot(pilotId);
  let pilot = getPilot(pilotId)!;
  assert.equal(pilot.phase, 'paused');
  assert.match(pilot.attention, /Stage 1 .* failed/);
  assert.equal(stagesOf(pilotId)[0].status, 'failed');

  const resume = await post(`/api/goal-pilots/${pilotId}/resume`);
  assert.equal(resume.status, 409);
  assert.match(resume.json.error, /retry or skip/);

  // Retry launches a NEW run for the same stage.
  const retried = await post(`/api/goal-pilots/${pilotId}/stages/${stages[0].id}/retry`);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  stages = stagesOf(pilotId);
  assert.equal(stages[0].status, 'running');
  assert.notEqual(stages[0].runId, firstRun);
  assert.equal(stages[0].attempts, 2);

  // Skip cancels the live run and moves on.
  const skipped = await post(`/api/goal-pilots/${pilotId}/stages/${stages[0].id}/skip`);
  assert.equal(skipped.status, 200, JSON.stringify(skipped.json));
  assert.equal((db.prepare('SELECT status FROM workflows WHERE id = ?').get(stages[0].runId) as { status: string }).status, 'cancelled');
  stages = stagesOf(pilotId);
  assert.deepEqual(stages.map((s) => s.status), ['skipped', 'running', 'pending']);
  const ctx = String((db.prepare('SELECT initial_context FROM workflows WHERE id = ?').get(stages[1].runId) as { initial_context: string }).initial_context);
  assert.match(ctx, /skipped by the person/);
  pilot = getPilot(pilotId)!;
  assert.equal(pilot.phase, 'running');
});

test('pause / resume / cancel carry through to the current run', async () => {
  const repo = '/tmp/pilot-steer-repo';
  cartridge(repo);
  const { pilotId } = await stagedPilot(repo, ['QA Testing Guide', 'Release Documentation']);
  await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  const runId = stagesOf(pilotId)[0].runId;
  const runState = () => (db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string }).status;

  assert.equal((await post(`/api/goal-pilots/${pilotId}/pause`)).json.phase, 'paused');
  assert.equal(runState(), 'paused');
  assert.equal((await post(`/api/goal-pilots/${pilotId}/resume`)).json.phase, 'running');
  assert.equal(runState(), 'running');
  const cancelled = await post(`/api/goal-pilots/${pilotId}/cancel`);
  assert.equal(cancelled.json.phase, 'cancelled');
  assert.equal(runState(), 'cancelled');
  assert.deepEqual(stagesOf(pilotId).map((s) => s.status), ['cancelled', 'cancelled', 'cancelled']);
});

test('the goal budget stops the pipeline before the next stage spends past it', async () => {
  const repo = '/tmp/pilot-budget-repo';
  const agent = cartridge(repo);
  const { pilotId, goalId } = await stagedPilot(repo, ['QA Testing Guide'], { budgetUsd: '0.01' });
  // The goal must own the repo for its cost to count — exactly what start does.
  const proj = 'pilot-budget-proj';
  db.prepare(`INSERT INTO projects (id, goal_id, name, primary_repo, created_at, updated_at) VALUES (?, ?, 'b', ?, ?, ?)`)
    .run(proj, goalId, repo, new Date().toISOString(), new Date().toISOString());
  setProjectCartridges(proj, [repo]);
  db.prepare(`INSERT INTO session_usage (id, agent_id, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, recorded_at)
              VALUES (?, ?, 's', 1000000, 1000000, 0, 0, 'claude-sonnet-4', ?)`).run('usage-budget', agent, new Date().toISOString());
  await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  const pilot = getPilot(pilotId)!;
  assert.equal(pilot.phase, 'paused');
  assert.match(pilot.attention, /budget is spent/);
  assert.equal(stagesOf(pilotId)[0].runId, '', 'no run was started past the budget');
});

test('scoping ends after MAX_SCOPE_ROUNDS: more questions are refused, a brief is required', async () => {
  const planner = cartridge('/tmp/pilot-rounds-planner');
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner });
  const pilotId = c.json.pilot.id as string;
  for (let r = 1; r <= MAX_SCOPE_ROUNDS; r++) {
    const rid = requestIdIn(lastPrompt(planner));
    const out = await post(`/api/goal-pilots/requests/${rid}/submit`, { result: { status: 'questions', questions: [{ id: `q${r}`, text: `Question ${r}?` }] } });
    assert.equal(out.status, 200, `round ${r}: ${JSON.stringify(out.json)}`);
    await post(`/api/goal-pilots/${pilotId}/answers`, { answers: { [`q${r}`]: { value: `answer ${r}` } } });
  }
  const last = lastPrompt(planner);
  assert.match(last, /It is the LAST round/);
  const refused = await post(`/api/goal-pilots/requests/${requestIdIn(last)}/submit`, { result: { status: 'questions', questions: [{ id: 'more', text: 'One more?' }] } });
  assert.equal(refused.status, 422);
  assert.match(refused.json.error, /submit status "complete"/);
});

test('a planner that cannot be reached fails the request visibly, and retry can move it to another cartridge', async () => {
  const offline = cartridge('/tmp/pilot-unreachable', { connected: false });
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: offline });
  assert.equal(c.status, 201);
  assert.match(c.json.error, /did not receive/);
  assert.equal(c.json.pilot.currentRequest.status, 'failed');
  assert.match(c.json.pilot.attention, /planner request failed/);

  const other = cartridge('/tmp/pilot-reachable');
  const retried = await post(`/api/goal-pilots/${c.json.pilot.id}/retry`, { agentId: other });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.pilot.currentRequest.status, 'pending');
  assert.equal(retried.json.pilot.plannerAgentId, other);
  assert.ok(requestIdIn(lastPrompt(other)));
});

test('one live pilot per goal; replace cancels the old one', async () => {
  const planner = cartridge('/tmp/pilot-one-per-goal');
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner });
  const goalId = c.json.goalId as string;
  const again = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner, goalId });
  assert.equal(again.status, 409);
  assert.equal(again.json.pilotId, c.json.pilot.id);
  const replaced = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner, goalId, replace: true });
  assert.equal(replaced.status, 201);
  assert.equal(getPilot(c.json.pilot.id)!.phase, 'cancelled');
});

test('deleting the goal stops its pipeline and removes the pilot rows', async () => {
  const repo = '/tmp/pilot-delete-repo';
  cartridge(repo);
  const { pilotId, goalId } = await stagedPilot(repo, ['QA Testing Guide']);
  await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  const runId = stagesOf(pilotId)[0].runId;
  const del = await call('DELETE', `/api/goals/${goalId}`);
  assert.equal(del.status, 204);
  assert.equal(getPilot(pilotId), null);
  assert.equal(stagesOf(pilotId).length, 0);
  assert.equal((db.prepare('SELECT status FROM workflows WHERE id = ?').get(runId) as { status: string }).status, 'cancelled');
});

test('every involvement level maps to a goal autonomy and a run posture that exist', async () => {
  const { AUTONOMY_LEVELS } = await import('../src/lib/goal-pm.ts');
  const { SETTABLE_LEVELS } = await import('../src/lib/autonomy.ts');
  for (const l of INVOLVEMENT_LEVELS) {
    assert.ok(AUTONOMY_LEVELS.some((a) => a.key === l.goalAutonomy), `${l.value}: goal autonomy ${l.goalAutonomy} is not a level`);
    assert.ok((SETTABLE_LEVELS as readonly string[]).includes(l.runAutonomy), `${l.value}: run posture ${l.runAutonomy} is not settable`);
  }
});

test('brief fields without a goal column reach the stage context instead', async () => {
  const repo = '/tmp/pilot-ctx-repo';
  cartridge(repo);
  const { pilotId } = await stagedPilot(repo, ['QA Testing Guide']);
  await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  const pilot = getPilot(pilotId)!;
  const stages = stagesOf(pilotId);
  const ctx = buildStageContext(pilot, stages[0], stages);
  for (const f of BRIEF_FIELDS.filter((x) => !x.goalColumn)) {
    const value = pilot.plan!.brief[f.key];
    assert.ok(value && ctx.includes(value.split('\n')[0]), `${f.key} reaches neither the goal nor the stage context`);
  }
});

// ── the goal brief a pilot's run receives ─────────────────────────────────────

test('a run attached to a project gets THAT project\'s goal brief, even when an older goal claims the repo', () => {
  const repo = '/tmp/pilot-two-goals-repo';
  const agent = cartridge(repo);
  const t = new Date().toISOString();
  const mkGoal = (id: string, name: string) => db.prepare(
    `INSERT INTO goals (id, name, description, success_metric, status, created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results)
     VALUES (?, ?, '', '', 'active', ?, ?, ?, '', '', '', '[]')`).run(id, name, t, t, `criteria of ${name}`);
  const mkProject = (id: string, goalId: string, created: string) => {
    db.prepare(`INSERT INTO projects (id, goal_id, name, primary_repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, goalId, id, repo, created, created);
    setProjectCartridges(id, [repo]);
  };
  mkGoal('goal-older', 'OLDER GOAL');
  mkGoal('goal-pilot', 'PILOT GOAL');
  mkProject('proj-older', 'goal-older', '2020-01-01T00:00:00Z');
  mkProject('proj-pilot', 'goal-pilot', t);

  const templateId = availableTemplates().find((x) => x.name === 'QA Testing Guide')!.id;
  const runId = cloneTemplateAsRun(templateId, 'proj-pilot', 'context', { agentId: agent })!;
  const before = io.emissions.length;
  tickWorkflowsOnce();
  const sent = io.emissions.slice(before).filter((e) => e.event === 'command_send' && e.room === `agent:${agent}`);
  assert.ok(sent.length > 0, `the first step of ${runId} was not dispatched`);
  const text = String((sent[0].payload as { text: string }).text);
  assert.match(text, /OUTCOME: PILOT GOAL/);
  assert.doesNotMatch(text, /OLDER GOAL/);
});

test('prompts: the PILOT-DATA block is valid JSON and agrees with the prose', async () => {
  const planner = cartridge('/tmp/pilot-data-planner');
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner });
  const pilot = getPilot(c.json.pilot.id)!;
  const extract = (p: string) => JSON.parse(p.split('```json\n')[1].split('\n```')[0]);
  const scope = extract(buildScopePrompt(pilot, 'req-x'));
  assert.equal(scope.requestId, 'req-x');
  assert.deepEqual(scope.briefFields, BRIEF_FIELDS.map((f) => f.key));
  assert.deepEqual(Object.keys(scope.intake).sort(), Object.keys(INTAKE).sort());

  db.prepare('UPDATE goal_pilots SET brief = ? WHERE id = ?').run(JSON.stringify({ ...BRIEF, slug: 'x', inScope: 'a' }), pilot.id);
  const pipe = extract(buildPipelinePrompt(getPilot(pilot.id)!, 'req-y'));
  assert.deepEqual(pipe.templates.map((t: { name: string }) => t.name), availableTemplates().map((t) => t.name));
});

// ── a busy planner: the request waits in the queue as its own kind ────────────

test('a busy planner gets the request through the queue — delivered without the work standard, done when it SUBMITS', async () => {
  const { tickQueue, listQueue } = await import('../src/lib/queue-runner.ts');
  const planner = cartridge('/tmp/pilot-busy-planner', { status: 'working' });
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.queued, true);
  assert.equal(lastPrompt(planner), '', 'nothing may be typed into a busy cartridge');
  const item = listQueue().find((i) => i.kind === 'goal-pilot' && i.payload.requestId === c.json.pilot.currentRequestId)!;
  assert.ok(item, 'no goal-pilot queue item');
  assert.equal(item.lane, `agent:${planner}`, 'a planner request serialises with that cartridge\'s other work');

  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(planner);
  tickQueue();
  await until('the queue to deliver the planner request', () => /goal pilot · scope request/.test(lastPrompt(planner)));
  const prompt = lastPrompt(planner);
  assert.ok(!prompt.includes('[NeonCore work standard'), 'a planning request must not carry the work standard');
  const armed = db.prepare('SELECT standard_armed FROM agents WHERE id = ?').get(planner) as { standard_armed: number };
  assert.equal(armed.standard_armed, 0, 'the queue armed the stop gate for a planning turn');
  assert.equal(listQueue().find((i) => i.id === item.id)!.status, 'running');

  await post(`/api/goal-pilots/requests/${requestIdIn(prompt)}/submit`, { result: QUESTIONS });
  tickQueue();
  assert.equal(listQueue().find((i) => i.id === item.id)!.status, 'done', 'the submission did not complete the queue item');
});

test('a queued request superseded by a retry completes its item without being sent — the lane is not halted', async () => {
  const { tickQueue, listQueue } = await import('../src/lib/queue-runner.ts');
  const busy = cartridge('/tmp/pilot-superseded-planner', { status: 'working' });
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: busy });
  const other = cartridge('/tmp/pilot-superseded-other');
  await post(`/api/goal-pilots/${c.json.pilot.id}/retry`, { agentId: other });
  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(busy);
  tickQueue();
  await until('the superseded item to be started', () => listQueue().some((i) => i.kind === 'goal-pilot' && i.targets[0] === busy && i.handle !== ''));
  tickQueue();
  const item = listQueue().find((i) => i.kind === 'goal-pilot' && i.targets[0] === busy)!;
  assert.equal(item.status, 'done');
  assert.match(item.result, /superseded/);
  assert.equal(lastPrompt(busy), '', 'a superseded request was still typed into the cartridge');
});

test('a planner that goes quiet without submitting is called out, so the pilot is not "thinking" forever', async () => {
  const { checkSilentPlanner, PLANNER_SILENT_MS } = await import('../src/lib/goal-pilot-runner.ts');
  const planner = cartridge('/tmp/pilot-silent-planner');
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner });
  const id = c.json.pilot.id as string;
  assert.equal(checkSilentPlanner(id, Date.now() + 1000), false, 'too early to call it');
  db.prepare(`UPDATE agents SET status = 'working' WHERE id = ?`).run(planner);
  assert.equal(checkSilentPlanner(id, Date.now() + PLANNER_SILENT_MS + 1000), false, 'a planner still working is not silent');
  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(planner);
  // Idle alone is the staleness sweep, which also fires mid-tool: not yet "finished".
  assert.equal(checkSilentPlanner(id, Date.now() + PLANNER_SILENT_MS + 1000), false, 'idle mid-turn is not silence');
  // The turn really ended (routes/agents.ts turnEnded) and nothing followed.
  db.prepare(`UPDATE agents SET turn_ended_at = ? WHERE id = ?`).run(new Date().toISOString(), planner);
  assert.equal(checkSilentPlanner(id, Date.now() + PLANNER_SILENT_MS + 1000), true);
  const v = await get(`/api/goal-pilots/${id}`);
  assert.equal(v.json.currentRequest.status, 'failed');
  assert.match(v.json.currentRequest.error, /without submitting/);
});

test('a busy planner gets the queued request the moment its turn ends — not after the idle timer', async () => {
  const planner = cartridge('/tmp/pilot-between-turns', { status: 'working' });
  const c = await post('/api/goal-pilots', { intake: INTAKE, plannerAgentId: planner });
  assert.equal(c.json.queued, true, 'a working cartridge must be queued for');
  await settle();
  assert.equal(lastPrompt(planner), '', 'mid-turn: nothing may be typed in');
  // What reporter.py's Stop hook sends last. An allowed stop ends the turn (routes/agents.ts turnEnded).
  const session = (db.prepare('SELECT session_id FROM agents WHERE id = ?').get(planner) as { session_id: string }).session_id;
  await call('POST', '/api/agents/completion-check', { sessionId: session, agentType: 'claude', finalText: 'Done.' });
  await until('the planner request to be delivered at the end of the turn', () => /goal pilot · scope request/.test(lastPrompt(planner)));
});

test('the next stage starts the moment the cartridge\'s turn ends — not on the idle timer, not on the sweep', async () => {
  const repo = '/tmp/pilot-stage-turn-over';
  const agent = cartridge(repo, { status: 'working' });
  const { pilotId } = await stagedPilot(repo, ['QA Testing Guide']);
  await post(`/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
  assert.equal(stagesOf(pilotId)[0].status, 'waiting', 'mid-turn: the stage must wait');
  const session = (db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agent) as { session_id: string }).session_id;
  await call('POST', '/api/agents/completion-check', { sessionId: session, agentType: 'claude', finalText: 'Done.' });
  await until('the stage to start', () => stagesOf(pilotId)[0].status === 'running');
});
