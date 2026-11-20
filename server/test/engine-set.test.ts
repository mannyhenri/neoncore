/**
 * The engine set is EXACTLY [claude, codex], everywhere the server keeps one — and a database
 * that still names a retired engine is cleaned up at startup.
 *
 * Set-based on purpose: it iterates every engine list the server, the relay and the pipeline
 * keep, and asserts each one equals the supported set. A third engine wired into any of them
 * (or a retired one left behind in one) fails here, instead of a test that only proves one
 * particular name is absent.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import db, { retireUnsupportedEngines } from '../src/db.ts';
import { SUPPORTED_ENGINES, type AgentType } from '../src/types.ts';
import { PILOT_ENGINES, ENGINE_LABEL } from '../src/lib/goal-pilot-runner.ts';
import { RELAY_LAUNCH_TYPES } from '../src/lib/open-directory.ts';
import { DEATH_REPORTING_TYPES } from '../src/lib/zombie-reaper.ts';
// @ts-expect-error — plain .mjs module, no type declarations
import { RESUME_ARGS, TRANSCRIPT_LOCATORS } from '../../agent/relay/resume-args.mjs';
import agentsRouter from '../src/routes/agents.ts';
import { installStubIO } from './helpers/stub-io.js';

installStubIO();

const EXPECTED = ['claude', 'codex'];
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

test('every engine list is exactly [claude, codex]', () => {
  const lists: Record<string, string[]> = {
    'types.ts SUPPORTED_ENGINES': sorted(SUPPORTED_ENGINES),
    'goal-pilot-runner PILOT_ENGINES': sorted(PILOT_ENGINES),
    'goal-pilot-runner ENGINE_LABEL keys': sorted(Object.keys(ENGINE_LABEL)),
    'open-directory RELAY_LAUNCH_TYPES values': sorted(Object.values(RELAY_LAUNCH_TYPES)),
    'relay RESUME_ARGS keys': sorted(Object.keys(RESUME_ARGS)),
    'relay TRANSCRIPT_LOCATORS keys': sorted(Object.keys(TRANSCRIPT_LOCATORS)),
  };
  const wrong = Object.entries(lists)
    .filter(([, got]) => JSON.stringify(got) !== JSON.stringify(EXPECTED))
    .map(([name, got]) => `${name}: [${got.join(', ')}]`);
  assert.deepEqual(wrong, [], `engine lists drifted from [${EXPECTED.join(', ')}]:\n  ${wrong.join('\n  ')}`);
});

test('every engine with a death signal is a supported engine', () => {
  const strays = [...DEATH_REPORTING_TYPES].filter((t) => !EXPECTED.includes(t));
  assert.deepEqual(strays, []);
});

test('startup retires every row that names an unsupported engine, and is idempotent', () => {
  const ISO = new Date().toISOString();
  const RETIRED = 'retired-engine';
  db.pragma('foreign_keys = OFF');
  try {
    const insertAgent = db.prepare(`INSERT INTO agents (id, name, machine, repo_path, last_seen, agent_type)
                                    VALUES (?, ?, 'm', ?, ?, ?)`);
    insertAgent.run('ret-1', 'old', '/r/old', ISO, RETIRED);
    insertAgent.run('keep-claude', 'c', '/r/old', ISO, 'claude');
    insertAgent.run('keep-codex', 'x', '/r/x', ISO, 'codex');
    db.prepare(`INSERT INTO activity (id, agent_id, event_type, timestamp) VALUES ('act-1', 'ret-1', 'tool', ?)`).run(ISO);
    db.prepare(`INSERT INTO messages (id, agent_id, session_id, seq, role, engine, ts)
                VALUES ('msg-1', 'keep-claude', 's', 1, 'user', ?, ?)`).run(RETIRED, ISO);
    db.prepare(`INSERT INTO goal_pilot_stages (id, pilot_id, position, agent_type, participants)
                VALUES ('st-1', 'p', 0, ?, ?)`)
      .run(RETIRED, JSON.stringify([{ repoPath: '/a', agentType: 'codex' }, { repoPath: '/b', agentType: RETIRED }]));
    db.prepare(`INSERT INTO acceptance_contracts (id, pilot_id, goal_id, agent_type, created_at, updated_at)
                VALUES ('ac-1', 'p', 'g', ?, ?, ?)`).run(RETIRED, ISO, ISO);
    db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, executor_type, executor_config, created_at)
                VALUES ('ws-1', 'w', 'n', 'claude-code', ?, ?), ('ws-2', 'w', 'n', 'claude-code', ?, ?)`)
      .run(JSON.stringify({ agentType: RETIRED, keep: 1 }), ISO, JSON.stringify({ agentType: 'codex' }), ISO);
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const first = retireUnsupportedEngines();
  assert.equal(first.removed, 1, 'the retired cartridge was not removed');

  const ids = (db.prepare('SELECT id FROM agents ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  assert.ok(!ids.includes('ret-1') && ids.includes('keep-claude') && ids.includes('keep-codex'), ids.join(','));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM activity WHERE agent_id = 'ret-1'`).get().n, 0);
  assert.equal(db.prepare(`SELECT engine FROM messages WHERE id = 'msg-1'`).get().engine, 'claude');
  const stage = db.prepare(`SELECT agent_type, participants FROM goal_pilot_stages WHERE id = 'st-1'`).get() as
    { agent_type: string; participants: string };
  assert.equal(stage.agent_type, 'claude');
  assert.deepEqual(JSON.parse(stage.participants).map((p: { agentType: string }) => p.agentType), ['codex', 'claude']);
  assert.equal(db.prepare(`SELECT agent_type FROM acceptance_contracts WHERE id = 'ac-1'`).get().agent_type, 'claude');
  assert.deepEqual(JSON.parse(db.prepare(`SELECT executor_config FROM workflow_steps WHERE id = 'ws-1'`).get().executor_config),
    { agentType: 'claude', keep: 1 });
  assert.deepEqual(JSON.parse(db.prepare(`SELECT executor_config FROM workflow_steps WHERE id = 'ws-2'`).get().executor_config),
    { agentType: 'codex' });

  assert.deepEqual(retireUnsupportedEngines(), { removed: 0, relabelled: 0 }, 'a second run changed rows');
});

test('/register refuses an unsupported engine and accepts every supported one', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents`;
  const register = (agentType: string) => fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', machine: 'engine-set-m', repoPath: `/r/${agentType}`, sessionId: `s-${agentType}`, agentType }),
  });
  try {
    for (const t of SUPPORTED_ENGINES as readonly AgentType[]) {
      assert.ok((await register(t)).ok, `${t} was refused`);
    }
    assert.equal((await register('retired-engine')).status, 400);
  } finally {
    server.close();
  }
});
