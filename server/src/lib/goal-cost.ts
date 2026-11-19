/**
 * Real USD cost rollups from session_usage:
 *   a project  — everything spent in its repos (projectTotalCostUsd)
 *   a feature  — what its own work spent: its runs' steps and its pipeline's requests (featureCostUsd)
 *   a goal outside any project — everything its cartridges spent (goalCostUsd's old attribution)
 *
 * Shared by the goals/projects API responses and the heartbeat budget gate so
 * the visible "$ spent / $ budget" bar and the enforcement use the same number.
 */
import db from '../db.js';
import { agentIdsForRepo, getProjectCartridges } from './resolve-agent.js';
import { goalAgentIds, goalRunIds, featureProjectId } from './goal-scope.js';
import { totalCostUsd, type UsageRow } from './pricing.js';

function costForAgentIds(agentIds: string[]): number {
  if (!agentIds.length) return 0;
  const placeholders = agentIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, speed
         FROM session_usage WHERE agent_id IN (${placeholders})`,
    )
    .all(...agentIds) as UsageRow[];
  return totalCostUsd(rows);
}

/**
 * Real USD spent in ANY of a project's repos — its cartridges (project_cartridges) and its
 * primary repo. A project is now the set of repos its features run in, so its spend is all of them.
 */
export function projectTotalCostUsd(projectId: string, primaryRepo = ''): number {
  const repos = [...new Set([primaryRepo, ...getProjectCartridges(projectId)].filter(Boolean))];
  return costForAgentIds([...new Set(repos.flatMap((r) => agentIdsForRepo(r)))]);
}

/** How long after a step finishes its usage can still arrive: the Stop hook posts it after the report. */
const USAGE_GRACE_MS = 90_000;

/**
 * Real USD spent ON A FEATURE: the usage its own work produced.
 *
 * A feature shares its project's cartridges with every other feature of that project, so billing it
 * "everything those cartridges spent" would charge each feature for all the others — and its
 * budget (which pauses the pipeline) would trip on a sibling's spend. Instead usage is attributed
 * through the work itself: for every step of every run launched for the feature, and every request
 * put to a cartridge for it (planner, test writer, reviewer), the usage that cartridge recorded
 * while that work was in flight. A cartridge does one thing at a time (the busy guard), so those
 * windows do not overlap another feature's.
 */
export function featureCostUsd(goalId: string): number {
  const windows: { agentId: string; from: string; to: string }[] = [];
  const nowIso = new Date().toISOString();
  const runIds = goalRunIds(goalId);
  if (runIds.length) {
    const steps = db.prepare(
      `SELECT executor_id, dispatch_agent_id, executor_type, executor_config, started_at, completed_at
         FROM workflow_steps WHERE workflow_id IN (${runIds.map(() => '?').join(',')}) AND started_at IS NOT NULL AND started_at != ''`,
    ).all(...runIds) as { executor_id: string; dispatch_agent_id: string; executor_type: string; executor_config: string; started_at: string; completed_at: string | null }[];
    for (const s of steps) {
      const agents = new Set([s.dispatch_agent_id, s.executor_id].filter((x) => x && x !== '__deferred__'));
      if (s.executor_type === 'confer' || s.executor_type === 'deliberation') {
        try {
          const cfg = JSON.parse(s.executor_config || '{}') as { conferAgentIds?: string[]; agentIds?: string[] };
          for (const id of [...(cfg.conferAgentIds ?? []), ...(cfg.agentIds ?? [])]) if (id) agents.add(id);
        } catch { /* unreadable config: the executor's own id still counts */ }
      }
      for (const agentId of agents) windows.push({ agentId, from: s.started_at, to: s.completed_at || nowIso });
    }
  }
  const requests = db.prepare(
    `SELECT r.agent_id, COALESCE(r.dispatched_at, r.created_at) AS started, r.completed_at
       FROM goal_pilot_requests r JOIN goal_pilots p ON p.id = r.pilot_id
      WHERE p.goal_id = ? AND r.agent_id != '' AND r.status != 'superseded'`,
  ).all(goalId) as { agent_id: string; started: string; completed_at: string | null }[];
  for (const r of requests) windows.push({ agentId: r.agent_id, from: r.started, to: r.completed_at || nowIso });
  if (windows.length === 0) return 0;

  const seen = new Set<string>();
  const rows: UsageRow[] = [];
  const q = db.prepare(
    `SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, speed
       FROM session_usage WHERE agent_id = ? AND recorded_at >= ? AND recorded_at <= ?`,
  );
  for (const w of windows) {
    const to = new Date(Date.parse(w.to) + USAGE_GRACE_MS).toISOString();
    for (const row of q.all(w.agentId, w.from, to) as (UsageRow & { id: string })[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return totalCostUsd(rows);
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
  // A feature of a project is billed for its own work (featureCostUsd). Only an old-style goal,
  // not filed under a project, keeps the whole-cartridge attribution it always had.
  if (featureProjectId(goalId)) return featureCostUsd(goalId);
  // The ownership UNION and the repo→cartridge resolution both live in goal-scope.ts now, so
  // reach, cost, progress and health cannot drift apart. This function held one of the two
  // copies; the other was in goal-reach.ts and resolved paths by different rules.
  return costForAgentIds(goalAgentIds(goalId));
}
