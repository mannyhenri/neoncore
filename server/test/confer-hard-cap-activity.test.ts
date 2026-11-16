/**
 * THE HARD CAP MUST NOT KILL A STEP THAT IS STILL BEING WORKED.
 *
 * On 2026-11-16 confer cd99be1e was failed at exactly 240 min on "Draft 1/3" with the error
 * "ALIVE but never signalling done — the work may well be finished". It was not finished: the
 * last pending cartridge (gl-dev) was running a 73-target Rust suite and had made a tool call
 * seconds earlier. The cap measured time since DISPATCH, so a long but active step looked the
 * same as a cartridge that finished and forgot to report.
 *
 * The cap is for the second case only. It now fails a step when it is past HARD_FAIL_MS AND no
 * pending participant has used a tool recently, with an absolute ceiling as the backstop so a
 * step can still never run forever.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import * as conductor from '../src/lib/confer-conductor.js';

const io = installStubIO();
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let seq = 0;

function agent(repo: string) {
  const id = `cap-${repo}-${++seq}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen)
    VALUES (?,?,'test',?,'cap','claude','working',?)`).run(id, id, `/tmp/cap-${repo}`, ago(0));
  io.connect(id); io.connectSocket(`sock-${id}`);
  return id;
}

function toolCall(agentId: string, at: string) {
  db.prepare(`INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp)
    VALUES (?, ?, 'PostToolUse', 'Bash', '{}', '', ?)`).run(crypto.randomUUID(), agentId, at);
}

/** A session on milestone 1, opened `age` ago, with `done` acknowledged and `slow` still pending. */
async function sessionAt(repo: string, age: number) {
  const done = agent(repo);
  const slow = agent(repo);
  const session = conductor.startConfer({
    repoName: 'cap', repoPath: `/tmp/cap-${repo}`, participantIds: [done, slow], task: 'cap', buildRounds: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  db.prepare("UPDATE confer_milestones SET status='done',done_ids=?,completed_at=? WHERE session_id=? AND idx=0")
    .run(JSON.stringify([done, slow]), ago(age), session.id);
  db.prepare("UPDATE confer_milestones SET status='active',done_ids=?,dispatched_at=? WHERE session_id=? AND idx=1")
    .run(JSON.stringify([done]), ago(age), session.id);
  db.prepare('UPDATE confer_sessions SET current_milestone=1 WHERE id=?').run(session.id);
  return { id: session.id, slow };
}

test('a step past the cap whose pending cartridge used a tool minutes ago keeps running', async () => {
  const s = await sessionAt('active', 5 * HOUR);
  toolCall(s.slow, ago(2 * 60_000));
  conductor.reconcileConfers();
  const after = conductor.getConfer(s.id)!;
  assert.equal(after.status, 'running', `killed an actively worked step: ${after.error}`);
});

test('a step past the cap whose pending cartridge has done nothing for an hour still fails as ALIVE-but-silent', async () => {
  const s = await sessionAt('idle', 5 * HOUR);
  toolCall(s.slow, ago(1 * HOUR));
  conductor.reconcileConfers();
  const after = conductor.getConfer(s.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error || '', /ALIVE but never signalling done/);
});

test('a pending cartridge that never used a tool at all fails at the cap, as before', async () => {
  const s = await sessionAt('never', 5 * HOUR);
  conductor.reconcileConfers();
  assert.equal(conductor.getConfer(s.id)!.status, 'failed');
});

test('activity cannot hold a step open forever — the absolute ceiling still fails it', async () => {
  const s = await sessionAt('forever', 13 * HOUR);
  toolCall(s.slow, ago(60_000));
  conductor.reconcileConfers();
  const after = conductor.getConfer(s.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error || '', /ceiling/i);
});

test('below the cap nothing fails, active or not', async () => {
  const s = await sessionAt('young', 2 * HOUR);
  conductor.reconcileConfers();
  assert.equal(conductor.getConfer(s.id)!.status, 'running');
});
