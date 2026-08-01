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

/** The columns disambiguation needs. Kept structural so it can be unit-tested with no db. */
export interface AgentCandidate {
  id: string;
  repo_path: string;
  agent_type: string;
  session_id: string;
}

/**
 * The default engine when a caller omits `agentType`. MUST match the default in
 * `routes/agents.ts` register (`agentType || 'claude'`) — the two disagreeing is
 * exactly the bug this exists to prevent: register created the Claude row, while
 * activity resolved the same untyped payload to whichever row was inserted first.
 */
export const DEFAULT_AGENT_TYPE = 'claude';

/**
 * Pick one cartridge when several engines share a machine+repo (e.g. a Claude
 * cartridge and a Codex cartridge side by side in one checkout).
 *
 * Precedence, most specific first:
 *   1. explicit `agentType` — the documented disambiguator
 *   2. exact `sessionId` — identity, so it beats any guess
 *   3. `DEFAULT_AGENT_TYPE` when the caller sent no agentType at all
 *   4. first row — unchanged last resort
 *
 * Step 3 is the fix: without it an untyped payload fell straight to step 4, which
 * is `SELECT ... WHERE machine = ?` with no ORDER BY — i.e. insertion order. A repo
 * whose Codex row was created before its Claude row silently attributed every
 * untyped Claude event to Codex.
 */
export function pickAgentCandidate(
  candidates: AgentCandidate[],
  opts: { agentType?: string; sessionId?: string } = {},
): AgentCandidate | undefined {
  if (candidates.length <= 1) return candidates[0];
  const { agentType, sessionId } = opts;

  if (agentType) {
    const typed = candidates.find((a) => a.agent_type === agentType);
    if (typed) return typed;
  }
  if (sessionId) {
    const bySession = candidates.find((a) => a.session_id === sessionId);
    if (bySession) return bySession;
  }
  if (!agentType) {
    const byDefault = candidates.find((a) => a.agent_type === DEFAULT_AGENT_TYPE);
    if (byDefault) return byDefault;
  }
  return candidates[0];
}

/**
 * Resolve an agent id from any of the identifiers hooks/extensions send.
 * Order: explicit agentId → machine + repoPath (cross-platform normalized) → sessionId.
 * Returns undefined when no agent matches.
 *
 * When several engines share the repo, `pickAgentCandidate` decides which one —
 * see its precedence rules. Single-engine callers are unaffected: one candidate
 * always resolves to itself.
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
      .prepare('SELECT id, repo_path, agent_type, session_id FROM agents WHERE machine = ?')
      .all(machine) as AgentCandidate[];
    const sameRepo = candidates.filter((a) => normalizeRepoPath(a.repo_path) === normalizedIncoming);
    if (sameRepo.length) {
      return pickAgentCandidate(sameRepo, { agentType, sessionId })!.id;
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
 * Projects a cartridge serves — every project that lists its repo.
 *
 * MANY, not one: a monorepo legitimately serves several projects, and forcing a single owner
 * would make the second one silently lose all its work. Paths are normalised the same way the
 * rest of resolution normalises them, so a trailing slash or a case difference never quietly
 * unlinks a project from its own cartridge.
 */
export function projectsForAgent(agentId: string): string[] {
  const agent = db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(agentId) as
    | { repo_path: string }
    | undefined;
  if (!agent) return [];
  const norm = normalizeRepoPath(agent.repo_path);
  if (!norm) return [];
  const rows = db.prepare('SELECT project_id, repo_path FROM project_cartridges').all() as {
    project_id: string;
    repo_path: string;
  }[];
  return [...new Set(
    rows.filter((r) => normalizeRepoPath(r.repo_path) === norm).map((r) => r.project_id),
  )];
}

/** Kept as the old name so existing callers do not change meaning under them. */
export const projectIdsForAgent = projectsForAgent;

/** The repos a project claims. */
export function getProjectCartridges(projectId: string): string[] {
  return (db.prepare('SELECT repo_path FROM project_cartridges WHERE project_id = ? ORDER BY repo_path')
    .all(projectId) as { repo_path: string }[]).map((r) => r.repo_path);
}

/**
 * REPLACE a project's cartridges. Replace rather than merge, because the UI sends the whole
 * set — an append would make removing a repo impossible without a second endpoint, and the
 * absence of a repo in the payload is exactly how a user says "not this one any more".
 */
export function setProjectCartridges(projectId: string, repoPaths: string[]): void {
  const tx = db.transaction((paths: string[]) => {
    db.prepare('DELETE FROM project_cartridges WHERE project_id = ?').run(projectId);
    const ins = db.prepare('INSERT OR IGNORE INTO project_cartridges (project_id, repo_path) VALUES (?, ?)');
    for (const p of paths) {
      const trimmed = (p || '').trim();
      if (trimmed) ins.run(projectId, trimmed);
    }
  });
  tx(repoPaths);
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
