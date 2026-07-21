import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Create (or reuse) a git worktree for `branch` off `repoPath`.
 *
 * Tries an existing branch first, then creates a new one — mirroring what the
 * `/api/git/:agentId/worktrees` route did inline, now shared so the workflow
 * executor can give each step its own branch. Idempotent: if the target
 * directory already exists it's returned as-is, so a looped/re-run step doesn't
 * fail on "worktree already exists". Throws on genuine git failure; the caller
 * decides how loud that is.
 */
export function createWorktree(
  repoPath: string,
  branch: string,
  worktreePath?: string,
): { path: string; branch: string } {
  const repoName = path.basename(repoPath);
  const sanitizedBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const targetPath = worktreePath || path.join(path.dirname(repoPath), `${repoName}-${sanitizedBranch}`);

  if (fs.existsSync(targetPath)) return { path: targetPath, branch };

  try {
    execSync(`git worktree add "${targetPath}" "${branch}"`, { cwd: repoPath, timeout: 30000, encoding: 'utf-8' });
  } catch {
    execSync(`git worktree add -b "${branch}" "${targetPath}"`, { cwd: repoPath, timeout: 30000, encoding: 'utf-8' });
  }
  return { path: targetPath, branch };
}
