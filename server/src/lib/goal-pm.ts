/**
 * THE PM SURFACE: schedule, investment, autonomy, portfolio.
 *
 * Phase 7. The research argued AGAINST this at current scale — one goal is a portfolio of one,
 * and anything justified by "portfolio management" is premature. The user heard that and chose
 * it anyway, which is recorded in the epic as an accepted risk. Two consequences are built in
 * rather than argued about again:
 *
 *  1. The portfolio strip renders ONLY above one goal (`shouldShowPortfolio`). At a portfolio of
 *     one it is a second, worse copy of the goal card directly beneath it.
 *  2. Nothing here invents certainty. A goal with no target date is not "on track", it has no
 *     schedule; a goal whose progress is unmeasurable is not "at risk", it is unmeasured. Every
 *     function returns null rather than a reassuring default — the same rule Phase 3 established
 *     for progress, for the same reason.
 */
import db from '../db.js';
import { goalProgress } from './goal-progress.js';
import { goalCostUsd } from './goal-cost.js';

// ── investment categories ─────────────────────────────────────────────────────

/**
 * Swarmia's mechanic: categorise the top item, and every child inherits.
 *
 * INHERITANCE IS DERIVED, NEVER COPIED. The research noted NeonCore's hierarchy is stricter
 * than an issue tracker's, so inheritance is total rather than ~80% — which means a project's
 * category is simply its goal's, and duplicating it onto project and task rows would create two
 * values that can disagree. Cost already rolls up through `goal-scope`, so grouping by category
 * is grouping goals.
 */
export const INVESTMENT_CATEGORIES = [
  { key: 'new-value', label: 'New value', hint: 'Features and capabilities that did not exist' },
  { key: 'growth', label: 'Growth', hint: 'Work aimed at adoption, activation or revenue' },
  { key: 'reliability', label: 'Reliability', hint: 'Making what exists dependable' },
  { key: 'ktlo', label: 'Keep the lights on', hint: 'Maintenance, upgrades, toil' },
] as const;

export type InvestmentCategory = (typeof INVESTMENT_CATEGORIES)[number]['key'];

const CATEGORY_KEYS = new Set(INVESTMENT_CATEGORIES.map((c) => c.key));

/** '' is legal and means uncategorised — which the rollup reports rather than hides. */
export function normalizeCategory(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : '';
  return CATEGORY_KEYS.has(v as InvestmentCategory) ? v : '';
}

export interface CategorySpend {
  category: string;
  label: string;
  costUsd: number;
  goalCount: number;
}

/**
 * Spend grouped by investment category.
 *
 * Uncategorised goals appear as their own row, never folded into a bucket and never dropped.
 * Hiding them would make the split look complete while the largest slice of spend is missing —
 * which is exactly the "answers a question it cannot actually answer" failure this epic exists
 * to avoid.
 */
export function costByCategory(): CategorySpend[] {
  const goals = db.prepare("SELECT id, investment_category FROM goals").all() as
    { id: string; investment_category: string | null }[];

  const buckets = new Map<string, { costUsd: number; goalCount: number }>();
  for (const g of goals) {
    const key = normalizeCategory(g.investment_category);
    const bucket = buckets.get(key) ?? { costUsd: 0, goalCount: 0 };
    bucket.costUsd += goalCostUsd(g.id);
    bucket.goalCount += 1;
    buckets.set(key, bucket);
  }

  const labelFor = (key: string) =>
    INVESTMENT_CATEGORIES.find((c) => c.key === key)?.label ?? 'Uncategorised';

  return [...buckets.entries()]
    .map(([category, v]) => ({ category, label: labelFor(category), ...v }))
    .sort((a, b) => b.costUsd - a.costUsd || a.label.localeCompare(b.label));
}

// ── autonomy posture ──────────────────────────────────────────────────────────

/**
 * The arXiv ladder, as instructions rather than labels.
 *
 * A posture only changes behaviour if the agent is told what it MEANS — "this goal is
 * Supervised" is a word, not a constraint. Each level therefore carries the sentence that goes
 * into the goal brief, and the brief is injected at dispatch, so this reaches real prompts.
 */
export const AUTONOMY_LEVELS = [
  {
    key: 'guided',
    label: 'Guided',
    hint: 'Propose, then wait. Nothing lands without a decision.',
    brief: 'Propose your approach and WAIT for a decision before making changes. Do not land work unasked.',
  },
  {
    key: 'supervised',
    label: 'Supervised',
    hint: 'Do the work, but stop before anything irreversible.',
    brief: 'Do the work, but stop before anything irreversible (merges, deploys, deletions, external calls) and ask.',
  },
  {
    key: 'collaborative',
    label: 'Collaborative',
    hint: 'Run, checking in at genuine decision points.',
    brief: 'Work independently, checking in at genuine decision points rather than at every step.',
  },
  {
    key: 'assisted',
    label: 'Assisted',
    hint: 'Run to completion; ask only when truly blocked.',
    brief: 'Work through to completion. Ask only when genuinely blocked — do not stop for confirmation you can reason out.',
  },
] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]['key'];

const AUTONOMY_KEYS = new Set(AUTONOMY_LEVELS.map((a) => a.key));

/**
 * '' means unset, and unset is NOT silently promoted to a default.
 *
 * Defaulting to 'assisted' would hand every unconfigured goal maximum latitude; defaulting to
 * 'guided' would stall every existing goal. Unset means the brief says nothing about autonomy
 * and the agent behaves as it does today.
 */
export function normalizeAutonomy(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : '';
  return AUTONOMY_KEYS.has(v as AutonomyLevel) ? v : '';
}

export function autonomyBriefLine(value: unknown): string {
  const key = normalizeAutonomy(value);
  if (!key) return '';
  const level = AUTONOMY_LEVELS.find((a) => a.key === key)!;
  return `AUTONOMY — ${level.label}: ${level.brief}`;
}

// ── schedule ──────────────────────────────────────────────────────────────────

export type ScheduleState = 'overdue' | 'due-soon' | 'on-time' | 'met';

export interface GoalSchedule {
  targetDate: string;
  daysRemaining: number;
  state: ScheduleState;
  /** Why the state is what it is, in words a person can act on. */
  detail: string;
}

/** Whole days between two dates, ignoring clock time — a deadline is a day, not a moment. */
function daysBetween(fromISO: string, toISO: string): number {
  const day = 24 * 60 * 60 * 1000;
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / day);
}

export const DUE_SOON_DAYS = 3;

/**
 * Where a goal stands against its target date.
 *
 * Null when there is no target — nothing can be late against a date nobody set, and inventing
 * an "on track" for every goal would make the badge meaningless.
 *
 * A COMPLETE goal past its date is `met`, not overdue: it finished, and the date has no further
 * claim on it. A goal with unmeasurable progress past its date IS overdue — the deadline passed
 * and nothing demonstrably happened, which is precisely the case worth surfacing.
 *
 * `now` is a parameter so the caller supplies the clock. Tests need a fixed one, and a function
 * that reads the wall clock internally cannot be tested at a boundary.
 */
export function goalSchedule(goalId: string, now: string = new Date().toISOString()): GoalSchedule | null {
  const row = db.prepare('SELECT target_date FROM goals WHERE id = ?').get(goalId) as
    { target_date: string | null } | undefined;
  const targetDate = (row?.target_date || '').trim();
  if (!targetDate) return null;

  const daysRemaining = daysBetween(now, targetDate);
  if (Number.isNaN(daysRemaining)) return null;

  const progress = goalProgress(goalId);
  const complete = progress.fraction === 1;

  if (complete) {
    return {
      targetDate, daysRemaining, state: 'met',
      detail: daysRemaining >= 0
        ? `Finished with ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} to spare.`
        : `Finished ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? '' : 's'} after the target.`,
    };
  }

  if (daysRemaining < 0) {
    const over = Math.abs(daysRemaining);
    return {
      targetDate, daysRemaining, state: 'overdue',
      detail: progress.fraction === null
        ? `${over} day${over === 1 ? '' : 's'} past target, and no work has run against this goal.`
        : `${over} day${over === 1 ? '' : 's'} past target, ${Math.round(progress.fraction * 100)}% complete.`,
    };
  }

  if (daysRemaining <= DUE_SOON_DAYS) {
    return {
      targetDate, daysRemaining, state: 'due-soon',
      detail: daysRemaining === 0
        ? 'Due today.'
        : `Due in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`,
    };
  }

  return {
    targetDate, daysRemaining, state: 'on-time',
    detail: `${daysRemaining} days remaining.`,
  };
}

// ── portfolio ─────────────────────────────────────────────────────────────────

/**
 * A cross-goal strip is only worth the space above MORE THAN ONE goal.
 *
 * Written as a function rather than an inline `length > 1` so the rule is stated once and
 * tested: at a portfolio of one the strip is a second, worse copy of the card beneath it, and
 * the research called that out specifically.
 */
export function shouldShowPortfolio(goalCount: number): boolean {
  return goalCount > 1;
}

export interface PortfolioSummary {
  goalCount: number;
  activeCount: number;
  totalCostUsd: number;
  /** Goals with at least one run blocked on a human. */
  needsAttentionCount: number;
  overdueCount: number;
  /** Completed steps over total, across every goal. Null when nothing is measurable anywhere. */
  fraction: number | null;
  byCategory: CategorySpend[];
}

/**
 * The whole portfolio in one row.
 *
 * Progress is recomputed from raw step counts rather than averaging each goal's percentage: a
 * goal with 2 steps and a goal with 200 would otherwise count equally, so one tiny finished goal
 * could show the portfolio as half done.
 */
export function portfolioSummary(now: string = new Date().toISOString()): PortfolioSummary {
  const goals = db.prepare('SELECT id, status FROM goals').all() as { id: string; status: string }[];

  let totalCostUsd = 0;
  let completedSteps = 0;
  let totalSteps = 0;
  let needsAttentionCount = 0;
  let overdueCount = 0;

  for (const g of goals) {
    totalCostUsd += goalCostUsd(g.id);
    const p = goalProgress(g.id);
    completedSteps += p.completedSteps;
    totalSteps += p.totalSteps;
    if (goalSchedule(g.id, now)?.state === 'overdue') overdueCount += 1;
  }

  // Health is imported lazily: goal-health pulls in the workflow attention primitive, and this
  // module is imported by the goals route on every read.
  try {
    const { goalHealth } = require('./goal-health.js') as typeof import('./goal-health.js');
    for (const g of goals) if (goalHealth(g.id)) needsAttentionCount += 1;
  } catch {
    needsAttentionCount = 0;
  }

  return {
    goalCount: goals.length,
    activeCount: goals.filter((g) => g.status === 'active').length,
    totalCostUsd,
    needsAttentionCount,
    overdueCount,
    fraction: totalSteps > 0 ? completedSteps / totalSteps : null,
    byCategory: costByCategory(),
  };
}
