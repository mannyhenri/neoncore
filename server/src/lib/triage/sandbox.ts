/**
 * THE PER-ISSUE SANDBOX — a git worktree on branch bug/<KEY> with its own cartridge (the
 * machinery of lib/feature-workspace.ts), and the commands the SERVER runs there itself: the
 * reproduction (must fail twice before the fix, pass after), the full suite, the diff the
 * guardrails read, and the PR through `gh`. Every side effect is injectable so tests run none.
 *
 * Honest limit (docs/plans/bug-triage.md): a worktree does not restrict the network. The
 * prompts forbid production access and the cartridge is launched with no production credentials.
 */
import fs from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { createWorktree } from '../worktree.js';
import { defaultBranchOf } from '../feature-workspace.js';
import { openDirectory } from '../open-directory.js';
import { agentIdForRepoAndType } from '../resolve-agent.js';

const run = promisify(execFile);
const runShell = promisify(exec);

export interface Workspace { worktreePath: string; branch: string; base: string }
export interface CommandResult { code: number; output: string }

export interface SandboxOps {
  /** Make the worktree on `branch` from the repo's default branch. */
  createWorkspace(repoPath: string, branch: string): Workspace;
  /** Open a cartridge in the worktree; an error string, or null. */
  launch(worktreePath: string, agentType: string): string | null;
  /** The cartridge registered for that folder, once it has. */
  agentFor(worktreePath: string, agentType: string): string | undefined;
  /** Run a shell command in the worktree (repro, suite). */
  runCommand(cwd: string, command: string, timeoutMs: number): Promise<CommandResult>;
  /** The fix's diff against the base, untracked files included. */
  diff(cwd: string, base: string): Promise<string>;
  /** Commit what is uncommitted, push the branch, open the PR; its URL. */
  openPr(cwd: string, input: { base: string; branch: string; title: string; body: string }): Promise<string>;
  /** The PR's review state. */
  prState(cwd: string, prUrl: string): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; reviewDecision: string; mergeCommit: string; reviewComments: string[] }>;
  /** Is `commit` in a release (a tag contains it)? */
  isReleased(cwd: string, commit: string): Promise<boolean>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: process.env });
  return stdout.trim();
}

/**
 * The environment a sandbox command runs with: what a test suite needs to find its tools, and
 * NOTHING of the server's own. The repro and suite commands are written by a cartridge — possibly
 * steered by a ticket — so they must not inherit the Jira token, the fleet token, provider keys or
 * any other secret in the server's environment (the scope's guardrail: the sandbox has no
 * production credentials). It also keeps a test runner's own context (NODE_TEST_CONTEXT) out, which
 * made a failing reproduction report success. `gh` is different: the server builds its arguments
 * and it needs the operator's login.
 */
export const SANDBOX_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'TERM'] as const;
export function sandboxEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1' };
  for (const k of SANDBOX_ENV_KEYS) if (from[k] !== undefined) env[k] = from[k];
  return env;
}

export const realSandbox: SandboxOps = {
  createWorkspace(repoPath, branch) {
    if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error(`${repoPath} is not a git repository`);
    const base = defaultBranchOf(repoPath);
    const { path: worktreePath } = createWorktree(repoPath, branch, undefined, base);
    return { worktreePath, branch, base };
  },
  launch(worktreePath, agentType) { return openDirectory(worktreePath, `${agentType}-cli`); },
  agentFor(worktreePath, agentType) { return agentIdForRepoAndType(worktreePath, agentType); },
  async runCommand(cwd, command, timeoutMs) {
    try {
      const { stdout, stderr } = await runShell(command, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: sandboxEnv() });
      return { code: 0, output: `${stdout}${stderr}`.slice(-8000) };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      return { code: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.slice(-8000) };
    }
  },
  async diff(cwd, base) {
    // Untracked files show up as additions: intent-to-add, then diff, then undo the intent.
    const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean);
    if (untracked.length) await git(cwd, 'add', '-N', '--', ...untracked);
    try {
      return await git(cwd, 'diff', base, '--');
    } finally {
      if (untracked.length) await git(cwd, 'reset', '-q', '--', ...untracked).catch(() => '');
    }
  },
  async openPr(cwd, input) {
    if ((await git(cwd, 'status', '--porcelain')).length > 0) {
      await git(cwd, 'add', '-A');
      await git(cwd, 'commit', '-m', input.title);
    }
    await git(cwd, 'push', '-u', 'origin', input.branch);
    const reviewers = codeOwners(cwd);
    const args = ['pr', 'create', '--base', input.base, '--head', input.branch, '--title', input.title, '--body', input.body];
    for (const r of reviewers) args.push('--reviewer', r);
    try {
      return (await gh(cwd, ...args)).split('\n').pop() ?? '';
    } catch (err) {
      if (reviewers.length === 0) throw err;
      // A CODEOWNERS entry gh cannot request (a team it cannot see): open it without reviewers.
      return (await gh(cwd, 'pr', 'create', '--base', input.base, '--head', input.branch, '--title', input.title, '--body', input.body)).split('\n').pop() ?? '';
    }
  },
  async prState(cwd, prUrl) {
    const j = JSON.parse(await gh(cwd, 'pr', 'view', prUrl, '--json', 'state,reviewDecision,mergeCommit,reviews')) as {
      state: 'OPEN' | 'MERGED' | 'CLOSED'; reviewDecision?: string; mergeCommit?: { oid?: string }; reviews?: { state?: string; body?: string }[];
    };
    return {
      state: j.state, reviewDecision: j.reviewDecision ?? '', mergeCommit: j.mergeCommit?.oid ?? '',
      reviewComments: (j.reviews ?? []).filter((r) => r.state === 'CHANGES_REQUESTED' && r.body).map((r) => String(r.body)),
    };
  },
  async isReleased(cwd, commit) {
    if (!commit) return false;
    await git(cwd, 'fetch', '--tags', '--quiet').catch(() => '');
    return (await git(cwd, 'tag', '--contains', commit).catch(() => '')).length > 0;
  },
};

/** The reviewers CODEOWNERS names for the whole repo (`*` rule), as gh takes them. */
export function codeOwners(cwd: string): string[] {
  for (const f of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const p = path.join(cwd, f);
    if (!fs.existsSync(p)) continue;
    const star = fs.readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('* '));
    const last = star.pop();
    return last ? last.split(/\s+/).slice(1).map((o) => o.replace(/^@/, '')).filter(Boolean) : [];
  }
  return [];
}

let ops: SandboxOps = realSandbox;
export function setSandbox(o: Partial<SandboxOps> | null): void { ops = o ? { ...realSandbox, ...o } : realSandbox; }
export const sandbox = (): SandboxOps => ops;
