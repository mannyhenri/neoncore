/**
 * Does anything under this goal need a person right now?
 *
 * `workflowNeedsAttention()` already answers that for one run, deriving the verdict from live
 * state rather than from remembered notifications — and its ordering (failed → interrupted →
 * decision → agent-waiting → manual-advance) encodes real judgement about which blockage to
 * send someone to first. This module aggregates those verdicts upward; it does not re-derive
 * them. Reimplementing the reasons here would produce a second opinion that drifts from the
 * one the run badge shows, and the two would disagree in front of the user.
 *
 * ── WORST REASON WINS, AND "WORST" MEANS THE EXISTING ORDER ────────────────────────────
 * A goal can have three runs blocked three different ways. Reporting the decision gate would
 * send someone to answer a question on a goal that already has a failed run — the same mistake
 * `workflowNeedsAttention` avoids within a single run. Rank is taken from the INDEX in
 * `ATTENTION_REASONS`, so adding a reason there orders it here automatically and neither list
 * can fall out of step with the other.
 *
 * ── WHY THIS ANSWERS "how many", NOT JUST "what" ───────────────────────────────────────
 * At goal scale the count is the news. One blocked run is a thing to go fix; four blocked runs
 * is a goal that has stopped moving, and the reason alone cannot tell those apart.
 */
import { ATTENTION_REASONS, workflowNeedsAttention, type AttentionReason } from './workflow-attention.js';
import { goalRunIds } from './goal-scope.js';
import db from '../db.js';

export interface GoalHealth {
  /** The most urgent reason across the goal's runs. */
  reason: AttentionReason;
  /** The run carrying that reason, so the UI can link straight to it. */
  runId: string;
  runName: string;
  stepName: string;
  /** One line a person can act on without opening the run. */
  detail: string;
  /** How many of the goal's runs need attention at all, this one included. */
  blockedRuns: number;
}

const rank = (r: AttentionReason): number => ATTENTION_REASONS.indexOf(r);

/**
 * The goal's worst blockage, or null when nothing is waiting on a human.
 *
 * Null is the healthy answer AND the answer for a goal with no runs — deliberately. "Nothing
 * needs you" is true in both cases, and progress is the metric that distinguishes "done" from
 * "never started". Health is not the place to encode emptiness.
 */
export function goalHealth(goalId: string): GoalHealth | null {
  const runIds = goalRunIds(goalId);
  if (runIds.length === 0) return null;

  const blocked = runIds
    .map((runId) => ({ runId, attention: workflowNeedsAttention(runId) }))
    .filter((r): r is { runId: string; attention: NonNullable<ReturnType<typeof workflowNeedsAttention>> } =>
      r.attention !== null);

  if (blocked.length === 0) return null;

  // Stable worst-first. `workflowNeedsAttention` already filters to running workflows, so a
  // cancelled or finished run cannot contribute a permanent badge.
  const worst = blocked.reduce((a, b) => (rank(b.attention.reason) < rank(a.attention.reason) ? b : a));

  const wf = db.prepare('SELECT name FROM workflows WHERE id = ?').get(worst.runId) as
    { name?: string } | undefined;

  return {
    reason: worst.attention.reason,
    runId: worst.runId,
    runName: wf?.name ?? '',
    stepName: worst.attention.stepName,
    detail: worst.attention.detail,
    blockedRuns: blocked.length,
  };
}
