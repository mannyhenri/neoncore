/**
 * Real USD cost rollups from session_usage, attributed by cartridge (repo):
 * session_usage -> agent (repo_path) -> project (primary_repo) -> goal.
 *
 * Shared by the goals/projects API responses and the heartbeat budget gate so
 * the visible "$ spent / $ budget" bar and the enforcement use the same number.
 */
import db from '../db.js';
import { agentIdsForRepo } from './resolve-agent.js';
import { goalAgentIds } from './goal-scope.js';
import { totalCostUsd, type UsageRow } from './pricing.js';

function costForAgentIds(agentIds: string[]): number {
  if (!agentIds.length) return 0;
  const placeholders = agentIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model
         FROM session_usage WHERE agent_id IN (${placeholders})`,
    )
    .all(...agentIds) as UsageRow[];
  return totalCostUsd(rows);
}

/** Real USD spent by every agent working in this project's cartridge. */
export function projectCostUsd(primaryRepo: string): number {
  return costForAgentIds(agentIdsForRepo(primaryRepo));
}

/**
 * Real USD spent across every cartridge belonging to this goal's projects.
 *
 * BOTH ownership routes, deliberately. This used to read only `projects.primary_repo`, so a
 * project that owned its cartridges through `project_cartridges` — the newer, multi-repo link —
 * billed nothing, permanently. The failure surfaced the moment linkage was switched on: a goal
 * displaying "reaches 2 cartridges" alongside "$0.00 spent", with cost structurally unable to
 * move. Two numbers on one card contradicting each other is worse than the silence it replaced.
 *
 * Reach, the goal brief and this function all answer "which cartridges belong to this goal".
 * They must answer identically or one of them is lying; the tests assert that equality rather
 * than each function's output in isolation.
 */
export function goalCostUsd(goalId: string): number {
  // The ownership UNION and the repo→cartridge resolution both live in goal-scope.ts now, so
  // reach, cost, progress and health cannot drift apart. This function held one of the two
  // copies; the other was in goal-reach.ts and resolved paths by different rules.
  return costForAgentIds(goalAgentIds(goalId));
}
