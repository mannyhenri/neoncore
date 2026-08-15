/**
 * How many cartridges does this goal actually reach?
 *
 * The Goals area's defect was silence, not permissiveness. All three live projects carry
 * `goal_id = NULL`, so `goalCostUsd()` returns 0 and the goal brief injects 0 characters into
 * every dispatched prompt — and nothing anywhere said so. Two features shipped and sat inert
 * for a week because an empty hierarchy looks identical to a populated one.
 *
 * The user decided (2026-08-13) NOT to require a goal on every project — "just in case we just
 * need to work quickly on something" — which upholds the v0.1 design principle that project
 * assignment is optional. So the fix is to make the emptiness LOUD rather than illegal.
 *
 * ── WHY THIS SHARES goal-brief's RESOLUTION AND DOES NOT REIMPLEMENT IT ──────────────────
 * Reach is a claim about what the brief will do. If it were computed independently it could
 * report 3 while `goalForAgent()` resolves for 0 — a more confident lie than the silence it
 * replaced. It therefore walks the same two ownership routes goal-brief.ts honours
 * (`project_cartridges`, and the older `primary_repo`), and the tests assert equality with
 * `goalForAgent` rather than with a hand-written number.
 */
import db from '../db.js';
import { goalAgentIds } from './goal-scope.js';

/**
 * Distinct cartridges resolvable to this goal.
 *
 * Counts LINKAGE, not liveness: an offline cartridge is still reached, because the brief will
 * carry to it the moment it is dispatched to. Tying this to status would make the number
 * flicker as cartridges sleep.
 */
export function goalReach(goalId: string): number {
  // Delegates to the shared scope rather than running its own query. It used to do the
  // ownership UNION inline with an exact `a.repo_path IN (...)`, while cost resolved the same
  // repos through `agentIdsForRepo`, which normalizes case, separators and trailing slashes.
  // The two agreed only when a path was spelled identically in both tables — so a goal could
  // read "reaches no cartridges" beside a non-zero spend. See goal-scope.ts.
  return goalAgentIds(goalId).length;
}

/**
 * Projects with no goal.
 *
 * Legal by design, so the count is the mechanism that keeps the choice visible instead of
 * letting unattached work quietly accumulate.
 */
export function unassignedProjectCount(): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM projects WHERE goal_id IS NULL OR goal_id = ''",
  ).get() as { n: number };
  return row?.n ?? 0;
}
