/**
 * EPIC QA RUNS EACH FEATURE'S TESTS IN THE FEATURE'S HOME REPO — not in the worktree it was built in.
 * Found live, Beam Phase 0, 2026-11-23: the run errored "/Users/mannyhenri/code/beam-feature-go-
 * project-skeleton does not exist on this machine" — a feature built on its own branch keeps its
 * worktree path in its contract, and that worktree is removed once the feature ships. The epic is
 * QA'd where its work lives now: the repo the worktree was cut from (pilot.workspace.repos[]).
 * SET — every way a feature can sit on disk: in place · its own worktree (removed after shipping) ·
 * its own worktree (still there) · one repo of a multi-repo workspace · a worktree with no mapping.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { createPilotRow } from '../src/lib/goal-pilot.js';
import { createContract, updateContract } from '../src/lib/acceptance-contract.js';
import { setRepoAccessForTests, type RepoAccess } from '../src/lib/repo-access.js';
import { createEpic, planFeature } from '../src/lib/roadmap.js';
import { startEpicQa, epicQaSettled } from '../src/lib/qa/epic-acceptance.js';
import { latestEpicRun } from '../src/lib/qa/epic-qa-store.js';

installStubIO();
const asked: string[] = [];
setRepoAccessForTests((repoPath: string): RepoAccess => {
  asked.push(repoPath);
  return {
    where: 'local', label: 'this machine',
    async readFiles(paths) { return paths.map((p) => ({ path: p, exists: false, sha256: '', content: '' })); },
    async writeFile() { /* never */ },
    async run() { return { exitCode: 0, timedOut: false, output: 'ok', durationMs: 1 }; },
  } as RepoAccess;
});

let n = 0;
type Ws = { repoPath: string; worktreePath: string; removed?: boolean }[] | null;
function featureIn(contractRepo: string, workspace: Ws): void {
  const p = `hr-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/code/app','#fff',?,?)`)
    .run(p, `P${n}`, '2026-01-01', '2026-01-01');
  const e = createEpic(p, { name: `E${n}` }).id;
  const g = `hr-g-${n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, origin, done_at) VALUES (?,?,'','achieved',?,?,?,?,'planned',?)`)
    .run(g, `F${n}`, '2026-01-01', '2026-01-01', p, n, new Date().toISOString());
  planFeature(g, { epicId: e });
  const pilot = createPilotRow({ goalId: g, plannerAgentId: 'nobody', intake: { goal: 'x' } });
  if (workspace) db.prepare('UPDATE goal_pilots SET workspace = ? WHERE id = ?').run(JSON.stringify({ branch: 'feature/x', repos: workspace }), pilot.id);
  const c = createContract({ pilotId: pilot.id, goalId: g, criteria: [{ id: 'AC-1', text: 't', expect: 'e', verify: 'command', command: 'true' }], repoPath: contractRepo, agentType: 'claude' });
  updateContract(c.id, { status: 'locked', tests: [{ criterionId: 'AC-1', command: 'true', files: [] }] });
  (globalThis as { lastEpic?: string }).lastEpic = e;
}
async function repoAsked(): Promise<string[]> {
  asked.length = 0;
  const e = (globalThis as { lastEpic?: string }).lastEpic!;
  startEpicQa(e);
  await epicQaSettled();
  assert.equal(latestEpicRun(e)!.status, 'passed');
  return [...new Set(asked)];
}

test('in place: the contract repo is the home repo', async () => {
  featureIn('/code/app', null);
  assert.deepEqual(await repoAsked(), ['/code/app']);
});
test('own worktree, removed after shipping: the repo it was cut from', async () => {
  featureIn('/code/app-feature-x', [{ repoPath: '/code/app', worktreePath: '/code/app-feature-x', removed: true }]);
  assert.deepEqual(await repoAsked(), ['/code/app']);
});
test('own worktree, still there: still the home repo (the epic is QA\'d where the work landed)', async () => {
  featureIn('/code/app-feature-y', [{ repoPath: '/code/app', worktreePath: '/code/app-feature-y', removed: false }]);
  assert.deepEqual(await repoAsked(), ['/code/app']);
});
test('one repo of a multi-repo workspace: that repo', async () => {
  featureIn('/code/web-feature-z', [
    { repoPath: '/code/app', worktreePath: '/code/app-feature-z' },
    { repoPath: '/code/web', worktreePath: '/code/web-feature-z' },
  ]);
  assert.deepEqual(await repoAsked(), ['/code/web']);
});
test('a worktree path with no mapping: as recorded', async () => {
  featureIn('/code/orphan-feature', [{ repoPath: '/code/app', worktreePath: '/code/something-else' }]);
  assert.deepEqual(await repoAsked(), ['/code/orphan-feature']);
});
