/**
 * A subagent finishing after the turn ended must not make the cartridge busy again.
 *
 * REPORTED: "we still have the issue of the agent being busy when it's not and this blocks a step
 * (step 2 in this case)". Seen live on the baseback cartridge: its turn ended at 14:10:45 (Stop →
 * completion check → idle), a background subagent reported SubagentStop at 14:13:50, and
 * SubagentStop was classified as WORKING — so the cartridge went back to `working` with nothing
 * running. No main Stop follows a subagent's, so nothing flipped it back: stage 2 waited on
 * "busy with other work" until the 2-minute staleness sweep released it. 765 SubagentStops sit in
 * the activity table; every late one re-arms the same wait.
 *
 * THE SET: FINISHED_EVENTS — events that report something ending, never something starting.
 * For each one:
 *   - a cartridge whose turn has ended stays idle, and the queue sees it as free;
 *   - a cartridge mid-turn stays working (no flicker to idle that would let work in early).
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import activityRouter from '../src/routes/activity.ts';
import { FINISHED_EVENTS, WORKING_EVENTS, statusFromActivity } from '../src/lib/activity-status.ts';
import { isCartridgeBusy } from '../src/lib/queue-runner.ts';
import { installStubIO } from './helpers/stub-io.ts';

const io = installStubIO();
let base = '';
let server: Server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', activityRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); });
  });
});
test.after(() => server?.close());

let n = 0;
function cartridge(status: 'idle' | 'working'): string {
  const id = `fe-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
              VALUES (?,?,'test',?,'repo','claude',?,?,?)`).run(id, id, `/tmp/fe-repo-${n}`, status, new Date().toISOString(), `fe-session-${n}`);
  io.connect(id);
  return id;
}
const statusOf = (id: string) => (db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
async function post(agentId: string, eventType: string) {
  const res = await fetch(`${base}/api/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, eventType, toolName: '', toolInput: {} }),
  });
  assert.equal(res.status, 201, `${eventType} was not accepted`);
}

test('the registry is not empty, and a finished event is never also a working event', () => {
  assert.ok(FINISHED_EVENTS.size > 0, 'FINISHED_EVENTS is empty — the registry moved');
  assert.ok(FINISHED_EVENTS.has('SubagentStop'), 'SubagentStop is the event seen live; it must be in the set');
  for (const e of FINISHED_EVENTS) {
    assert.ok(!WORKING_EVENTS.has(e), `${e} is in both FINISHED_EVENTS and WORKING_EVENTS`);
    assert.equal(statusFromActivity(e), null, `${e} must leave the status as it is`);
  }
});

test('EVERY finished event arriving after the turn ended leaves the cartridge idle and free', async () => {
  for (const e of FINISHED_EVENTS) {
    const id = cartridge('idle');
    await post(id, e);
    assert.equal(statusOf(id), 'idle', `${e} after the turn ended made the cartridge ${statusOf(id)}`);
    assert.equal(isCartridgeBusy(id), false, `${e} after the turn ended made the queue see the cartridge as busy`);
  }
});

test('EVERY finished event arriving mid-turn leaves the cartridge working', async () => {
  for (const e of FINISHED_EVENTS) {
    const id = cartridge('working');
    await post(id, e);
    assert.equal(statusOf(id), 'working', `${e} mid-turn changed the status to ${statusOf(id)}`);
  }
});
