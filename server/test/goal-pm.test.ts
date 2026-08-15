/**
 * THE PM SURFACE: schedule, investment, autonomy, portfolio.
 *
 * Phase 7 — the phase the research argued against at this scale ("a portfolio of one"), which
 * the user overruled. That disagreement is not re-litigated here; it is ENCODED. The portfolio
 * strip has a rule about when it is worth the space, and every function refuses to invent
 * certainty it does not have.
 *
 * The recurring assertion across this file is the same one Phase 3 established: null is not a
 * default. A goal with no target date is not "on time" — it has no schedule. An unset autonomy
 * posture does not silently become "assisted". Uncategorised spend is not folded into a bucket.
 * Each of those defaults would make a surface look authoritative while answering a question it
 * cannot actually answer.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  INVESTMENT_CATEGORIES, AUTONOMY_LEVELS, DUE_SOON_DAYS,
  normalizeCategory, normalizeAutonomy, autonomyBriefLine,
  costByCategory, goalSchedule, shouldShowPortfolio, portfolioSummary,
} from '../src/lib/goal-pm.ts';
import { buildGoalBrief } from '../src/lib/goal-brief.ts';

installStubIO();

const ISO = new Date().toISOString();
const NOW = '2026-06-15T12:00:00Z';
let n = 0;

function goal(fields: Record<string, unknown> = {}): string {
  const id = `g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, budget_usd, status,
              created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results,
              target_date, owner, investment_category, autonomy)
              VALUES (?,?,'','',?,?,?,?,'','','','','[]',?,?,?,?)`)
    .run(id, (fields.name as string) ?? `goal ${id}`, fields.budgetUsd ?? null,
         fields.status ?? 'active', ISO, ISO,
         fields.targetDate ?? '', fields.owner ?? '',
         fields.category ?? '', fields.autonomy ?? '');
  return id;
}
function project(goalId: string): string {
  const id = `p-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,?,?,'','','#fff',?,?)`).run(id, goalId, `proj ${id}`, ISO, ISO);
  return id;
}
function run(projectId: string, status = 'running'): string {
  const id = `w-${++n}`;
  db.prepare(`INSERT INTO workflows (id, name, status, project_id, template_id, created_at)
              VALUES (?,?,?,?,'tpl',?)`).run(id, `run ${id}`, status, projectId, ISO);
  return id;
}
function step(workflowId: string, status: string): void {
  const id = `s-${++n}`;
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id,
              executor_config, auto_advance, recovery_status, position_y, created_at)
              VALUES (?,?,?,?,'agent','','{}',1,'',?,?)`).run(id, workflowId, `step ${id}`, status, n, ISO);
}
/**
 * Wipe the hierarchy.
 *
 * `costByCategory` and `portfolioSummary` are GLOBAL by nature — they answer "across every
 * goal" — so unlike the per-goal helpers they cannot be scoped with a WHERE clause. Without
 * this, four assertions here were silently measuring goals other tests had created, which is
 * the same contamination that bit the decomposition suite.
 */
function reset(): void {
  db.exec(`
    DELETE FROM workflow_steps;
    DELETE FROM workflows;
    DELETE FROM tasks;
    DELETE FROM project_cartridges;
    DELETE FROM projects;
    DELETE FROM goals;
  `);
}

/** A goal whose every step is complete. */
function completedGoal(targetDate: string): string {
  const g = goal({ targetDate });
  const w = run(project(g), 'completed');
  step(w, 'completed');
  return g;
}

// ── schedule ──────────────────────────────────────────────────────────────────

test('a goal with no target date has no schedule — it is not "on time"', () => {
  // Inventing an on-track badge for every goal would make the badge mean nothing.
  assert.equal(goalSchedule(goal(), NOW), null);
  assert.equal(goalSchedule(goal({ targetDate: '   ' }), NOW), null);
});

test('a malformed target date reports no schedule rather than a nonsense one', () => {
  assert.equal(goalSchedule(goal({ targetDate: 'next quarter' }), NOW), null);
});

/**
 * THE BOUNDARY SET. A deadline is a DAY, not a moment, so each of these is computed from the
 * date alone — and the day-of case is the one an off-by-one silently gets wrong.
 */
const SCHEDULE_CASES: { label: string; target: string; state: string }[] = [
  { label: 'well in the future', target: '2026-12-01', state: 'on-time' },
  { label: `exactly ${DUE_SOON_DAYS + 1} days out — still on time`, target: '2026-06-19', state: 'on-time' },
  { label: `exactly ${DUE_SOON_DAYS} days out — due soon`, target: '2026-06-18', state: 'due-soon' },
  { label: 'today', target: '2026-06-15', state: 'due-soon' },
  { label: 'yesterday', target: '2026-06-14', state: 'overdue' },
  { label: 'long past', target: '2025-01-01', state: 'overdue' },
];

test('EVERY schedule boundary lands in the right state', () => {
  const wrong: string[] = [];
  for (const c of SCHEDULE_CASES) {
    const got = goalSchedule(goal({ targetDate: c.target }), NOW);
    if (got?.state !== c.state) wrong.push(`${c.label}: ${got?.state ?? 'null'}, expected ${c.state}`);
  }
  assert.deepEqual(wrong, [], `schedule states are wrong at the boundary:\n  ${wrong.join('\n  ')}`);
});

test('a FINISHED goal past its date is met, not overdue', () => {
  // The date has no further claim on work that is done. Flagging it red forever would train
  // people to ignore the badge.
  const s = goalSchedule(completedGoal('2026-01-01'), NOW);
  assert.equal(s?.state, 'met');
  assert.match(s!.detail, /after the target/);
});

test('a finished goal inside its date says how much time was left', () => {
  const s = goalSchedule(completedGoal('2026-12-01'), NOW);
  assert.equal(s?.state, 'met');
  assert.match(s!.detail, /to spare/);
});

test('an overdue goal with NO work run says exactly that', () => {
  // The most actionable case in the whole surface: the deadline passed and nothing happened.
  // "20 days past target, 0% complete" implies work that stalled; this one never started.
  const s = goalSchedule(goal({ targetDate: '2026-06-01' }), NOW);
  assert.equal(s?.state, 'overdue');
  assert.match(s!.detail, /no work has run/);
});

test('an overdue goal with partial work reports how far it got', () => {
  const g = goal({ targetDate: '2026-06-01' });
  const w = run(project(g));
  step(w, 'completed'); step(w, 'pending');
  const s = goalSchedule(g, NOW);
  assert.equal(s?.state, 'overdue');
  assert.match(s!.detail, /50% complete/);
});

// ── investment categories ─────────────────────────────────────────────────────

test('only known categories survive; anything else is uncategorised', () => {
  const wrong: string[] = [];
  for (const c of INVESTMENT_CATEGORIES) {
    if (normalizeCategory(c.key) !== c.key) wrong.push(`${c.key} was rejected`);
  }
  for (const junk of ['', '  ', 'nonsense', 'KTLO', 42, null, undefined, {}]) {
    if (normalizeCategory(junk) !== '') wrong.push(`${JSON.stringify(junk)} was accepted`);
  }
  assert.deepEqual(wrong, []);
});

test('UNCATEGORISED spend is reported, never hidden or folded into a bucket', () => {
  reset();
  // Dropping it would make the split look complete while the largest slice is missing — a
  // surface answering a question it cannot actually answer.
  goal({ category: 'ktlo' });
  goal({ category: '' });
  goal({ category: 'not-a-real-category' });

  const rows = costByCategory();
  const uncategorised = rows.find((r) => r.category === '');
  assert.ok(uncategorised, 'uncategorised goals vanished from the rollup');
  assert.equal(uncategorised!.goalCount, 2, 'an invalid category was not treated as uncategorised');
  assert.equal(uncategorised!.label, 'Uncategorised');
});

test('every goal lands in exactly one bucket', () => {
  reset();
  goal({ category: 'growth' });
  goal({ category: 'growth' });
  goal({ category: 'reliability' });
  const after = costByCategory();
  assert.equal(after.reduce((s, r) => s + r.goalCount, 0), 3, 'a goal was counted twice or lost');
  assert.equal(after.find((r) => r.category === 'growth')?.goalCount, 2);
});

// ── autonomy ──────────────────────────────────────────────────────────────────

test('an unset autonomy posture stays unset — it does not become a default', () => {
  // Defaulting to 'assisted' hands every unconfigured goal maximum latitude; defaulting to
  // 'guided' stalls every existing goal. Neither is a decision anyone made.
  const wrong: string[] = [];
  for (const junk of ['', 'autonomous', 'GUIDED', null, 7]) {
    if (normalizeAutonomy(junk) !== '') wrong.push(`${JSON.stringify(junk)} became a posture`);
    if (autonomyBriefLine(junk) !== '') wrong.push(`${JSON.stringify(junk)} produced brief text`);
  }
  assert.deepEqual(wrong, []);
});

test('EVERY autonomy level reaches the agent as an instruction, not a label', () => {
  // "This goal is Supervised" is a word, and a word changes nothing. The brief must carry what
  // the posture REQUIRES, in the imperative.
  const wrong: string[] = [];
  for (const level of AUTONOMY_LEVELS) {
    const g = goal({ autonomy: level.key });
    const brief = buildGoalBrief(g);
    if (!brief.includes(level.label)) wrong.push(`${level.key}: label missing from the brief`);
    if (!brief.includes(level.brief)) wrong.push(`${level.key}: the instruction itself never travels`);
  }
  assert.deepEqual(wrong, [], `autonomy does not reach the agent:\n  ${wrong.join('\n  ')}`);
});

test('a goal with no posture says NOTHING about autonomy in its brief', () => {
  const brief = buildGoalBrief(goal({ name: 'Plain goal' }));
  assert.ok(!brief.includes('AUTONOMY'), 'an unset posture injected guidance nobody chose');
});

test('the target date reaches the agent; the owner does not', () => {
  // The deadline changes how work is scoped. Who owns the goal does not change what an agent
  // does, and padding the brief with fields that change no behaviour dilutes the ones that do.
  const brief = buildGoalBrief(goal({ targetDate: '2026-09-30', owner: 'Manny Henri' }));
  assert.match(brief, /2026-09-30/);
  assert.ok(!brief.includes('Manny Henri'), 'owner metadata leaked into the dispatched prompt');
});

// ── portfolio ─────────────────────────────────────────────────────────────────

test('the /portfolio route is declared BEFORE /:id, or it is unreachable', () => {
  // Shipped broken once: both are one path segment, so Express matches in declaration order and
  // `/:id` swallowed "portfolio", answering `{"error":"Goal not found"}`. The comment above the
  // route claimed it was declared first while it was not — which is why this asserts the
  // ORDER rather than trusting the note.
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src/routes/goals.ts'), 'utf8',
  );
  const portfolio = src.indexOf("router.get('/portfolio'");
  const byId = src.indexOf("router.get('/:id'");
  assert.ok(portfolio > -1, 'the portfolio route is gone');
  assert.ok(byId > -1, 'the goal-by-id route is gone');
  assert.ok(portfolio < byId, '/:id is declared first and will swallow /portfolio');
});

test('the portfolio strip is hidden at a portfolio of one', () => {
  // The research's objection, encoded rather than argued: above one goal the strip is a second,
  // worse copy of the card beneath it.
  assert.equal(shouldShowPortfolio(0), false);
  assert.equal(shouldShowPortfolio(1), false);
  assert.equal(shouldShowPortfolio(2), true);
});

test('portfolio progress is weighted by STEPS, not by averaging percentages', () => {
  reset();
  // Averaging would let one finished 2-step goal and one untouched 200-step goal read as 50%.
  const small = goal();
  const w1 = run(project(small), 'completed');
  step(w1, 'completed'); step(w1, 'completed');

  const big = goal();
  const w2 = run(project(big));
  for (let i = 0; i < 18; i++) step(w2, 'pending');

  const p = portfolioSummary(NOW);
  assert.equal(p.fraction, 2 / 20, 'progress was averaged across goals instead of summed over steps');
});

test('portfolio progress is null when nothing anywhere is measurable', () => {
  reset();
  goal(); goal();
  assert.equal(portfolioSummary(NOW).fraction, null);
});

test('the portfolio counts overdue goals', () => {
  reset();
  goal({ targetDate: '2025-01-01' });
  goal({ targetDate: '2030-01-01' });
  goal();
  const p = portfolioSummary(NOW);
  assert.equal(p.overdueCount, 1, 'a goal with no target date or a future one was counted as overdue');
});

test('the portfolio counts goals, active goals and category rows consistently', () => {
  reset();
  goal({ status: 'active', category: 'ktlo' });
  goal({ status: 'achieved', category: 'ktlo' });
  const p = portfolioSummary(NOW);
  assert.equal(p.byCategory.reduce((s, r) => s + r.goalCount, 0), p.goalCount,
    'the category split does not account for every goal');
  assert.ok(p.activeCount <= p.goalCount);
});
