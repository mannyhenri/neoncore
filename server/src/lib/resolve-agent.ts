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
