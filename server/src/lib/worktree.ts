import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { normalizeRepoPath } from './resolve-agent.js';

/**
 * EVERY WORKTREE NEONCORE MAKES IS RECORDED HERE — the one place they are made (a feature's
 * workspace, Confer, a workflow step, a Triage issue, the dashboard's "new worktree"). A cartridge
 * that first registers in one starts in TRUST mode (routes/agents.ts register): it was launched by
 * NeonCore for NeonCore's work, and stopping it for a person on every command is what made a
 * feature's own cartridges need their mode switched by hand. `worktree_cartridges_trust` = '0' in
 * settings turns that off; absent means on.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS neoncore_worktrees (
    path TEXT PRIMARY KEY,           -- normalized (resolve-agent normalizeRepoPath)
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
export const WORKTREE_TRUST_SETTING = 'worktree_cartridges_trust';

function record(targetPath: string, repoPath: string, branch: string): void {
  db.prepare('INSERT OR IGNORE INTO neoncore_worktrees (path, repo_path, branch, created_at) VALUES (?, ?, ?, ?)')
    .run(normalizeRepoPath(targetPath), repoPath, branch, new Date().toISOString());
}

/** Was this folder made by NeonCore as a worktree? */
export function isNeoncoreWorktree(dir: string): boolean {
  return !!dir && !!db.prepare('SELECT 1 FROM neoncore_worktrees WHERE path = ?').get(normalizeRepoPath(dir));
}

/** The worktree was removed: a later folder at the same path is not NeonCore's unless made again. */
export function forgetWorktree(dir: string): void {
  db.prepare('DELETE FROM neoncore_worktrees WHERE path = ?').run(normalizeRepoPath(dir));
}

/** Should a cartridge registering for the first time in `dir` start in trust? */
export function startsTrusted(dir: string): boolean {
  const v = (db.prepare('SELECT value FROM settings WHERE key = ?').get(WORKTREE_TRUST_SETTING) as { value?: string } | undefined)?.value;
  return v !== '0' && isNeoncoreWorktree(dir);
}

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

  if (fs.existsSync(targetPath)) { record(targetPath, repoPath, branch); return { path: targetPath, branch }; }
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
  record(targetPath, repoPath, branch);
  return { path: targetPath, branch };
}
