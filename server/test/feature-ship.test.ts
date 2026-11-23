/**
 * A FEATURE ON ITS OWN BRANCH FINISHES ITSELF: leftover work committed, PR opened, the person asked to
 * merge — and on "merge", every PR merged and the worktrees, branches and cartridges gone.
 *
 * REQUESTED: "fix the PR and merge at the end when we used worktrees to work on a feature, right now
 * it just has a button and it doesn't do much … automatically create PR and ask me to merge (and then
 * delete the worktree)". Before: the PR opened, then nothing — merging happened on GitHub by hand, and
 * the worktree, its branch and its cartridge stayed until someone pressed "Clean up merged".
 *
 * Real git repos, each with a local bare "origin"; a stand-in `gh` keeps each repo's PR state in a file
 * (keyed by its origin) and, on `pr merge`, really lands the branch on origin's main.
 * THE SETS: every repo of the feature — committed, merged, fast-forwarded, cleaned (worktree, local and
 * remote branch, cartridge, worktree record); all-or-none when one repo cannot merge; every merge
 * method fallback; merges made on GitHub noticed for every open PR.
 */
import './helpers/isolated-db.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { runStandardTemplateSeed } from '../src/lib/templates/index.ts';
import { createFeature } from '../src/routes/goals.ts';
import { createPilotRow, getPilot } from '../src/lib/goal-pilot.ts';
import { startPilot, stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';
import { setWorkspaceLauncher, openFeaturePRs, mergeFeaturePRs, syncMergedWorkspaces } from '../src/lib/feature-workspace.ts';
import { isNeoncoreWorktree } from '../src/lib/worktree.ts';
import { setProjectCartridges } from '../src/lib/resolve-agent.ts';
import { availableTemplates } from '../src/lib/goal-decomposition.ts';

installStubIO();
runStandardTemplateSeed(db);
after(() => stopGoalPilotRunner());

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ship-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function repo(name: string): string {
  const dir = path.join(TMP, name);
  const origin = path.join(TMP, `${name}-origin.git`);
  fs.mkdirSync(dir);
  git(TMP, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

// The stand-in gh. State per repo in $GH_DIR/<origin>.state (OPEN/MERGED/CLOSED) and .mergeable;
// a .nosquash file makes `pr merge --squash` refuse the way GitHub does.
const BIN = path.join(TMP, 'bin');
const GH_DIR = path.join(TMP, 'gh');
const GH_LOG = path.join(TMP, 'gh.log');
fs.mkdirSync(BIN); fs.mkdirSync(GH_DIR);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
R=$(basename "$(git remote get-url origin)")
S="${GH_DIR}/$R"
echo "$R $@" >> "${GH_LOG}"
if [ "$1 $2" = "pr create" ]; then echo OPEN > "$S.state"; echo "https://example.test/$R/pull/7"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then
  [ -f "$S.state" ] || { echo "no pull requests found" >&2; exit 1; }
  M=MERGEABLE; [ -f "$S.mergeable" ] && M=$(cat "$S.mergeable")
  MS=CLEAN; [ "$M" = CONFLICTING ] && MS=DIRTY
  echo "{\\"url\\":\\"https://example.test/$R/pull/7\\",\\"number\\":7,\\"state\\":\\"$(cat "$S.state")\\",\\"mergeable\\":\\"$M\\",\\"mergeStateStatus\\":\\"$MS\\"}"; exit 0
fi
if [ "$1 $2" = "pr merge" ]; then
  if [ "$4" = "--squash" ] && [ -f "$S.nosquash" ]; then echo "GraphQL: Squash merges are not allowed on this repository" >&2; exit 1; fi
  git push -q origin HEAD:main || exit 1
  echo MERGED > "$S.state"; exit 0
fi
exit 0
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
const ghState = (r: string, state: string) => fs.writeFileSync(path.join(GH_DIR, `${path.basename(r)}-origin.git.state`), `${state}\n`);
const ghFile = (r: string, ext: string, v: string | null) => {
  const f = path.join(GH_DIR, `${path.basename(r)}-origin.git.${ext}`);
  if (v === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, v);
};
const ghCalls = () => fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, 'utf8') : '';

setWorkspaceLauncher(() => null);
const ISO = new Date().toISOString();
const TEMPLATE = availableTemplates()[0].name;
let n = 0;

/** A started feature on its own branch over `repos`, with a cartridge registered in each worktree. */
function feature(repos: string[]): string {
  const pid = `ship-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?, NULL, ?, '', ?, '#fff', ?, ?)`).run(pid, pid, repos[0], ISO, ISO);
  setProjectCartridges(pid, repos);
  const name = `Ship ${n}`;
  const goalId = createFeature({ projectId: pid, name });
  const pilot = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: name, workType: 'feature' }, featureRepos: repos });
  const plan = {
    brief: { slug: `ship-${n}`, summary: `${name}.`, successMetric: '', inScope: '', outOfScope: '', invariants: '', assumptions: '' },
    stages: [{ key: 'build', template: TEMPLATE, title: 'Build it', why: '', focus: 'build', optional: false }],
    criteria: [{ id: 'AC-1', text: 'When a, b.', expect: 'a → b', verify: 'checklist' }],
  };
  db.prepare("UPDATE goal_pilots SET phase = 'staffing', plan = ? WHERE id = ?").run(JSON.stringify(plan), pilot.id);
  startPilot(pilot.id, { repos: repos.map((r) => ({ repoPath: r, agentType: 'claude' })), assignments: {}, isolate: true });
  for (const r of getPilot(pilot.id)!.workspace!.repos) {
    db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
                VALUES (?,?,'m',?,?,'claude','idle',?,?)`).run(`cart-${path.basename(r.worktreePath)}`, `m/${path.basename(r.worktreePath)}`, r.worktreePath, path.basename(r.worktreePath), ISO, `s-${n}`);
  }
  return pilot.id;
}
const ws = (id: string) => getPilot(id)!.workspace!;
const tree = (id: string, r: string) => ws(id).repos.find((x) => x.repoPath === r)!.worktreePath;

test('at the end, work left uncommitted in EVERY repo is committed (never .neoncore/), then each gets its PR', async () => {
  const A = repo('a1'); const B = repo('b1');
  const id = feature([A, B]);
  for (const r of [A, B]) {
    fs.writeFileSync(path.join(tree(id, r), 'built.txt'), 'the feature\n');               // never committed by the agent
    fs.mkdirSync(path.join(tree(id, r), '.neoncore'), { recursive: true });
    fs.writeFileSync(path.join(tree(id, r), '.neoncore', 'scratch.json'), '{}');
  }
  await openFeaturePRs(id);
  for (const r of ws(id).repos) {
    assert.equal(r.error, '', `${r.repoPath}: ${r.error}`);
    assert.match(r.pr?.url ?? '', /example\.test/, `${r.repoPath} has no PR`);
    const files = git(r.worktreePath, 'show', '--name-only', '--pretty=format:', 'HEAD').split('\n');
    assert.ok(files.includes('built.txt'), 'the leftover work is not in the PR');
    assert.ok(!files.some((f) => f.startsWith('.neoncore/')), 'NeonCore scratch was committed');
  }
});

test('merge is all-or-none: one repo that cannot merge stops every merge, and each repo says why', async () => {
  const A = repo('a2'); const B = repo('b2');
  const id = feature([A, B]);
  for (const r of [A, B]) { fs.writeFileSync(path.join(tree(id, r), 'x.txt'), 'x\n'); git(tree(id, r), 'add', '.'); git(tree(id, r), 'commit', '-m', 'x'); }
  await openFeaturePRs(id);
  ghFile(B, 'mergeable', 'CONFLICTING');
  fs.writeFileSync(GH_LOG, '');
  await mergeFeaturePRs(id);
  assert.doesNotMatch(ghCalls(), /pr merge/, 'a PR was merged while another of the same feature could not be');
  const a = ws(id).repos.find((r) => r.repoPath === A)!;
  const b = ws(id).repos.find((r) => r.repoPath === B)!;
  assert.match(b.error, /conflicts/);
  assert.match(a.error, /waiting for the other repos/);
  assert.ok(fs.existsSync(a.worktreePath) && fs.existsSync(b.worktreePath));
  ghFile(B, 'mergeable', null);
});

test('merge: EVERY repo merged, base fast-forwarded, and worktree, branches, cartridge and record all gone', async () => {
  const A = repo('a3'); const B = repo('b3');
  const id = feature([A, B]);
  const branch = ws(id).branch;
  for (const r of [A, B]) { fs.writeFileSync(path.join(tree(id, r), 'feat.txt'), 'shipped\n'); git(tree(id, r), 'add', '.'); git(tree(id, r), 'commit', '-m', 'feat'); }
  await openFeaturePRs(id);
  const before = ws(id).repos.map((r) => ({ ...r }));
  for (const r of before) assert.ok(isNeoncoreWorktree(r.worktreePath));
  await mergeFeaturePRs(id);
  const after = ws(id);
  assert.ok(after.mergedAt, 'mergedAt not set');
  assert.ok(after.cleanedAt, 'cleanedAt not set');
  for (const r of after.repos) {
    const name = path.basename(r.repoPath);
    assert.equal(r.error, '', `${name}: ${r.error}`);
    assert.equal(r.pr?.state, 'merged', `${name} not merged`);
    assert.equal(r.removed, true, `${name} worktree not removed`);
    assert.ok(!fs.existsSync(r.worktreePath), `${name} worktree folder still there`);
    assert.ok(fs.existsSync(path.join(r.repoPath, 'feat.txt')), `${name}: the base checkout was not fast-forwarded`);
    assert.equal(git(r.repoPath, 'branch', '--list', branch), '', `${name}: local branch kept`);
    assert.equal(git(r.repoPath, 'ls-remote', '--heads', 'origin', branch), '', `${name}: remote branch kept`);
    assert.equal(db.prepare('SELECT 1 FROM agents WHERE repo_path = ?').get(r.worktreePath), undefined, `${name}: the worktree cartridge is still listed`);
    assert.equal(isNeoncoreWorktree(r.worktreePath), false, `${name}: the worktree record is kept`);
  }
});

test('a repo that does not allow squash merges is merged the way it does allow', async () => {
  const A = repo('a4');
  const id = feature([A]);
  fs.writeFileSync(path.join(tree(id, A), 'y.txt'), 'y\n'); git(tree(id, A), 'add', '.'); git(tree(id, A), 'commit', '-m', 'y');
  await openFeaturePRs(id);
  ghFile(A, 'nosquash', '1');
  fs.writeFileSync(GH_LOG, '');
  await mergeFeaturePRs(id);
  assert.match(ghCalls(), /pr merge \S+ --squash[\s\S]*pr merge \S+ --merge/);
  assert.equal(ws(id).repos[0].pr?.state, 'merged');
  assert.equal(ws(id).repos[0].removed, true);
});

test('PRs merged on GitHub are noticed for every open PR and cleaned up; an open one is left alone', async () => {
  const A = repo('a5'); const B = repo('b5');
  const merged = feature([A]);
  const open = feature([B]);
  for (const [id, r] of [[merged, A], [open, B]] as const) {
    fs.writeFileSync(path.join(tree(id, r), 'z.txt'), 'z\n'); git(tree(id, r), 'add', '.'); git(tree(id, r), 'commit', '-m', 'z');
    await openFeaturePRs(id);
  }
  ghState(A, 'MERGED');
  const cleaned = await syncMergedWorkspaces();
  assert.ok(cleaned.includes(merged));
  assert.ok(!cleaned.includes(open));
  assert.equal(ws(merged).repos[0].removed, true);
  assert.ok(ws(merged).cleanedAt);
  assert.equal(ws(open).repos[0].removed, false);
  assert.ok(fs.existsSync(tree(open, B)));
});

test('a worktree already deleted by hand is still cleaned up after its merge', async () => {
  const A = repo('a6');
  const id = feature([A]);
  fs.writeFileSync(path.join(tree(id, A), 'w.txt'), 'w\n'); git(tree(id, A), 'add', '.'); git(tree(id, A), 'commit', '-m', 'w');
  await openFeaturePRs(id);
  ghState(A, 'MERGED');
  fs.rmSync(tree(id, A), { recursive: true, force: true });
  await syncMergedWorkspaces();
  const r = ws(id).repos[0];
  assert.equal(r.error, '');
  assert.equal(r.removed, true);
  assert.doesNotMatch(git(A, 'worktree', 'list'), new RegExp(path.basename(r.worktreePath)), 'git still lists the deleted worktree');
});
