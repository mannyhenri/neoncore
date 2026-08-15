/**
 * How far along is this goal?
 *
 * Derived from `workflow_steps.status`, aggregated run → project → goal, over the same scope
 * cost and reach use (`goal-scope.ts`). The research called progress the headline gap in the
 * Goals area: cost flows up, intent flows down, and progress flowed nowhere despite NeonCore
 * holding better raw material than the tools that sell this feature — verified step statuses
 * captured at dispatch rather than reconstructed afterwards from git.
 *
 * ── NULL IS NOT ZERO, AND THE DIFFERENCE IS THE WHOLE POINT ────────────────────────────
 * "0% complete" says work started and got nowhere. "No runs yet" says nothing has been asked
 * of this goal. Rendering the second as the first is precisely the failure this epic exists to
 * correct: a hierarchy that is EMPTY looking identical to one that is POPULATED. So `fraction`
 * is null whenever there is nothing to measure, and the UI must say so in words rather than
 * drawing an empty bar.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ──────────────────────────────────────────────
 * Step completion is a proxy. A goal at 100% has had every step of every run marked completed;
 * it has NOT been graded against its own acceptance criteria, which is a separate and unbuilt
 * thing (the epic's open question GOAL-020/"what does done mean"). The field is named
 * `stepsCompleted`, not `done`, so no caller can mistake one for the other.
 */
import db from '../db.js';
import { goalRunIds } from './goal-scope.js';

export interface GoalProgress {
  /** Steps finished across every counted run. */
  completedSteps: number;
  /** Every step of every counted run, whatever its status. */
  totalSteps: number;
  /**
   * `completedSteps / totalSteps`, or null when there is nothing to measure —
   * no projects, no runs, or only cancelled runs. Never fabricate a 0 here.
   */
  fraction: number | null;
  /** Runs that contributed. Cancelled runs are excluded, so this can be 0 while runs exist. */
  runsCounted: number;
}

const EMPTY: GoalProgress = { completedSteps: 0, totalSteps: 0, fraction: null, runsCounted: 0 };

/**
 * Cancelled runs are excluded entirely, not counted as incomplete.
 *
 * A cancelled run is work that was called off, so leaving its pending steps in the denominator
 * would permanently cap the goal below 100% for a decision that was deliberate. The three
 * cancelled `CE: Full Delivery` runs in the live database carried 133 pending steps between
 * them — enough to hold a healthy goal near 30% forever.
 */
export function goalProgress(goalId: string): GoalProgress {
  const runIds = goalRunIds(goalId);
  if (runIds.length === 0) return EMPTY;

  const placeholders = runIds.map(() => '?').join(',');
  const counted = db.prepare(
    `SELECT id FROM workflows WHERE id IN (${placeholders}) AND status != 'cancelled'`,
  ).all(...runIds) as { id: string }[];
  if (counted.length === 0) return EMPTY;

  const ph2 = counted.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM workflow_steps WHERE workflow_id IN (${ph2})`,
  ).get(...counted.map((r) => r.id)) as { total: number; completed: number | null };

  const totalSteps = row?.total ?? 0;
  const completedSteps = row?.completed ?? 0;
  // A run with no steps is not 100% done — it is unmeasurable, same as no runs at all.
  if (totalSteps === 0) return { ...EMPTY, runsCounted: counted.length };

  return {
    completedSteps,
    totalSteps,
    fraction: completedSteps / totalSteps,
    runsCounted: counted.length,
  };
}
