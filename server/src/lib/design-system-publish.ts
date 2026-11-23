/**
 * STEP 2 OF A PROJECT'S DESIGN SYSTEM: FINALIZE IT, AND PUT IT IN EVERY REPO OF THE PROJECT.
 *
 *   finalizeProject   the selected direction → the full system (design-system-build.ts), kept with
 *                     the project with a version that goes up each time it is finalized again
 *   publishProject    that system → `design-system/` in each repo the project owns, plus a marked
 *                     block in the repo's CLAUDE.md (and AGENTS.md, where there is one) that tells
 *                     an agent to build with it — then ONE commit of exactly those files, pushed.
 *
 * What publishing does and does not do in a repo:
 *   · it writes only inside `design-system/` and the marked block; nothing else in the tree is touched
 *   · it commits only those paths — whatever else is modified or staged stays as it was, uncommitted
 *   · it commits on the branch that is checked out, and pushes it to its upstream, never forced
 *   · a repo with no upstream is committed and said to be local only; a push that is refused keeps
 *     the commit and says why; a folder that is not a git repo on this machine is said, and skipped
 *   · published again with nothing changed, a repo is left alone ("unchanged")
 *
 * One repo failing never stops the others: every repo gets its own line in the result.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getDesignSystem, keepServerPart, DesignSystemError, type Exploration, type FinalSystem, type RepoResult } from './design-system.js';
import { finalize, filesOf, withAgentBlock, DESIGN_DIR, type DesignSystemSpec, type DirectionTokens } from './design-system-build.js';

/** Every repo the project owns: its cartridges and its primary repo, each once, in a stable order. */
export function projectRepos(projectId: string): string[] {
  const primary = (db.prepare('SELECT primary_repo FROM projects WHERE id = ?').get(projectId) as { primary_repo?: string } | undefined)?.primary_repo ?? '';
  let owned: string[] = [];
  try { owned = (db.prepare('SELECT repo_path FROM project_cartridges WHERE project_id = ? ORDER BY repo_path').all(projectId) as { repo_path: string }[]).map((r) => r.repo_path); } catch { /* no such table on an old database */ }
  return [...new Set([primary, ...owned].map((p) => (p || '').replace(/\/+$/, '')).filter(Boolean))];
}

interface Variation { id: string; name: string; rationale?: string; tokens: DirectionTokens }
function selectedVariation(cur: Exploration): { roundId: string; variation: Variation } {
  if (!cur.selected) throw new DesignSystemError('Select a direction first — there is nothing to finalize');
  const round = (cur.rounds as { id: string; variations: Variation[] }[]).find((r) => r.id === cur.selected!.roundId);
  const variation = round?.variations.find((v) => v.id === cur.selected!.variationId);
  if (!round || !variation) throw new DesignSystemError('The selected direction is no longer among the rounds');
  return { roundId: round.id, variation };
}

/** The selected direction, finalized. Finalizing the same direction again changes nothing; a new one is the next version. */
export function finalizeProject(projectId: string, now = new Date().toISOString()): Exploration {
  const cur = getDesignSystem(projectId);
  if (!cur) throw new DesignSystemError('Project not found', 404);
  const { roundId, variation } = selectedVariation(cur);
  const project = (db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string }).name;
  const was = cur.system ?? null;
  const same = was && was.from.roundId === roundId && was.from.variationId === variation.id;
  const version = same ? was.version : (was?.version ?? 0) + 1;
  const spec = finalize({ name: variation.name, rationale: variation.rationale ?? '', tokens: variation.tokens, version, project });
  const files = filesOf(spec);
  const system: FinalSystem = {
    version, finalizedAt: same ? was.finalizedAt : now, from: { roundId, variationId: variation.id }, name: variation.name, spec,
    files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })),
    html: files.find((f) => f.path.endsWith('index.html'))!.content,
  };
  return keepServerPart(projectId, { system }, now);
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 }).trim();
const firstLine = (e: unknown) => {
  const err = e as { stderr?: string | Buffer; message?: string };
  const text = String(err.stderr || err.message || e).trim().split('\n').filter(Boolean);
  // git says the useful thing last ("! [rejected] …", "fatal: …").
  return (text.find((l) => /fatal:|error:|rejected|denied/i.test(l)) ?? text[text.length - 1] ?? 'git failed').slice(0, 300);
};

/** Put the system in one repo: write, commit exactly those files, push. Never throws. */
export function publishToRepo(repoPath: string, spec: DesignSystemSpec): RepoResult {
  const res: RepoResult = { repoPath, status: 'failed', detail: '', branch: '', commit: '' };
  try {
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) return { ...res, detail: 'This folder is not on this machine' };
    let top = '';
    try { top = git(repoPath, 'rev-parse', '--show-toplevel'); } catch { return { ...res, detail: 'Not a git repository' }; }
    if (fs.realpathSync(top) !== fs.realpathSync(repoPath)) return { ...res, detail: 'This folder is inside another repository, not a repository itself' };

    const paths: string[] = [];
    for (const f of filesOf(spec)) {
      const abs = path.join(repoPath, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
    paths.push(DESIGN_DIR);
    // The pointer for agents: CLAUDE.md always (it is created when missing), AGENTS.md where the repo has one.
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const abs = path.join(repoPath, name);
      const has = fs.existsSync(abs);
      if (!has && name !== 'CLAUDE.md') continue;
      const before = has ? fs.readFileSync(abs, 'utf8') : '';
      const after = withAgentBlock(before, spec);
      if (after !== before) fs.writeFileSync(abs, after);
      paths.push(name);
    }

    try { res.branch = git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch { res.branch = ''; }
    git(repoPath, 'add', '--', ...paths);
    let changed = true;
    try { git(repoPath, 'diff', '--cached', '--quiet', '--', ...paths); changed = false; } catch { changed = true; }
    if (changed) {
      // `-- paths` commits these paths only: anything else that was staged stays staged, uncommitted.
      git(repoPath, 'commit', '-m', `chore(design-system): ${spec.name} v${spec.version}`, '-m', 'Generated by NeonCore from the project\'s design system. Do not edit design-system/ by hand.', '--', ...paths);
    }
    try { res.commit = git(repoPath, 'rev-parse', '--short', 'HEAD'); } catch { res.commit = ''; }

    let upstream = '';
    try { upstream = git(repoPath, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); } catch { upstream = ''; }
    if (!upstream) {
      return { ...res, status: changed ? 'committed' : 'unchanged', detail: changed ? `Committed on ${res.branch || 'the current branch'}; it has no upstream, so nothing was pushed` : 'Already up to date (this branch has no upstream)' };
    }
    let ahead = 0;
    try { ahead = Number(git(repoPath, 'rev-list', '--count', `${upstream}..HEAD`)) || 0; } catch { ahead = changed ? 1 : 0; }
    if (!changed && ahead === 0) return { ...res, status: 'unchanged', detail: `Already up to date on ${upstream}` };
    try {
      git(repoPath, 'push');
      return { ...res, status: 'pushed', detail: `${changed ? 'Committed and pushed' : 'Pushed'} to ${upstream}` };
    } catch (e) {
      return { ...res, status: changed ? 'committed' : 'failed', detail: `${changed ? 'Committed, but the push' : 'The push'} was refused: ${firstLine(e)}` };
    }
  } catch (e) {
    return { ...res, detail: firstLine(e) };
  }
}

/** Publish the finalized system to every repo of the project. */
export function publishProject(projectId: string, now = new Date().toISOString()): Exploration {
  const cur = getDesignSystem(projectId);
  if (!cur) throw new DesignSystemError('Project not found', 404);
  if (!cur.system) throw new DesignSystemError('Finalize the design system first — there is nothing to publish');
  const repos = projectRepos(projectId);
  if (repos.length === 0) throw new DesignSystemError('This project has no repos yet — add them to the project, then publish');
  const spec = cur.system.spec as DesignSystemSpec;
  return keepServerPart(projectId, { published: { version: cur.system.version, at: now, repos: repos.map((r) => publishToRepo(r, spec)) } }, now);
}
