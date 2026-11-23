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
 *   a PR           when the pipeline finishes: work the agents left uncommitted is committed, the
 *                  branch is pushed and a PR opened into the base (with the feature's verdict),
 *                  naming its sibling PRs in the other repos. Nothing is merged yet: it is for review.
 *   the merge      when the person marks the feature DONE (any road — the runner's shipOnDone), or
 *                  presses Merge: every repo's PR is checked mergeable FIRST — none is merged unless
 *                  all can be — then merged, the base checkout fast-forwarded when it is clean, and
 *                  the workspace cleaned up. "I'll merge it myself" (mergeMyself) on the done step
 *                  leaves the PRs open instead.
 *   cleanup        ends the worktree's cartridge (and forgets it), removes the worktree, deletes the
 *                  branch locally and on origin. A PR merged on GitHub instead is noticed by
 *                  syncMergedWorkspaces (the pilot sweep) and cleaned up the same way.
 */
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import db from '../db.js';
import { createWorktree, forgetWorktree } from './worktree.js';
import { deleteAgentCascade } from './agent-cleanup.js';
import { storedGoalReport } from './goal-pilot-report.js';
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

/** "I'll merge it myself", or not, for a feature with its own worktrees. False: it has none. */
export function setMergeMyself(pilotId: string, on: boolean): boolean {
  const ws = getPilot(pilotId)?.workspace;
  if (!ws) return false;
  ws.mergeMyself = on;
  save(pilotId, ws);
  return true;
}

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
  const out: FeatureWorkspace = { branch, repos: [], prsAt: null, mergedAt: null, cleanedAt: null };
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
  const report = storedGoalReport(pilotId);
  const verdict = report?.acceptance?.total
    ? `Verdict: **${report.status}** — ${report.acceptance.passing} of ${report.acceptance.total} acceptance criteria pass on NeonCore's own check.`
    : report ? `Verdict: **${report.status}**.` : '';
  const summary = [pilot.plan?.brief?.summary || '', verdict].filter(Boolean).join('\n\n');

  for (const r of ws.repos) {
    if (r.removed) continue;
    r.error = '';
    try {
      // Finish the job: what the agents left uncommitted is the feature's work too. NeonCore's own
      // scratch (.neoncore/) never goes in; .gitignore is respected as always.
      if (await git(r.worktreePath, 'status', '--porcelain', '--', '.', ':!.neoncore')) {
        await git(r.worktreePath, 'add', '-A', '--', '.', ':!.neoncore');
        if (await git(r.worktreePath, 'diff', '--cached', '--name-only')) {
          await git(r.worktreePath, 'commit', '-m', `${title}: finish the feature`, '-m', `Work the pipeline left uncommitted on ${ws.branch}, committed by NeonCore before opening the PR.`);
        }
      }
      const dirty = await git(r.worktreePath, 'status', '--porcelain', '--', '.', ':!.neoncore');
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
      if (dirty) r.error = 'some changes could not be committed — they are not in the PR';
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
    // End the cartridge's session first: a Claude session left running in a deleted folder is a
    // ghost — and its record goes with the folder, so the fleet does not list a cartridge for a
    // path that no longer exists.
    const agentId = agentIdForRepoAndType(r.worktreePath, r.agentType);
    if (agentId) {
      try { sendCommandToAgent(agentId, '/exit', false, undefined, { standard: false, trackObjective: false }); } catch { /* already gone */ }
      try { deleteAgentCascade(agentId); } catch (err) { console.warn('[feature-workspace] could not forget the worktree cartridge:', err); }
    }
    try {
      // Once merged, what is still in the folder is scratch (the PR has the work): removed regardless.
      const force = opts.force || r.pr?.state === 'merged';
      if (fs.existsSync(r.worktreePath)) await git(r.repoPath, 'worktree', 'remove', ...(force ? ['--force'] : []), r.worktreePath);
      else await git(r.repoPath, 'worktree', 'prune');   // already deleted by hand: drop git's record of it
      forgetWorktree(r.worktreePath);
      if (r.pr?.state === 'merged') {
        // Merged: the branch has nothing left to give — locally (-D: a squash merge leaves it
        // "unmerged" to git) and on origin (GitHub may have deleted it already).
        try { await git(r.repoPath, 'branch', '-D', ws.branch); } catch { /* not there */ }
        try { await git(r.repoPath, 'push', 'origin', '--delete', ws.branch); } catch { /* already gone */ }
      }
      r.removed = true;
    } catch (err) {
      r.error = firstLine(err);
    }
  }
  if (ws.repos.every((r) => r.removed)) ws.cleanedAt = new Date().toISOString();
  save(pilotId, ws);
  return ws;
}

/** One repo's PR as GitHub sees it now: open/merged/closed and, when open, whether it can merge. */
async function prStatus(cwd: string, branch: string): Promise<{ state: string; mergeable: string; mergeState: string; url: string; number: number } | null> {
  try {
    const j = JSON.parse(await gh(cwd, 'pr', 'view', branch, '--json', 'url,number,state,mergeable,mergeStateStatus')) as Record<string, unknown>;
    return j?.url ? {
      url: String(j.url), number: Number(j.number) || 0, state: String(j.state || '').toLowerCase(),
      mergeable: String(j.mergeable || '').toUpperCase(), mergeState: String(j.mergeStateStatus || '').toUpperCase(),
    } : null;
  } catch { return null; }
}

/** Why GitHub will not merge it, in words a person can act on ('' = it can merge). */
function blockedReason(p: { mergeable: string; mergeState: string }): string {
  if (p.mergeable === 'CONFLICTING' || p.mergeState === 'DIRTY') return 'it conflicts with the base branch — resolve the conflicts first';
  if (p.mergeState === 'BLOCKED') return 'GitHub blocks it (a required review or check is missing)';
  if (p.mergeState === 'BEHIND') return 'it is behind the base branch and the repo requires it to be up to date';
  if (p.mergeState === 'UNSTABLE') return '';   // non-required checks failing: mergeable
  if (p.mergeable === 'UNKNOWN') return 'GitHub is still working out whether it can merge — try again in a moment';
  return '';
}

/** Bring the person's own checkout of the base up to date — only when it is on the base and clean. */
async function fastForwardBase(repo: string, base: string): Promise<void> {
  try {
    if (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') !== base) return;
    if (await git(repo, 'status', '--porcelain', '--untracked-files=no')) return;
    await git(repo, 'pull', '--ff-only', 'origin', base);
  } catch { /* their checkout, their call: never forced */ }
}

const merging = new Set<string>();

/**
 * THE PERSON SAID MERGE. Every open PR of the feature is checked first: if any cannot merge, none is
 * merged (the repos of one feature go in together) and each says why. Then each is merged (squash,
 * else a merge commit, else a rebase — whichever the repo allows), the base checkouts are
 * fast-forwarded, and the workspace is cleaned up.
 */
export async function mergeFeaturePRs(pilotId: string): Promise<FeatureWorkspace | null> {
  const pilot = getPilot(pilotId);
  const ws = pilot?.workspace;
  if (!pilot || !ws) return null;
  if (merging.has(pilotId)) return ws;
  merging.add(pilotId);
  try {
    const live = ws.repos.filter((r) => !r.removed);
    const statuses = new Map<string, Awaited<ReturnType<typeof prStatus>>>();
    for (const r of live) {
      r.error = '';
      const st = await prStatus(r.worktreePath, ws.branch);
      statuses.set(r.repoPath, st);
      if (st) r.pr = { url: st.url, number: st.number, state: st.state };
    }
    const toMerge = live.filter((r) => statuses.get(r.repoPath)?.state === 'open');
    let blocked = false;
    for (const r of toMerge) {
      const why = blockedReason(statuses.get(r.repoPath)!);
      if (why) { r.error = `not merged: ${why}`; blocked = true; }
    }
    if (!toMerge.length && !live.some((r) => r.pr?.state === 'merged')) {
      for (const r of live) if (!r.error) r.error = r.pr ? `its PR is ${r.pr.state} — nothing to merge` : 'it has no PR — nothing to merge';
      save(pilotId, ws);
      return ws;
    }
    if (blocked) {
      for (const r of toMerge) if (!r.error) r.error = 'not merged: waiting for the other repos of this feature to be mergeable';
      save(pilotId, ws);
      return ws;
    }
    for (const r of toMerge) {
      let lastErr = '';
      for (const how of ['--squash', '--merge', '--rebase']) {
        try { await gh(r.worktreePath, 'pr', 'merge', ws.branch, how); lastErr = ''; break; } catch (err) {
          lastErr = firstLine(err);
          if (!/not allowed|merge method|is not enabled/i.test(lastErr)) break;   // a real failure: do not try another method
        }
      }
      if (lastErr) { r.error = `the merge failed: ${lastErr}`; continue; }
      r.pr = { ...(r.pr ?? { url: '', number: 0 }), state: 'merged' };
      await fastForwardBase(r.repoPath, r.base);
    }
    ws.mergedAt = ws.repos.every((r) => r.removed || r.pr?.state === 'merged') ? new Date().toISOString() : ws.mergedAt ?? null;
    save(pilotId, ws);
    const merged = ws.repos.filter((r) => !r.removed && r.pr?.state === 'merged').map((r) => r.repoPath);
    return merged.length ? await cleanupWorkspace(pilotId, { only: merged }) : ws;
  } finally {
    merging.delete(pilotId);
  }
}

/**
 * A PR merged (or closed) on GitHub instead of from NeonCore: noticed here, and a merged one is
 * cleaned up the same way. Run by the pilot sweep; returns the pilots it cleaned up. At most one gh
 * call per open PR per run, and only for features whose PRs are out and not yet cleaned up.
 */
export async function syncMergedWorkspaces(): Promise<string[]> {
  const cleaned: string[] = [];
  const rows = db.prepare("SELECT id FROM goal_pilots WHERE workspace != '' AND workspace LIKE '%\"prsAt\":\"%'").all() as { id: string }[];
  for (const { id } of rows) {
    const ws = getPilot(id)?.workspace;
    if (!ws || merging.has(id)) continue;
    const pending = ws.repos.filter((r) => !r.removed && r.pr && r.pr.state !== 'closed');
    if (!pending.length) continue;
    let changed = false;
    for (const r of pending) {
      const st = await prStatus(fs.existsSync(r.worktreePath) ? r.worktreePath : r.repoPath, ws.branch);
      if (st && st.state !== r.pr!.state) { r.pr = { url: st.url, number: st.number, state: st.state }; changed = true; }
    }
    if (!changed) continue;
    save(id, ws);
    const merged = ws.repos.filter((r) => !r.removed && r.pr?.state === 'merged').map((r) => r.repoPath);
    if (merged.length) {
      if (ws.repos.every((r) => r.removed || r.pr?.state === 'merged')) { ws.mergedAt = new Date().toISOString(); save(id, ws); }
      for (const r of ws.repos.filter((x) => merged.includes(x.repoPath))) await fastForwardBase(r.repoPath, r.base);
      await cleanupWorkspace(id, { only: merged });
      cleaned.push(id);
    }
  }
  return cleaned;
}
