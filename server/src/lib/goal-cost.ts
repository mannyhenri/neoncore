/**
 * Real USD cost rollups from session_usage, attributed by cartridge (repo):
 * session_usage -> agent (repo_path) -> project (primary_repo) -> goal.
 *
 * Shared by the goals/projects API responses and the heartbeat budget gate so
 * the visible "$ spent / $ budget" bar and the enforcement use the same number.
 */
import db from '../db.js';
import { agentIdsForRepo } from './resolve-agent.js';
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

/** Real USD spent across every cartridge belonging to this goal's projects. */
export function goalCostUsd(goalId: string): number {
  const repos = db
    .prepare("SELECT primary_repo FROM projects WHERE goal_id = ? AND primary_repo != ''")
    .all(goalId) as { primary_repo: string }[];
  const agentIds = [...new Set(repos.flatMap((r) => agentIdsForRepo(r.primary_repo)))];
  return costForAgentIds(agentIds);
}
