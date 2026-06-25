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
 */
export function resolveAgentId(opts: {
  agentId?: string;
  machine?: string;
  repoPath?: string;
  sessionId?: string;
}): string | undefined {
  const { agentId, machine, repoPath, sessionId } = opts;

  if (agentId) return agentId;

  if (machine && repoPath) {
    const normalizedIncoming = normalizeRepoPath(repoPath);
    const candidates = db
      .prepare('SELECT id, repo_path FROM agents WHERE machine = ?')
      .all(machine) as { id: string; repo_path: string }[];
    const match = candidates.find((a) => normalizeRepoPath(a.repo_path) === normalizedIncoming);
    if (match) return match.id;
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
