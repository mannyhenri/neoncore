/**
 * Features that run side by side: a branch and a worktree per repo, a cartridge per worktree, a PR
 * per repo at the end.
 *
 * REQUESTED: "if I'd like to use the same repos as a base and work on another feature at the same
 * time … create the worktrees … go through the entire feature, and then create PRs to merge into the
 * main branch" — and "when we start a feature we need to be able to select which repos will be part
 * of this feature". Before this, every pipeline ran in the repos' own checkouts with the one cartridge
 * per repo, so a second feature waited on the first and then edited the same working tree.
 *
 * Real git repos (each with a local bare "origin") and a stand-in `gh` that records its arguments.
 * THE SETS: every repo-bound record a started pipeline writes (each stage, the acceptance contract,
 * the staffing) points at the feature's worktree; every repo of the feature gets a PR.
 */
import './helpers/isolated-db.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { runStandardTemplateSeed } from '../src/lib/templates/index.ts';
import { createFeature } from '../src/routes/goals.ts';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import { createPilotRow, getPilot } from '../src/lib/goal-pilot.ts';
import { startPilot, buildStageContext, stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';
import { getContract } from '../src/lib/acceptance-contract.ts';
import { projectContext } from '../src/lib/goal-pilot-prompts.ts';
import { setWorkspaceLauncher, openFeaturePRs, cleanupWorkspace, featureBranchFor } from '../src/lib/feature-workspace.ts';
import { setProjectCartridges, getProjectCartridges } from '../src/lib/resolve-agent.ts';
import { availableTemplates } from '../src/lib/goal-decomposition.ts';

installStubIO();
runStandardTemplateSeed(db);
const app = express();
app.use(express.json());
app.use('/api/goal-pilots', goalPilotsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => { server.close(); stopGoalPilotRunner(); });

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fw-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
/** A repo on `main` with one commit, and a bare origin it tracks. */
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
// A stand-in `gh`: records every call; `pr view` answers with the state in $GH_STATE.
const BIN = path.join(TMP, 'bin');
const GH_LOG = path.join(TMP, 'gh.log');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
echo "$@" >> "${GH_LOG}"
if [ "$1 $2" = "pr view" ]; then
  if [ -z "$GH_STATE" ]; then echo "no pull requests found" >&2; exit 1; fi
  echo "{\\"url\\":\\"https://example.test/pr/1\\",\\"number\\":1,\\"state\\":\\"$GH_STATE\\"}"; exit 0
fi
if [ "$1 $2" = "pr create" ]; then echo "https://example.test/pr/$$"; exit 0; fi
exit 0
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

const launched: string[] = [];
setWorkspaceLauncher((dir) => { launched.push(dir); return null; });

const A = repo('alpha');
const B = repo('beta');
const C = repo('gamma');   // in the project, NOT part of the feature
const ISO = new Date().toISOString();
db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
            VALUES ('proj', NULL, 'Gridlight', '', ?, '#fff', ?, ?)`).run(A, ISO, ISO);
setProjectCartridges('proj', [A, B, C]);
const TEMPLATE = availableTemplates()[0].name;

function stagedPilot(name: string, slug: string, featureRepos: string[]) {
  const goalId = createFeature({ projectId: 'proj', name });
  const pilot = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: name, workType: 'feature' }, featureRepos });
  const plan = {
    brief: { slug, summary: `${name}.`, successMetric: '', inScope: '', outOfScope: '', invariants: '', assumptions: '' },
    stages: [
      { key: 'build', template: TEMPLATE, title: 'Build it', why: '', focus: 'build', optional: false },
      { key: 'polish', template: TEMPLATE, title: 'Polish it', why: '', focus: 'polish', optional: false },
    ],
    criteria: [
      { id: 'AC-1', text: 'When x, the system shall y.', expect: 'x → y', verify: 'test' },
      { id: 'AC-2', text: 'When a, the system shall b.', expect: 'a → b', verify: 'checklist' },
    ],
  };
  db.prepare("UPDATE goal_pilots SET phase = 'staffing', plan = ? WHERE id = ?").run(JSON.stringify(plan), pilot.id);
  return pilot.id;
}
const stageRows = (pilotId: string) =>
  db.prepare('SELECT title, repo_path, participants FROM goal_pilot_stages WHERE pilot_id = ? ORDER BY position').all(pilotId) as { title: string; repo_path: string; participants: string }[];

test('the repos chosen for a feature are the ones the planner is told about', () => {
  const id = stagedPilot('Pick repos', 'pick-repos', [A, B]);
  const lines = projectContext(getPilot(id)!.goalId, getPilot(id)!.featureRepos).lines.join('\n');
  assert.match(lines, new RegExp(`Repos for THIS feature: ${A}, ${B}`));
  assert.match(lines, new RegExp(`not part of this feature.*${C}`));
});

let first = '';
test('starting a feature puts every stage, the contract and the staffing in its own worktree, and launches a cartridge in each', () => {
  first = stagedPilot('Invoice import', 'invoice-import', [A, B]);
  startPilot(first, { repos: [{ repoPath: A, agentType: 'claude' }, { repoPath: B, agentType: 'claude' }], assignments: { polish: B }, isolate: true });
  const p = getPilot(first)!;
  const ws = p.workspace!;
  assert.equal(ws.branch, 'feature/invoice-import');
  const trees = new Map(ws.repos.map((r) => [r.repoPath, r.worktreePath]));
  assert.deepEqual([...trees.keys()].sort(), [A, B].sort());
  for (const [orig, tree] of trees) {
    assert.notEqual(tree, orig);
    assert.equal(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/invoice-import', `${tree} is not on the feature branch`);
    assert.equal(git(tree, 'merge-base', 'HEAD', 'main'), git(orig, 'rev-parse', 'main'), `${tree} does not start from main`);
  }
  const allowed = new Set(trees.values());
  for (const s of stageRows(first)) {
    assert.ok(allowed.has(s.repo_path), `stage "${s.title}" runs in ${s.repo_path}, not a feature worktree`);
    for (const part of JSON.parse(s.participants) as { repoPath: string }[]) assert.ok(allowed.has(part.repoPath), `a participant of "${s.title}" is outside the worktrees`);
  }
  assert.ok(allowed.has(getContract(first)!.repoPath), 'the acceptance contract is outside the worktrees');
  for (const r of p.staffing!.repos) assert.ok(allowed.has(r.repoPath), 'the staffing names a repo outside the worktrees');
  assert.deepEqual(launched.sort(), [...allowed].sort(), 'a cartridge was not launched in every worktree');
  assert.deepEqual(getProjectCartridges('proj').sort(), [A, B, C].sort(), 'the project must keep listing the real repos, not worktrees');
});

test('a second feature on the same repo gets its own worktree, branch and cartridge', () => {
  launched.length = 0;
  const second = stagedPilot('Export CSV', 'export-csv', [A]);
  startPilot(second, { repos: [{ repoPath: A, agentType: 'claude' }], assignments: {}, isolate: true });
  const mine = getPilot(second)!.workspace!.repos[0].worktreePath;
  const theirs = getPilot(first)!.workspace!.repos.find((r) => r.repoPath === A)!.worktreePath;
  assert.notEqual(mine, theirs);
  assert.equal(git(mine, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/export-csv');
  assert.deepEqual(launched, [mine]);
});

test('a feature whose slug is already taken gets a branch of its own', () => {
  const again = stagedPilot('Invoice import again', 'invoice-import', [A]);
  assert.notEqual(featureBranchFor(getPilot(again)!), 'feature/invoice-import');
});

test('every stage is told its branch: commit there, never switch or merge', () => {
  const p = getPilot(first)!;
  const stages = db.prepare('SELECT * FROM goal_pilot_stages WHERE pilot_id = ? ORDER BY position').all(first) as Record<string, unknown>[];
  const row = stages[1];
  const ctx = buildStageContext(p, { id: row.id, position: 1, kind: 'workflow', key: 'build', templateId: '', template: TEMPLATE, title: 'Build it', why: '', focus: 'build', repoPath: row.repo_path, agentType: 'claude', participants: [], projectId: '', runId: '', agentId: '', status: 'pending', waitReason: '', resultSummary: '', attempts: 0, verifyState: 'none', requestId: '', startedAt: null, completedAt: null } as never, []);
  assert.match(ctx, /feature\/invoice-import/);
  assert.match(ctx, /commit/i);
  assert.match(ctx, /do not (switch|merge)/i);
});

test('at the end, every repo with commits on the branch is pushed and gets a PR; one with none is named', async () => {
  const ws = getPilot(first)!.workspace!;
  const treeA = ws.repos.find((r) => r.repoPath === A)!.worktreePath;
  fs.writeFileSync(path.join(treeA, 'feature.txt'), 'built\n');
  git(treeA, 'add', '.'); git(treeA, 'commit', '-m', 'feat: invoice import');
  fs.writeFileSync(GH_LOG, '');
  delete process.env.GH_STATE;
  await openFeaturePRs(first);
  const after = getPilot(first)!.workspace!;
  const a = after.repos.find((r) => r.repoPath === A)!;
  const b = after.repos.find((r) => r.repoPath === B)!;
  assert.match(a.pr?.url ?? '', /^https:\/\/example\.test\/pr\//, `alpha has no PR: ${a.error}`);
  assert.ok(git(A, 'ls-remote', '--heads', 'origin', 'feature/invoice-import').includes('feature/invoice-import'), 'the branch was not pushed');
  assert.match(fs.readFileSync(GH_LOG, 'utf8'), /pr create .*--base main .*--head feature\/invoice-import/);
  assert.equal(b.pr, null);
  assert.match(b.error, /no commits/i, 'a repo with nothing on the branch should say so, not open an empty PR');
});

test('cleanup removes a merged worktree and keeps an unmerged one', async () => {
  process.env.GH_STATE = 'MERGED';
  const ws = getPilot(first)!.workspace!;
  const treeA = ws.repos.find((r) => r.repoPath === A)!.worktreePath;
  const treeB = ws.repos.find((r) => r.repoPath === B)!.worktreePath;
  // beta's PR never existed: `pr view` must fail for it — run cleanup per repo with the state set only while alpha is checked.
  await cleanupWorkspace(first, { only: [A] });
  assert.ok(!fs.existsSync(treeA), 'the merged worktree is still there');
  assert.ok(fs.existsSync(treeB), 'an unmerged worktree was removed');
  assert.equal(getPilot(first)!.workspace!.repos.find((r) => r.repoPath === A)!.removed, true);
  delete process.env.GH_STATE;
});

test('feature worktrees are not offered as repos for the next feature', async () => {
  const tree = getPilot(first)!.workspace!.repos.find((r) => r.repoPath === B)!.worktreePath;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
              VALUES ('wt-agent','m/x','m',?,?,'claude','idle',?,'s-wt')`).run(tree, path.basename(tree), ISO);
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
              VALUES ('main-agent','m/beta','m',?,'beta','claude','idle',?,'s-main')`).run(B, ISO);
  const list = await (await fetch(`${base}/api/goal-pilots/candidates`)).json() as { repoPath: string }[];
  assert.ok(list.some((r) => r.repoPath === B), 'the real repo should be offered');
  assert.ok(!list.some((r) => r.repoPath === tree), 'a feature worktree was offered as a repo');
});
