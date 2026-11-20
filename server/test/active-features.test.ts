/**
 * What the map needs to show features instead of loose agents (REQUESTED: feature plates on the map).
 * GET /api/goal-pilots/active lists every running or paused feature with: its stage progress,
 * whether it needs you, the agents working on it, and — for one on its own branch — each worktree's
 * real repo, so the map can stand those agents at their repo's building.
 */
import './helpers/isolated-db.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import { createFeature } from '../src/routes/goals.ts';
import { createPilotRow } from '../src/lib/goal-pilot.ts';
import { stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';

installStubIO();
const app = express();
app.use(express.json());
app.use('/api/goal-pilots', goalPilotsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)); });
after(() => { server.close(); stopGoalPilotRunner(); });

const ISO = new Date().toISOString();
db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at) VALUES ('p1', NULL, 'GL', '', '/code/gl', '#fff', ?, ?)`).run(ISO, ISO);
function agentRow(id: string, repo: string) {
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id) VALUES (?,?,'m',?,?,'claude','working',?,?)`)
    .run(id, id, repo, repo.split('/').pop(), ISO, `s-${id}`);
}
function pilot(name: string, phase: string, workspace: unknown, stages: { status: string; repo: string; agentId?: string }[]) {
  const goalId = createFeature({ projectId: 'p1', name });
  const p = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: name } });
  db.prepare('UPDATE goal_pilots SET phase = ?, workspace = ? WHERE id = ?').run(phase, workspace ? JSON.stringify(workspace) : '', p.id);
  stages.forEach((s, i) => db.prepare(`INSERT INTO goal_pilot_stages (id, pilot_id, position, kind, stage_key, template_id, template_name, title, why, focus, repo_path, agent_type, project_id, status, participants, agent_id)
    VALUES (?, ?, ?, 'workflow', ?, '', 'T', ?, '', '', ?, 'claude', 'p1', ?, '[]', ?)`).run(randomUUID(), p.id, i, `k${i}`, `Stage ${i + 1}`, s.repo, s.status, s.agentId ?? ''));
  return p.id;
}

agentRow('wt-agent', '/code/gl-feature-x');
agentRow('main-agent', '/code/gl');
const isolated = pilot('Invoice import', 'running',
  { branch: 'feature/x', prsAt: null, repos: [{ repoPath: '/code/gl', worktreePath: '/code/gl-feature-x', agentType: 'claude', base: 'main', pr: null, error: '', removed: false }] },
  [{ status: 'completed', repo: '/code/gl-feature-x' }, { status: 'running', repo: '/code/gl-feature-x', agentId: 'wt-agent' }, { status: 'pending', repo: '/code/gl-feature-x' }]);
const inPlace = pilot('Export CSV', 'paused', null, [{ status: 'running', repo: '/code/gl', agentId: 'main-agent' }, { status: 'pending', repo: '/code/gl' }]);
pilot('Done already', 'completed', null, [{ status: 'completed', repo: '/code/gl' }]);

test('lists running and paused features — progress, needs-you, agents, worktree → repo', async () => {
  const list = await (await fetch(`${base}/api/goal-pilots/active`)).json() as {
    pilotId: string; name: string; projectId: string; stage: { position: number; total: number }; needsYou: string;
    agentIds: string[]; worktrees: { worktreePath: string; repoPath: string }[]; branch: string;
  }[];
  assert.deepEqual(list.map((f) => f.pilotId).sort(), [isolated, inPlace].sort(), 'a completed feature is not on the map');
  const a = list.find((f) => f.pilotId === isolated)!;
  assert.equal(a.projectId, 'p1');
  assert.deepEqual(a.stage, { position: 2, total: 3, title: 'Stage 2' });
  assert.deepEqual(a.agentIds, ['wt-agent']);
  assert.deepEqual(a.worktrees, [{ worktreePath: '/code/gl-feature-x', repoPath: '/code/gl' }]);
  assert.equal(a.branch, 'feature/x');
  assert.equal(a.needsYou, '');
  const b = list.find((f) => f.pilotId === inPlace)!;
  assert.deepEqual(b.agentIds, ['main-agent']);
  assert.deepEqual(b.worktrees, []);
  assert.ok(b.needsYou, 'a paused feature needs you');
});
