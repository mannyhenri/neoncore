/**
 * DONE MEANS SHIPPED — a feature built in its own worktrees ends without leaving branches behind.
 *
 * REQUESTED: "when the feature is completed and accepted, it should automatically create a PR, merge
 * the code to the main branch it created the worktree branch from and then delete the worktree/branch.
 * We should have an option in the accepting completion step to mark this as I will merge and delete
 * myself but it then creates the PR and I would merge it myself or someone else would."
 *
 *   pipeline ends      → the PRs open for review; NOTHING is merged before the person accepts.
 *   marked done        → (any road: the button, the Board, the tools — PUT /goals/:id achieved)
 *                        the PRs are opened if they are not yet, then merged (all or none) and the
 *                        worktrees, branches and cartridges removed.
 *   "I'll merge it myself" on that step → the PRs open and stay open; nothing is merged or removed.
 *                        When it is merged on GitHub, the sweep cleans up (feature-ship.test.ts).
 *   GitHub refuses     → nothing merged, the worktree stays, the person is told why.
 *
 * THE SET: the choice (not made, merge, I'll merge myself) × every answer GitHub can give about the PR
 * (clean, conflicting, blocked, behind). Real git repos with a bare origin; a stand-in `gh`.
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
import goalsRouter from '../src/routes/goals.ts';
import { createPilotRow, getPilot } from '../src/lib/goal-pilot.ts';
import { startPilot, openPrsAndTell, stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';
import { setWorkspaceLauncher } from '../src/lib/feature-workspace.ts';
import { setProjectCartridges } from '../src/lib/resolve-agent.ts';
import { availableTemplates } from '../src/lib/goal-decomposition.ts';

const io = installStubIO();
runStandardTemplateSeed(db);
const app = express();
app.use(express.json());
app.use('/api/goal-pilots', goalPilotsRouter);
app.use('/api/goals', goalsRouter);
let server!: Server;
const root = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/api`));
});
after(() => { server.close(); stopGoalPilotRunner(); });

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-done-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function repo(name: string): string {
  const dir = path.join(TMP, name); const origin = path.join(TMP, `${name}-origin.git`);
  fs.mkdirSync(dir);
  git(TMP, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin); git(dir, 'push', '-u', 'origin', 'main'); git(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}
// The stand-in `gh`. `pr view` answers OPEN with $GH_MERGEABLE / $GH_MSTATE until `pr merge` ran for
// that branch, then MERGED. Every call is logged.
const BIN = path.join(TMP, 'bin'); const LOG = path.join(TMP, 'gh.log'); const MERGED = path.join(TMP, 'merged');
fs.mkdirSync(BIN); fs.mkdirSync(MERGED);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
echo "$@" >> "${LOG}"
key=$(echo "$3" | tr '/' '_')
if [ "$1 $2" = "pr view" ]; then
  if [ -f "${MERGED}/$key" ]; then echo '{"url":"https://example.test/pr/1","number":1,"state":"MERGED","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}'; exit 0; fi
  if [ -f "${MERGED}/$key.open" ]; then echo "{\\"url\\":\\"https://example.test/pr/1\\",\\"number\\":1,\\"state\\":\\"OPEN\\",\\"mergeable\\":\\"$GH_MERGEABLE\\",\\"mergeStateStatus\\":\\"$GH_MSTATE\\"}"; exit 0; fi
  echo "no pull requests found" >&2; exit 1
fi
if [ "$1 $2" = "pr create" ]; then
  for a in "$@"; do if [ "$prev" = "--head" ]; then touch "${MERGED}/$(echo "$a" | tr '/' '_').open"; fi; prev="$a"; done
  echo "https://example.test/pr/1"; exit 0
fi
if [ "$1 $2" = "pr merge" ]; then touch "${MERGED}/$key"; exit 0; fi
exit 0
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
setWorkspaceLauncher(() => null);

const TEMPLATE = availableTemplates()[0].name;
const ISO = new Date().toISOString();
let k = 0;
/** A feature in its own worktree whose pipeline has finished, with a commit on its branch. */
function finishedFeature(): { pilotId: string; goalId: string; tree: string; dir: string } {
  const id = ++k;
  const dir = repo(`r${id}`);
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at) VALUES (?, NULL, ?, '', ?, '#fff', ?, ?)`).run(`proj${id}`, `P${id}`, dir, ISO, ISO);
  setProjectCartridges(`proj${id}`, [dir]);
  const goalId = createFeature({ projectId: `proj${id}`, name: `Feature ${id}` });
  const pilot = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: `Feature ${id}`, workType: 'feature' }, featureRepos: [dir] });
  const plan = {
    brief: { slug: `feat-${id}`, summary: 'x.', successMetric: '', inScope: '', outOfScope: '', invariants: '', assumptions: '' },
    stages: [{ key: 'build', template: TEMPLATE, title: 'Build it', why: '', focus: 'build', optional: false }],
    criteria: [{ id: 'AC-1', text: 'When x, the system shall y.', expect: 'x → y', verify: 'checklist' }],
  };
  db.prepare("UPDATE goal_pilots SET phase = 'staffing', plan = ? WHERE id = ?").run(JSON.stringify(plan), pilot.id);
  startPilot(pilot.id, { repos: [{ repoPath: dir, agentType: 'claude' }], assignments: {}, isolate: true });
  const tree = getPilot(pilot.id)!.workspace!.repos[0].worktreePath;
  fs.writeFileSync(path.join(tree, 'work.txt'), 'done\n'); git(tree, 'add', '.'); git(tree, 'commit', '-m', 'feat: work');
  stopGoalPilotRunner();
  db.prepare("UPDATE goal_pilots SET phase = 'completed', completed_at = ? WHERE id = ?").run(ISO, pilot.id);
  return { pilotId: pilot.id, goalId, tree, dir };
}
const told = (pilotId: string) => {
  const name = (db.prepare('SELECT g.name FROM goals g JOIN goal_pilots p ON p.goal_id = g.id WHERE p.id = ?').get(pilotId) as { name: string }).name;
  return io.emissions.filter((e) => e.event === 'workflow_notification' && String((e.payload as { title: string }).title).startsWith(`${name} — `))
    .map((e) => e.payload as { title: string; body: string; kind: string })
    .map((m) => ({ ...m, headline: m.title.slice(m.title.indexOf(' — ') + 3) }));
};
const merges = () => fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.startsWith('pr merge'));
const json = (method: string, url: string, body: unknown) => fetch(`${root}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** Shipping runs after the response (git and gh take seconds): wait for its notice. */
async function noticeAfter(pilotId: string, before: number): Promise<{ headline: string; body: string; kind: string }[]> {
  for (let i = 0; i < 200; i++) {
    const msgs = told(pilotId).slice(before);
    if (msgs.length) return msgs;
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

const GITHUB = [
  { says: 'clean', mergeable: 'MERGEABLE', mstate: 'CLEAN', why: '' },
  { says: 'conflicting', mergeable: 'CONFLICTING', mstate: 'DIRTY', why: 'conflicts with the base branch' },
  { says: 'blocked', mergeable: 'MERGEABLE', mstate: 'BLOCKED', why: 'required review or check' },
  { says: 'behind', mergeable: 'MERGEABLE', mstate: 'BEHIND', why: 'behind the base branch' },
];
const CHOICES = [
  { name: 'no choice made', mergeMyself: undefined },
  { name: 'merge for me', mergeMyself: false },
  { name: "I'll merge it myself", mergeMyself: true },
] as const;

test('the pipeline ending opens the PR for review — it never merges before the feature is accepted', async () => {
  process.env.GH_MERGEABLE = 'MERGEABLE'; process.env.GH_MSTATE = 'CLEAN';
  fs.writeFileSync(LOG, '');
  const { pilotId, tree } = finishedFeature();
  const before = told(pilotId).length;
  await openPrsAndTell(pilotId);
  const ws = getPilot(pilotId)!.workspace!;
  assert.match(ws.repos[0].pr?.url ?? '', /example\.test/);
  assert.deepEqual(merges(), []);
  assert.ok(fs.existsSync(tree));
  const msgs = told(pilotId).slice(before);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /mark the feature done/i, 'the notice says how it lands');
});

for (const choice of CHOICES) for (const gh of GITHUB) {
  test(`marked done × ${choice.name} × GitHub says ${gh.says}`, async () => {
    process.env.GH_MERGEABLE = gh.mergeable; process.env.GH_MSTATE = gh.mstate;
    fs.writeFileSync(LOG, '');
    const { pilotId, goalId, tree, dir } = finishedFeature();
    const branch = getPilot(pilotId)!.workspace!.branch;
    if (choice.mergeMyself !== undefined) {
      const r = await json('PUT', `/goal-pilots/${pilotId}/workspace`, { mergeMyself: choice.mergeMyself });
      assert.equal(r.status, 200);
      assert.equal(getPilot(pilotId)!.workspace!.mergeMyself, choice.mergeMyself);
    }
    const before = told(pilotId).length;
    const done = await json('PUT', `/goals/${goalId}`, { status: 'achieved' });   // the PR was never opened: done opens it
    assert.equal(done.status, 200);
    const msgs = await noticeAfter(pilotId, before);
    const ws = getPilot(pilotId)!.workspace!;
    assert.match(ws.repos[0].pr?.url ?? '', /example\.test/, 'a PR is opened either way');

    if (choice.mergeMyself) {
      assert.deepEqual(merges(), [], "I'll merge it myself: nothing is merged");
      assert.ok(fs.existsSync(tree), 'the worktree stays until the PR is merged');
      assert.ok(!ws.mergedAt && !ws.cleanedAt);
      assert.equal(msgs.length, 1);
      assert.match(msgs[0].headline, /left open for you to merge/);
      assert.match(msgs[0].body, /example\.test/);
      return;
    }
    if (!gh.why) {
      assert.equal(merges().length, 1, 'merged once');
      assert.ok(!fs.existsSync(tree), 'the worktree is removed');
      assert.ok(!git(dir, 'branch', '--list', branch), 'the local branch is deleted');
      assert.ok(ws.mergedAt && ws.cleanedAt, 'merged and cleaned up');
      assert.deepEqual(msgs.map((m) => m.headline), ['merged and cleaned up']);
    } else {
      assert.deepEqual(merges(), [], 'nothing merged while GitHub will not');
      assert.ok(fs.existsSync(tree), 'the worktree stays for the person to resolve');
      assert.ok(!ws.mergedAt && !ws.cleanedAt);
      assert.match(ws.repos[0].error, new RegExp(gh.why));
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].kind, 'needs-you', 'it asks the person');
      assert.match(msgs[0].body, new RegExp(gh.why));
    }
  });
}

test('a feature still being built is not merged when it is marked done', async () => {
  process.env.GH_MERGEABLE = 'MERGEABLE'; process.env.GH_MSTATE = 'CLEAN';
  fs.writeFileSync(LOG, '');
  const { pilotId, goalId, tree } = finishedFeature();
  db.prepare("UPDATE goal_pilots SET phase = 'running' WHERE id = ?").run(pilotId);
  assert.equal((await json('PUT', `/goals/${goalId}`, { status: 'achieved' })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(merges(), []);
  assert.ok(fs.existsSync(tree), 'an agent may still be working in it');
});

test('the choice is kept only on a feature with its own worktrees, and must be true or false', async () => {
  const { pilotId } = finishedFeature();
  assert.equal((await json('PUT', `/goal-pilots/${pilotId}/workspace`, { mergeMyself: 'yes' })).status, 400);
  const goalId = createFeature({ projectId: 'proj1', name: 'No worktree' });
  const plain = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: 'x', workType: 'feature' } });
  assert.equal((await json('PUT', `/goal-pilots/${plain.id}/workspace`, { mergeMyself: true })).status, 404);
});
