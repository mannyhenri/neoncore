import { execFileSync } from 'child_process';
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
  /** Where a NEW branch starts (e.g. 'main'); absent = the repo's current HEAD. */
  base?: string,
): { path: string; branch: string } {
  const repoName = path.basename(repoPath);
  const sanitizedBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const targetPath = path.resolve(repoPath, worktreePath || path.join('..', `${repoName}-${sanitizedBranch}`));

  if (fs.existsSync(targetPath)) return { path: targetPath, branch };
  // Arguments, never a shell string: the branch and path can come from a request body. A leading
  // '-' would be read as an option.
  if (branch.startsWith('-')) throw new Error(`invalid branch name: ${branch}`);
  const opts = { cwd: repoPath, timeout: 30000, encoding: 'utf-8' as const, stdio: 'pipe' as const };

  try {
    execFileSync('git', ['worktree', 'add', targetPath, branch], opts);
  } catch {
    if (base?.startsWith('-')) throw new Error(`invalid base: ${base}`);
    execFileSync('git', ['worktree', 'add', '-b', branch, targetPath, ...(base ? [base] : [])], opts);
  }
  return { path: targetPath, branch };
}
