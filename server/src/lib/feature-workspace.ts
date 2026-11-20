/**
 * FEATURES THAT RUN SIDE BY SIDE — a branch and a worktree per repo, a cartridge per worktree, a PR
 * per repo at the end.
 *
 * A cartridge works one thing at a time, in one folder. Two features on the same repos therefore
 * used to take turns on the one cartridge per repo, and edit the same checkout. A feature started
 * with its own workspace instead gets, in every repo it involves:
 *
 *   a branch       feature/<slug>, started from the repo's default branch (origin/HEAD, else main)
 *   a worktree     ../<repo>-feature-<slug>, checked out on that branch
 *   a cartridge    launched in the worktree (the same launcher as New Repo); it registers under the
 *                  worktree's path, so every stage, test and review of this feature reaches it and
 *                  no other feature's work does
 *   a PR           when the pipeline finishes: the branch is pushed and a PR opened into the base,
 *                  naming its sibling PRs in the other repos. Never merged here — a person merges.
 *
 * Cleanup (after a merge) ends the cartridge's session and removes the worktree.
 */
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import db from '../db.js';
import { createWorktree } from './worktree.js';
import { openDirectory } from './open-directory.js';
import { normalizeRepoPath, agentIdForRepoAndType } from './resolve-agent.js';
import { sendCommandToAgent } from './send-command.js';
import { getPilot, slugify, type GoalPilot, type FeatureWorkspace } from './goal-pilot.js';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

/** Opens a cartridge in a folder; returns an error string or null. Swappable so tests open no terminals. */
type Launcher = (dir: string, agentType: string) => string | null;
let launcher: Launcher = (dir, agentType) => openDirectory(dir, `${agentType}-cli`);
export function setWorkspaceLauncher(fn: Launcher): void { launcher = fn; }

function save(pilotId: string, ws: FeatureWorkspace): void {
  db.prepare('UPDATE goal_pilots SET workspace = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ws), new Date().toISOString(), pilotId);
}

/** Every worktree any feature uses — never offered as a repo to build in. */
export function featureWorktreePaths(): Set<string> {
  const out = new Set<string>();
  for (const r of db.prepare("SELECT workspace FROM goal_pilots WHERE workspace != ''").all() as { workspace: string }[]) {
    try {
      for (const x of (JSON.parse(r.workspace) as FeatureWorkspace).repos ?? []) out.add(normalizeRepoPath(x.worktreePath));
    } catch { /* a corrupt row offers nothing */ }
  }
  return out;
}

/** The branch a feature works on: feature/<slug>, with a suffix when another feature already uses that name. */
export function featureBranchFor(pilot: GoalPilot): string {
  const goal = db.prepare('SELECT name FROM goals WHERE id = ?').get(pilot.goalId) as { name?: string } | undefined;
  const slug = slugify(pilot.plan?.brief?.slug || goal?.name || '') || pilot.id.slice(0, 8);
  const taken = new Set((db.prepare("SELECT id, workspace FROM goal_pilots WHERE workspace != '' AND id != ?").all(pilot.id) as { workspace: string }[])
    .map((r) => { try { return (JSON.parse(r.workspace) as FeatureWorkspace).branch; } catch { return ''; } }));
  const branch = `feature/${slug}`;
  return taken.has(branch) ? `${branch}-${pilot.id.slice(0, 6)}` : branch;
}

/** The branch a new feature starts from: what origin calls HEAD, else main / master, else what is checked out. */
export function defaultBranchOf(repo: string): string {
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 }).trim();
  try { return g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, ''); } catch { /* no origin HEAD */ }
  for (const b of ['main', 'master']) {
    try { g('rev-parse', '--verify', '--quiet', `refs/heads/${b}`); return b; } catch { /* not this one */ }
  }
  return g('rev-parse', '--abbrev-ref', 'HEAD');
}

/**
 * A worktree on the feature's branch in every repo. Returns the workspace (not saved — the caller
 * writes it with the stages, in one transaction). Throws with a message a person can act on.
 */
export function createFeatureWorkspace(pilot: GoalPilot, repos: { repoPath: string; agentType: string }[]): FeatureWorkspace {
  const branch = featureBranchFor(pilot);
  const out: FeatureWorkspace = { branch, repos: [], prsAt: null };
  for (const r of repos) {
    if (!fs.existsSync(path.join(r.repoPath, '.git'))) {
      throw new Error(`${path.basename(r.repoPath)} is not a git repository, so it cannot get its own branch — untick "own branch" to run the feature in place`);
    }
    const base = defaultBranchOf(r.repoPath);
    let worktreePath: string;
    try {
      ({ path: worktreePath } = createWorktree(r.repoPath, branch, undefined, base));
    } catch (err) {
      throw new Error(`could not create the ${branch} worktree in ${path.basename(r.repoPath)}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    out.repos.push({ repoPath: r.repoPath, worktreePath, agentType: r.agentType, base, pr: null, error: '', removed: false });
  }
  return out;
}

/** Open a cartridge in every worktree that has none live. Returns what could not be launched. */
export function launchWorkspaceCartridges(ws: FeatureWorkspace): string[] {
  const problems: string[] = [];
  for (const r of ws.repos) {
    if (r.removed) continue;
    const live = agentIdForRepoAndType(r.worktreePath, r.agentType);
    const status = live ? (db.prepare('SELECT status FROM agents WHERE id = ?').get(live) as { status?: string } | undefined)?.status : '';
    if (live && status !== 'offline') continue;
    const err = launcher(r.worktreePath, r.agentType);
    if (err) problems.push(`${path.basename(r.worktreePath)}: ${err}`);
  }
  return problems;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: process.env });
  return stdout.trim();
}
const firstLine = (err: unknown) => (err instanceof Error ? ((err as { stderr?: string }).stderr || err.message) : String(err)).trim().split('\n')[0];

/** The PR for `branch` in this repo, if one exists. */
async function existingPr(cwd: string, branch: string): Promise<{ url: string; number: number; state: string } | null> {
  try {
    const j = JSON.parse(await gh(cwd, 'pr', 'view', branch, '--json', 'url,number,state')) as { url: string; number: number; state: string };
    return j?.url ? { url: j.url, number: j.number, state: String(j.state || '').toLowerCase() } : null;
  } catch { return null; }
}

/**
 * Push the feature's branch and open a PR into its base, in every repo that has commits on it.
 * Idempotent: a repo that already has its PR keeps it. A repo with nothing on the branch is named,
 * not given an empty PR. Uncommitted changes in a worktree are reported, never committed for the agent.
 */
export async function openFeaturePRs(pilotId: string): Promise<FeatureWorkspace | null> {
  const pilot = getPilot(pilotId);
  const ws = pilot?.workspace;
  if (!pilot || !ws) return null;
  const goal = db.prepare('SELECT name FROM goals WHERE id = ?').get(pilot.goalId) as { name?: string } | undefined;
  const title = goal?.name || ws.branch;
  const summary = pilot.plan?.brief?.summary || '';

  for (const r of ws.repos) {
    if (r.removed) continue;
    r.error = '';
    try {
      const dirty = await git(r.worktreePath, 'status', '--porcelain');
      const ahead = Number(await git(r.worktreePath, 'rev-list', '--count', `${r.base}..HEAD`)) || 0;
      if (ahead === 0) {
        r.error = `no commits on ${ws.branch} — nothing to merge${dirty ? ' (there are uncommitted changes in the worktree)' : ''}`;
        continue;
      }
      await git(r.worktreePath, 'push', '-u', 'origin', ws.branch);
      r.pr = (await existingPr(r.worktreePath, ws.branch)) ?? r.pr;
      if (!r.pr) {
        const url = await gh(r.worktreePath, 'pr', 'create', '--base', r.base, '--head', ws.branch, '--title', title,
          '--body', [summary, '', `Built by the NeonCore feature pipeline on \`${ws.branch}\`.`].join('\n').trim());
        const m = url.match(/https?:\/\/\S+/);
        r.pr = { url: m ? m[0] : url, number: Number(url.match(/\/(\d+)\s*$/)?.[1] ?? 0), state: 'open' };
      }
      if (dirty) r.error = 'uncommitted changes were left in the worktree — they are not in the PR';
    } catch (err) {
      r.error = firstLine(err);
    }
  }

  // Each PR names its siblings, so a reviewer merging one knows the others belong with it.
  const opened = ws.repos.filter((r) => r.pr && !r.removed);
  if (opened.length > 1) {
    for (const r of opened) {
      const others = opened.filter((o) => o !== r).map((o) => `- ${path.basename(o.repoPath)}: ${o.pr!.url}`);
      try {
        await gh(r.worktreePath, 'pr', 'edit', ws.branch, '--body',
          [summary, '', `Built by the NeonCore feature pipeline on \`${ws.branch}\`.`, '', 'Part of the same feature — merge together:', ...others].join('\n').trim());
      } catch { /* the PR stands without the cross-links */ }
    }
  }
  ws.prsAt = new Date().toISOString();
  save(pilotId, ws);
  return ws;
}

/**
 * After a merge: end each worktree's cartridge session and remove the worktree. A repo whose PR is
 * not merged is left alone unless `force`. `only` limits it to some repos (real repo paths).
 */
export async function cleanupWorkspace(pilotId: string, opts: { force?: boolean; only?: string[] } = {}): Promise<FeatureWorkspace | null> {
  const pilot = getPilot(pilotId);
  const ws = pilot?.workspace;
  if (!pilot || !ws) return null;
  const only = opts.only ? new Set(opts.only.map(normalizeRepoPath)) : null;
  for (const r of ws.repos) {
    if (r.removed || (only && !only.has(normalizeRepoPath(r.repoPath)))) continue;
    r.error = '';
    const pr = await existingPr(r.worktreePath, ws.branch);
    if (pr) r.pr = pr;
    if (!opts.force && r.pr?.state !== 'merged') {
      r.error = r.pr ? `its PR is ${r.pr.state || 'open'} — merge it first (or clean up anyway)` : 'it has no PR — open one first (or clean up anyway)';
      continue;
    }
    // End the cartridge's session first: a Claude session left running in a deleted folder is a ghost.
    const agentId = agentIdForRepoAndType(r.worktreePath, r.agentType);
    if (agentId) { try { sendCommandToAgent(agentId, '/exit', false, undefined, { standard: false, trackObjective: false }); } catch { /* already gone */ } }
    try {
      await git(r.repoPath, 'worktree', 'remove', ...(opts.force ? ['--force'] : []), r.worktreePath);
      if (r.pr?.state === 'merged') { try { await git(r.repoPath, 'branch', '-d', ws.branch); } catch { /* kept if git disagrees */ } }
      r.removed = true;
    } catch (err) {
      r.error = firstLine(err);
    }
  }
  save(pilotId, ws);
  return ws;
}
