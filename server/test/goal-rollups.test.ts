/**
 * PROGRESS AND HEALTH, ROLLED UP TO THE GOAL.
 *
 * Phase 3. Cost flows up, intent flows down, and progress flowed nowhere — while NeonCore holds
 * better raw material than the tools that sell this feature, because step statuses are captured
 * at dispatch rather than reconstructed from git afterwards.
 *
 * Two properties are load-bearing across everything below:
 *
 *  1. NULL IS NOT ZERO. "0% complete" claims work started and got nowhere; "no runs yet" says
 *     nothing was ever asked of this goal. Collapsing the second into the first recreates the
 *     exact defect this epic exists to fix — an empty hierarchy that looks populated.
 *
 *  2. HEALTH IS AGGREGATED, NOT RE-DERIVED. `workflowNeedsAttention` owns the reasons and their
 *     order. These tests cross-check the goal's verdict against that function's own output, so
 *     a second opinion cannot drift into existence.
 *
 * Set-based over STATES rather than examples: the failure mode is a rollup that handles the
 * populated case and quietly mishandles empty, cancelled, or template-only ones.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { goalProgress } from '../src/lib/goal-progress.ts';
import { goalHealth } from '../src/lib/goal-health.ts';
import { goalRunIds, goalProjectIds } from '../src/lib/goal-scope.ts';
import { workflowNeedsAttention, ATTENTION_REASONS } from '../src/lib/workflow-attention.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function goal(): string {
  const id = `g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, budget_usd, status,
              created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results)
              VALUES (?,?,'','',NULL,'active',?,?,'','','','','[]')`).run(id, `goal ${id}`, ISO, ISO);
  return id;
}
function project(goalId: string | null): string {
  const id = `p-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,?,?,'','','#fff',?,?)`).run(id, goalId, `proj ${id}`, ISO, ISO);
  return id;
}
/** A RUN. `template_id` non-empty is what distinguishes it from a template definition. */
function run(projectId: string | null, status = 'running'): string {
  const id = `w-${++n}`;
  db.prepare(`INSERT INTO workflows (id, name, status, project_id, template_id, created_at)
              VALUES (?,?,?,?,'tpl-1',?)`).run(id, `run ${id}`, status, projectId, ISO);
  return id;
}
/**
 * A TEMPLATE — `template_id` NULL, exactly as the live rows are shaped.
 *
 * Takes a projectId deliberately. The first version of this helper always wrote NULL, which
 * meant the goal's PROJECT filter excluded the template before the template filter was ever
 * consulted — so the "templates never count" test passed no matter what that filter said, and
 * a mutation removing it entirely went undetected. Attaching the template to the goal's own
 * project is what forces the assertion onto the rule it claims to be testing.
 */
function template(projectId: string | null = null): string {
  const id = `t-${++n}`;
  db.prepare(`INSERT INTO workflows (id, name, status, project_id, template_id, created_at)
              VALUES (?,?,'pending',?,NULL,?)`).run(id, `tpl ${id}`, projectId, ISO);
  return id;
}
function step(
  workflowId: string,
  status: string,
  extra: { executorType?: string; executorId?: string; autoAdvance?: number; recovery?: string; config?: string } = {},
): string {
  const id = `s-${++n}`;
  db.prepare(`INSERT INTO workflow_steps
              (id, workflow_id, name, status, executor_type, executor_id, executor_config,
               auto_advance, recovery_status, position_y, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workflowId, `step ${id}`, status, extra.executorType ?? 'agent', extra.executorId ?? '',
         extra.config ?? '{}', extra.autoAdvance ?? 1, extra.recovery ?? '', n, ISO);
  return id;
}
/**
 * `question` matters for the 'waiting' status: a cartridge is only genuinely blocked on a
 * person when something is actually outstanding. `waiting` with an empty banner is a stale
 * flag — Claude Code sets it whenever a turn simply ends — and workflow-attention now reads it
 * as an abandoned step rather than a question. A fixture that omits the question is testing a
 * stall while claiming to test a question.
 */
function agent(status: string, question = ''): string {
  const id = `a-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id, pending_question)
              VALUES (?,?,'m',?,?,'claude',?,?,'',?)`).run(id, `t/${id}`, `/r/${id}`, id, status, ISO, question);
  return id;
}

// ── progress ──────────────────────────────────────────────────────────────────

/**
 * THE SET OF WAYS A GOAL CAN HAVE NOTHING TO MEASURE. Every one of these previously would
 * have rendered as "0%", which reads as failing rather than as not-yet-started.
 */
const UNMEASURABLE: { label: string; wire: (g: string) => void }[] = [
  { label: 'no projects at all', wire: () => {} },
  { label: 'projects but no runs', wire: (g) => { project(g); } },
  { label: 'a run with no steps', wire: (g) => { run(project(g)); } },
  {
    label: 'only cancelled runs — work called off, not work failed',
    wire: (g) => { const w = run(project(g), 'cancelled'); step(w, 'completed'); step(w, 'pending'); },
  },
];

test('a goal with nothing to measure reports null, never 0%', () => {
  const wrong: string[] = [];
  for (const c of UNMEASURABLE) {
    const g = goal();
    c.wire(g);
    const p = goalProgress(g);
    if (p.fraction !== null) wrong.push(`${c.label}: fraction ${p.fraction}, expected null`);
  }
  assert.deepEqual(wrong, [], `these fabricate a percentage out of nothing:\n  ${wrong.join('\n  ')}`);
});

test('progress counts completed steps over total, across every run of the goal', () => {
  const g = goal();
  const p1 = project(g);
  const p2 = project(g);
  const w1 = run(p1); step(w1, 'completed'); step(w1, 'completed'); step(w1, 'pending');
  const w2 = run(p2); step(w2, 'completed'); step(w2, 'running');

  const got = goalProgress(g);
  assert.equal(got.totalSteps, 5);
  assert.equal(got.completedSteps, 3);
  assert.equal(got.fraction, 3 / 5);
  assert.equal(got.runsCounted, 2, 'both projects\' runs must roll up to the one goal');
});

test('cancelled runs are excluded from the denominator, not counted as incomplete', () => {
  // The live database had three cancelled runs carrying 133 pending steps between them —
  // enough to hold a healthy goal near 30% forever for a decision that was deliberate.
  const g = goal();
  const p = project(g);
  const live = run(p); step(live, 'completed'); step(live, 'completed');
  const dead = run(p, 'cancelled');
  for (let i = 0; i < 20; i++) step(dead, 'pending');

  const got = goalProgress(g);
  assert.equal(got.fraction, 1, 'a cancelled run dragged a finished goal below 100%');
  assert.equal(got.totalSteps, 2);
  assert.equal(got.runsCounted, 1);
});

test('TEMPLATE steps never count — they are definitions, not work', () => {
  // Templates carry `template_id IS NULL` and hold hundreds of permanently-pending steps.
  // Counting them would peg every goal low forever, and no finished work could move it.
  const g = goal();
  const p = project(g);
  // Attached to the goal's OWN project, so only the template filter can keep it out.
  const t = template(p);
  for (let i = 0; i < 30; i++) step(t, 'pending');
  const w = run(p); step(w, 'completed');

  assert.deepEqual(goalRunIds(g), [w], 'a template leaked into the goal\'s run scope');
  assert.equal(goalProgress(g).fraction, 1);
});

test("another goal's runs do not count toward this one", () => {
  const g1 = goal(); const g2 = goal();
  const w1 = run(project(g1)); step(w1, 'completed');
  const w2 = run(project(g2)); step(w2, 'pending'); step(w2, 'pending');

  assert.equal(goalProgress(g1).fraction, 1);
  assert.equal(goalProgress(g2).fraction, 0, 'a real 0 — this goal HAS steps, none finished');
});

test('a real 0% is distinguishable from nothing to measure', () => {
  // The pair this whole design turns on: both render as "0" to a naive caller.
  const started = goal();
  const w = run(project(started)); step(w, 'pending');
  const untouched = goal();

  assert.equal(goalProgress(started).fraction, 0);
  assert.equal(goalProgress(untouched).fraction, null);
});

test('progress is scoped through the same projects reach and cost use', () => {
  // One resolution path. If progress found runs through a project this goal does not own,
  // the number would describe someone else's work.
  const g = goal();
  const mine = project(g);
  const theirs = project(null);
  const w = run(mine); step(w, 'completed');
  const other = run(theirs); step(other, 'pending');

  assert.deepEqual(goalProjectIds(g), [mine]);
  assert.deepEqual(goalRunIds(g), [w]);
  assert.equal(goalProgress(g).fraction, 1);
});

// ── health ────────────────────────────────────────────────────────────────────

test('a goal with nothing blocked reports null', () => {
  const g = goal();
  const w = run(project(g)); step(w, 'running');   // working, not waiting
  assert.equal(goalHealth(g), null);
});

test('a goal with no runs reports null rather than inventing a state', () => {
  assert.equal(goalHealth(goal()), null);
  const g = goal(); project(g);
  assert.equal(goalHealth(g), null);
});

/**
 * EVERY reason reaches the goal. A rollup that surfaces `failed` but silently drops
 * `agent-waiting` is worse than no rollup: it actively asserts nothing needs you.
 */
const REASON_FIXTURES: { reason: string; wire: (runId: string) => void }[] = [
  { reason: 'failed', wire: (w) => { step(w, 'failed'); } },
  { reason: 'interrupted', wire: (w) => { step(w, 'running', { recovery: 'interrupted' }); } },
  { reason: 'decision', wire: (w) => { step(w, 'running', { executorType: 'decision' }); } },
  { reason: 'agent-waiting', wire: (w) => { step(w, 'running', { executorId: agent('waiting', 'Which approach?') }); } },
  { reason: 'manual-advance', wire: (w) => { step(w, 'completed', { autoAdvance: 0 }); step(w, 'pending'); } },
];

test('EVERY attention reason rolls up from run to goal', () => {
  const wrong: string[] = [];
  for (const f of REASON_FIXTURES) {
    const g = goal();
    const w = run(project(g));
    f.wire(w);
    const health = goalHealth(g);
    if (health?.reason !== f.reason) {
      wrong.push(`${f.reason}: goal reported ${health?.reason ?? 'null'}`);
    }
    // The goal must agree with the run it came from — not hold a second opinion.
    const runVerdict = workflowNeedsAttention(w);
    if (health && runVerdict && health.reason !== runVerdict.reason) {
      wrong.push(`${f.reason}: goal says ${health.reason}, the run says ${runVerdict.reason}`);
    }
  }
  assert.deepEqual(wrong, [], `reasons lost or altered on the way up:\n  ${wrong.join('\n  ')}`);
});

test('the WORST reason wins, in the order the run-level primitive already defines', () => {
  // Otherwise someone is sent to answer a decision gate on a goal that has a failed run.
  const g = goal();
  const p = project(g);
  const asking = run(p); step(asking, 'running', { executorId: agent('waiting') });
  const broken = run(p); step(broken, 'failed');

  const health = goalHealth(g);
  assert.equal(health?.reason, 'failed');
  assert.equal(health?.runId, broken);
  assert.ok(
    ATTENTION_REASONS.indexOf('failed') < ATTENTION_REASONS.indexOf('agent-waiting'),
    'ranking is taken from ATTENTION_REASONS, so this ordering must hold there',
  );
});

test('health counts how many runs are blocked, not just the worst one', () => {
  // One blocked run is something to go fix; four is a goal that has stopped moving.
  const g = goal();
  const p = project(g);
  const a = run(p); step(a, 'failed');
  const b = run(p); step(b, 'running', { executorType: 'decision' });
  const c = run(p); step(c, 'running');            // healthy — must not be counted

  const health = goalHealth(g);
  assert.equal(health?.blockedRuns, 2);
  assert.equal(health?.reason, 'failed');
  assert.ok(c, 'the healthy run exists and is deliberately uncounted');
});

test('finished and cancelled runs never flag a goal — history is not a blockage', () => {
  // `workflowNeedsAttention` only speaks for running workflows. If that ever changed, a goal
  // would carry a permanent badge for work that ended weeks ago.
  const wrong: string[] = [];
  for (const status of ['completed', 'cancelled', 'failed', 'paused']) {
    const g = goal();
    const w = run(project(g), status);
    step(w, 'failed');
    if (goalHealth(g) !== null) wrong.push(`${status}: flagged a run that is not running`);
  }
  assert.deepEqual(wrong, [], `${wrong.join('\n  ')}`);
});

test("another goal's blocked run does not flag this goal", () => {
  const g1 = goal(); const g2 = goal();
  const w = run(project(g2)); step(w, 'failed');
  assert.equal(goalHealth(g1), null);
  assert.equal(goalHealth(g2)?.reason, 'failed');
});
