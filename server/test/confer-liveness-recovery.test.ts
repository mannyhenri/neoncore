import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { inboxPathFor } from '../src/lib/inbox-client.js';
import { installStubIO } from './helpers/stub-io.js';
import * as conductor from '../src/lib/confer-conductor.js';

const io = installStubIO();
let seq = 0;
const old = () => new Date(Date.now() - 25 * 60_000).toISOString();
const fresh = () => new Date().toISOString();
function agent(mode: string, status = 'idle', seen = old()) {
  const id = `recover-${mode}-${++seq}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen)
    VALUES (?,?,'test',?,'recovery','claude',?,?)`).run(id,id,`/tmp/recovery-${mode}`,status,seen);
  return id;
}

for (const mode of conductor.CONFER_MODES) {
  test(`${mode}: all five liveness states distinguish a quiet connection from a dead participant`, async () => {
    const probe = (conductor as unknown as { participantIsAlive: (id:string, now:number)=>boolean }).participantIsAlive;
    assert.equal(typeof probe, 'function');
    const live = agent(mode, 'working', fresh());
    const socket = agent(mode); io.connect(socket); io.connectSocket(`sock-${socket}`);
    const inbox = agent(mode);
    const inboxPath = inboxPathFor(process.pid);
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(inboxPath, resolve));
    db.prepare('UPDATE agents SET inbox_pid = ? WHERE id = ?').run(process.pid, inbox);
    const disconnected = agent(mode);
    const offline = agent(mode, 'offline', fresh());
    for (const [id, expected] of [[live,true],[socket,true],[inbox,true],[disconnected,false],[offline,false]] as const) {
      assert.equal(probe(id,Date.now()), expected, `${mode}: ${id}`);
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test(`${mode}: resuming a failed milestone preserves every completed step and acknowledgement`, async () => {
    // Its own checkout: the liveness test above leaves a WORKING cartridge in /tmp/recovery-<mode>,
    // and a confer is held by a busy sibling in its repo (queue-runner busyRepoSiblings).
    const first = agent(`${mode}-resume`,'working',fresh());
    const second = agent(`${mode}-resume`,'working',fresh());
    io.connect(second); io.connectSocket(`sock-${second}`);
    const session = conductor.startConfer({repoName:'recovery',repoPath:`/tmp/recovery-${mode}-resume`,participantIds:[first,second],task:'recover',mode,buildRounds:2});
    await new Promise(resolve => setTimeout(resolve, 10));
    db.prepare("UPDATE confer_milestones SET status='done',done_ids=?,completed_at=? WHERE session_id=? AND idx=0")
      .run(JSON.stringify([first,second]),fresh(),session.id);
    db.prepare("UPDATE confer_milestones SET status='active',done_ids=?,dispatched_at=? WHERE session_id=? AND idx=1")
      .run(JSON.stringify([first]),old(),session.id);
    db.prepare("UPDATE confer_sessions SET status='failed',current_milestone=1,error='unreachable',completed_at=? WHERE id=?").run(fresh(),session.id);
    const resume = (conductor as unknown as {resumeConfer:(id:string)=>Promise<unknown>}).resumeConfer;
    assert.equal(typeof resume,'function');
    await resume(session.id);
    const after = conductor.getConfer(session.id)!;
    assert.equal(after.status,'running');
    assert.equal(after.currentMilestone,1);
    assert.equal(after.error,'');
    assert.deepEqual(after.milestones!.map(m=>m.status),['done','active',...after.milestones!.slice(2).map(()=> 'pending')]);
    assert.deepEqual(after.milestones![0].doneIds,[first,second]);
    assert.deepEqual(after.milestones![1].doneIds,[first]);
  });
}
