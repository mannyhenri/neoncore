/**
 * A project owns CARTRIDGES. Work done in them is the project's work.
 *
 * The old model hung a project_id on each task, which meant only work someone remembered to
 * file as a "task" counted — a prompt, a confer or a workflow run in the same repo was
 * invisible to the project it plainly belonged to. Since a cartridge IS a repo checkout, the
 * durable link is project -> repo, and everything that happens in that repo is attributable
 * without anyone tagging it.
 *
 * `primary_repo` was already that link, singular. This makes it a set, so a project spanning a
 * server and a dashboard stops having to pick one.
 *
 * MIGRATION IS THE RISKY PART and is tested first: an existing project's primary_repo must
 * survive as a cartridge, or the change silently unlinks live projects and the only symptom is
 * a project that suddenly looks idle.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { projectsForAgent, setProjectCartridges, getProjectCartridges } from '../src/lib/resolve-agent.ts';

let n = 0;
const ISO = new Date().toISOString();

function project(name: string, primaryRepo = ''): string {
  const id = `p-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(id, null, name, '', primaryRepo, '', ISO, ISO);
  return id;
}
function agent(repoPath: string): string {
  const id = `a-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen)
              VALUES (?,?,?,?,?,?,?,?)`).run(id, `t/${id}`, 'm', repoPath, 'r', 'claude', 'idle', ISO);
  return id;
}

// ─── The link itself ────────────────────────────────────────────────────────

test('a project can own MANY cartridges, not one', () => {
  const p = project('spans two repos');
  setProjectCartridges(p, ['/code/server', '/code/dashboard']);
  assert.deepEqual(getProjectCartridges(p).sort(), ['/code/dashboard', '/code/server']);
});

test('EVERY cartridge of a project resolves back to it', () => {
  // Set-based on purpose: resolving the first repo and stopping is the bug that would make a
  // multi-repo project behave exactly like the single primary_repo it replaced.
  const p = project('multi');
  const REPOS = ['/code/one', '/code/two', '/code/three'];
  setProjectCartridges(p, REPOS);

  const unresolved = REPOS.filter((r) => !projectsForAgent(agent(r)).includes(p));
  assert.deepEqual(unresolved, [], `these cartridges did not resolve to their project: ${unresolved.join(', ')}`);
});

test('a cartridge in no project resolves to nothing rather than guessing', () => {
  assert.deepEqual(projectsForAgent(agent('/code/unclaimed')), []);
});

test('one cartridge may serve several projects', () => {
  // A shared repo is normal — a monorepo serves every project built from it. Forcing one
  // owner would make the second project silently lose its work.
  const a = project('alpha');
  const b = project('beta');
  setProjectCartridges(a, ['/code/shared']);
  setProjectCartridges(b, ['/code/shared']);
  assert.deepEqual(projectsForAgent(agent('/code/shared')).sort(), [a, b].sort());
});

test('setting cartridges REPLACES the set rather than appending', () => {
  const p = project('replaced');
  setProjectCartridges(p, ['/code/old']);
  setProjectCartridges(p, ['/code/new']);
  assert.deepEqual(getProjectCartridges(p), ['/code/new']);
  assert.deepEqual(projectsForAgent(agent('/code/old')), [], 'a removed cartridge must stop resolving');
});

// ─── Migration: existing projects must not be silently unlinked ─────────────

test('an existing primary_repo survives as a cartridge', () => {
  // The migration runs in db.ts at boot. Simulated here by inserting a project the old way and
  // asserting the same backfill rule holds — a project that looks idle after an upgrade is the
  // hardest kind of regression to notice, because nothing errors.
  const p = project('legacy', '/code/legacy-repo');
  db.prepare(`INSERT OR IGNORE INTO project_cartridges (project_id, repo_path)
              SELECT id, primary_repo FROM projects WHERE id = ? AND primary_repo != ''`).run(p);
  assert.deepEqual(getProjectCartridges(p), ['/code/legacy-repo']);
  assert.deepEqual(projectsForAgent(agent('/code/legacy-repo')), [p]);
});

test('repo paths match the way the rest of the system matches them', () => {
  // resolve-agent normalises paths (trailing slash, case on darwin). Linking must use the same
  // rule or a project silently stops matching its own cartridge over a cosmetic difference.
  const p = project('normalised');
  setProjectCartridges(p, ['/code/Repo/']);
  assert.deepEqual(projectsForAgent(agent('/code/Repo')), [p]);
});
