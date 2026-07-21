import db from '../db.js';

/**
 * Normalize a repo path for cross-platform matching.
 * Handles Windows backslashes vs POSIX forward slashes and drive-letter formats:
 *   c:\Users\Manny\repo  →  /c/users/manny/repo
 *   /c/Users/Manny/repo  →  /c/users/manny/repo
 */
export function normalizeRepoPath(p: string): string {
  if (!p) return '';
  let n = p.replace(/\\/g, '/');
  // c:/ → /c/
  n = n.replace(/^([a-zA-Z]):\//, '/$1/');
  // Strip trailing slash
  n = n.replace(/\/+$/, '');
  return n.toLowerCase();
}

/**
 * Resolve an agent id from any of the identifiers hooks/extensions send.
 * Order: explicit agentId → machine + repoPath (cross-platform normalized) → sessionId.
 * Returns undefined when no agent matches.
 *
 * `agentType` disambiguates when several engines run in the SAME repo on the same
 * machine (e.g. a Claude cartridge and a Codex cartridge side by side): register
 * gives each engine its own row, so a machine+repo match alone is ambiguous and
 * would otherwise attach, say, a Codex transcript to the Claude agent. When
 * omitted, resolution is unchanged (first repo match wins) — so existing
 * single-engine callers keep their exact behavior.
 */
export function resolveAgentId(opts: {
  agentId?: string;
  machine?: string;
  repoPath?: string;
  sessionId?: string;
  agentType?: string;
}): string | undefined {
  const { agentId, machine, repoPath, sessionId, agentType } = opts;

  if (agentId) return agentId;

  if (machine && repoPath) {
    const normalizedIncoming = normalizeRepoPath(repoPath);
    const candidates = db
      .prepare('SELECT id, repo_path, agent_type FROM agents WHERE machine = ?')
      .all(machine) as { id: string; repo_path: string; agent_type: string }[];
    const sameRepo = candidates.filter((a) => normalizeRepoPath(a.repo_path) === normalizedIncoming);
    if (sameRepo.length) {
      const typed = agentType ? sameRepo.find((a) => a.agent_type === agentType) : undefined;
      return (typed || sameRepo[0]).id;
    }
  }

  if (sessionId) {
    const agent = db.prepare('SELECT id FROM agents WHERE session_id = ?').get(sessionId) as
      | { id: string }
      | undefined;
    if (agent) return agent.id;
  }

  return undefined;
}

/**
 * A live cartridge of a given engine (`agentType`) in `repoPath`, if one is
 * connected. Prefers non-offline and most-recently-seen. Used to resolve a
 * workflow step's declared engine (executor_config.agentType) to a concrete
 * cartridge at launch — so a template can say "this step runs on codex" and the
 * matching Codex cartridge in the repo is picked automatically.
 */
export function agentIdForRepoAndType(repoPath: string, agentType: string): string | undefined {
  const norm = normalizeRepoPath(repoPath);
  if (!norm) return undefined;
  const rows = db
    .prepare("SELECT id, repo_path FROM agents WHERE agent_type = ? ORDER BY (status != 'offline') DESC, last_seen DESC")
    .all(agentType) as { id: string; repo_path: string }[];
  return rows.find((a) => normalizeRepoPath(a.repo_path) === norm)?.id;
}

/**
 * Projects an agent "serves" — those whose primary_repo matches the agent's
 * repo_path (cross-platform normalized). This is the join used to hard-pin a
 * task to the cartridge an agent is working in: a task scoped to project P is
 * only claimable by an agent whose repo matches P's primary_repo.
 */
export function projectIdsForAgent(agentId: string): string[] {
  const agent = db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(agentId) as
    | { repo_path: string }
    | undefined;
  if (!agent) return [];
  const norm = normalizeRepoPath(agent.repo_path);
  if (!norm) return [];
  const projects = db.prepare("SELECT id, primary_repo FROM projects WHERE primary_repo != ''").all() as {
    id: string;
    primary_repo: string;
  }[];
  return projects.filter((p) => normalizeRepoPath(p.primary_repo) === norm).map((p) => p.id);
}

/**
 * Agents whose repo matches the given repo path (cross-platform normalized).
 * Inverse of projectIdsForAgent — used to roll real session_usage cost from
 * agents up to the project/goal that owns their cartridge.
 */
export function agentIdsForRepo(repoPath: string): string[] {
  const norm = normalizeRepoPath(repoPath);
  if (!norm) return [];
  const agents = db.prepare("SELECT id, repo_path FROM agents WHERE repo_path != ''").all() as {
    id: string;
    repo_path: string;
  }[];
  return agents.filter((a) => normalizeRepoPath(a.repo_path) === norm).map((a) => a.id);
}

/**
 * Agents that "serve" a project — those whose repo matches the project's
 * primary_repo (cross-platform normalized). Used to find a connected terminal to
 * push a task's prompt into when auto- or manually dispatching a pinned task.
 */
export function agentIdsForProject(projectId: string): string[] {
  const project = db.prepare('SELECT primary_repo FROM projects WHERE id = ?').get(projectId) as
    | { primary_repo: string }
    | undefined;
  if (!project || !project.primary_repo) return [];
  return agentIdsForRepo(project.primary_repo);
}
