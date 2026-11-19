/**
 * Files belong to the feature, and every agent working on it gets them.
 *
 * REQUESTED: "when we create a new feature, there should be an opportunity somewhere to add files,
 * could we add this in the scoping somewhere". The files are attached to the FEATURE (not to one
 * prompt), kept by the server, and handed to every cartridge the pipeline talks to — copied into
 * that cartridge's own repo (gitignored) and named in its prompt by a path valid there:
 *   every planner request kind (PILOT_REQUEST_KINDS) — through deliverPlannerRequest, the one delivery path
 *   every stage — through buildStageContext, the run's launch context, for each participant's repo
 * A file removed stops being handed out; a feature deleted takes its files with it.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import goalsRouter, { createFeature, deleteFeatureCascade } from '../src/routes/goals.ts';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import { createPilotRow, createRequestRow, setRequestPrompt, PILOT_REQUEST_KINDS, type GoalPilot, type PilotStage } from '../src/lib/goal-pilot.ts';
import { deliverPlannerRequest, buildStageContext, stopGoalPilotRunner } from '../src/lib/goal-pilot-runner.ts';
import { featureFilesDir } from '../src/lib/feature-files.ts';

const io = installStubIO();
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/goals', goalsRouter);
app.use('/api/goal-pilots', goalPilotsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => { server.close(); stopGoalPilotRunner(); });

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

const repo = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ff-${name}-`));
let n = 0;
function cartridge(repoPath: string): string {
  const id = `ff-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, 'box', ?, ?, 'idle', ?, ?, 'claude')`).run(id, id, repoPath, path.basename(repoPath), new Date().toISOString(), `s-${id}`);
  io.connect(id);
  return id;
}
const lastPrompt = (agentId: string) => {
  const hits = io.emissions.filter((e) => e.event === 'command_send' && e.room === `agent:${agentId}`);
  return hits.length ? String((hits[hits.length - 1].payload as { text: string }).text) : '';
};
const b64 = (s: string) => Buffer.from(s).toString('base64');
const FILES = [
  { name: 'mockup.png', mimeType: 'image/png', content: 'PNGDATA' },
  { name: 'brief.pdf', mimeType: 'application/pdf', content: 'PDFDATA' },
];

/** Every path the prompt names for the files, each checked to exist with the uploaded bytes. */
function assertFilesIn(prompt: string, where: string, names = FILES.map((f) => f.name)) {
  for (const f of FILES.filter((x) => names.includes(x.name))) {
    const line = prompt.split('\n').find((l) => l.includes(f.name) && l.includes('/'));
    assert.ok(line, `${where}: the prompt does not name ${f.name}`);
    const p = line!.slice(line!.lastIndexOf(': ') + 2).trim();
    assert.ok(fs.existsSync(p), `${where}: ${f.name} is named at ${p}, which does not exist`);
    assert.equal(fs.readFileSync(p, 'utf8'), f.content, `${where}: ${f.name} has the wrong bytes`);
  }
}

test('files added to a feature reach every request kind and every stage, in each agent\'s own repo', async () => {
  const goalId = createFeature({ projectId: '', name: 'Checkout redesign' });
  const up = await call('POST', `/api/goals/${goalId}/files`, {
    files: FILES.map((f) => ({ name: f.name, mimeType: f.mimeType, size: f.content.length, dataBase64: b64(f.content) })),
  });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const listed = await call('GET', `/api/goals/${goalId}/files`);
  assert.deepEqual(listed.json.map((f: { name: string }) => f.name).sort(), FILES.map((f) => f.name).sort());

  const plannerRepo = repo('planner');
  const pilot: GoalPilot = createPilotRow({ goalId, plannerAgentId: cartridge(plannerRepo), intake: { goal: 'x' } });
  for (const kind of PILOT_REQUEST_KINDS) {
    const agentRepo = repo(kind);
    const agent = cartridge(agentRepo);
    const req = createRequestRow(pilot, kind, agent);
    setRequestPrompt(req.id, `[request ${kind}]`, false);
    const sent = deliverPlannerRequest(req.id, agent);
    assert.ok(sent.ok, `${kind}: ${sent.error}`);
    const prompt = lastPrompt(agent);
    assert.ok(prompt.startsWith(`[request ${kind}]`), `${kind}: the request itself was not delivered`);
    assertFilesIn(prompt, `${kind} request`);
    assert.ok(prompt.includes(agentRepo), `${kind}: the files must be copied into the agent's own repo`);
  }

  // A stage worked by two cartridges in two repos: both repos get the files, and the context names each.
  const [a, b] = [repo('stage-a'), repo('stage-b')];
  const stage = { id: 's1', position: 0, kind: 'build', key: 'k', templateId: '', template: 'Build', title: 'Build it', why: '', focus: 'build',
    repoPath: a, agentType: 'claude', participants: [{ repoPath: a, agentType: 'claude' }, { repoPath: b, agentType: 'codex' }],
    projectId: '', runId: '', agentId: '', status: 'pending', waitReason: '', resultSummary: '', attempts: 0, verifyState: 'none', requestId: '',
    startedAt: null, completedAt: null } as unknown as PilotStage;
  const context = buildStageContext(pilot, stage, [stage]);
  assertFilesIn(context, 'stage context');
  for (const r of [a, b]) assert.ok(context.includes(r), `stage context does not hand the files to ${r}`);

  // Removed: no longer handed out.
  const removed = listed.json.find((f: { name: string }) => f.name === 'brief.pdf');
  assert.equal((await call('DELETE', `/api/goals/${goalId}/files/${removed.id}`)).status, 204);
  const agent = cartridge(repo('after-remove'));
  const req = createRequestRow(pilot, 'scope', agent);
  setRequestPrompt(req.id, '[again]', false);
  deliverPlannerRequest(req.id, agent);
  assert.ok(!lastPrompt(agent).includes('brief.pdf'), 'a removed file is still handed out');
  assertFilesIn(lastPrompt(agent), 'after remove', ['mockup.png']);

  // Deleted feature: its stored files go too.
  const dir = featureFilesDir(goalId);
  assert.ok(fs.existsSync(dir));
  deleteFeatureCascade(goalId);
  assert.ok(!fs.existsSync(dir), 'deleting the feature left its files behind');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM goal_files WHERE goal_id = ?').get(goalId) as { n: number }).n, 0);
});

test('a feature with no files adds nothing to the prompt', () => {
  const goalId = createFeature({ projectId: '', name: 'No files' });
  const pilot = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: 'x' } });
  const agent = cartridge(repo('none'));
  const req = createRequestRow(pilot, 'scope', agent);
  setRequestPrompt(req.id, '[plain]', false);
  deliverPlannerRequest(req.id, agent);
  assert.equal(lastPrompt(agent), '[plain]');
});

test('files picked in the intake form reach the planner\'s very first scoping request', async () => {
  const plannerRepo = repo('intake');
  const planner = cartridge(plannerRepo);
  const out = await call('POST', '/api/goal-pilots', {
    intake: { goal: 'Import invoices', context: 'They arrive as CSV today.', workType: 'feature', done: 'Imported', involvement: 'balanced' },
    plannerAgentId: planner,
    files: FILES.map((f) => ({ name: f.name, mimeType: f.mimeType, size: f.content.length, dataBase64: b64(f.content) })),
  });
  assert.equal(out.status, 201, JSON.stringify(out.json));
  assertFilesIn(lastPrompt(planner), 'first scope request');
  assert.ok(lastPrompt(planner).includes(plannerRepo));
});

test('a bad file in the intake form creates nothing', async () => {
  const before = (db.prepare('SELECT COUNT(*) AS n FROM goals').get() as { n: number }).n;
  const out = await call('POST', '/api/goal-pilots', {
    intake: { goal: 'Broken upload', context: 'x', workType: 'feature', done: 'y', involvement: 'balanced' },
    plannerAgentId: cartridge(repo('bad')),
    files: [{ name: 'empty.txt', mimeType: 'text/plain', size: 0, dataBase64: '' }],
  });
  assert.equal(out.status, 400, JSON.stringify(out.json));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM goals').get() as { n: number }).n, before, 'a feature was created anyway');
});
