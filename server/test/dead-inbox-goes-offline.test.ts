/**
 * A CARTRIDGE NOTHING CAN REACH IS NOT "IDLE".
 *
 * Reported as: "another bug trying a workflow with film engine why?" — and "find out first why
 * the workflow doesn't start in film engine, start it and then fix the why".
 *
 * film-engine's relay died at some point overnight. Its inbox (the session it had spawned) died
 * with it. But the row stayed `idle`, with inbox_pid 57413 pointing at a process that no longer
 * existed, for 14 hours — a Claude cartridge is only reaped after 24h of silence, and nothing
 * looked at the pid. The dashboard kept offering it, the Deep Research run was launched onto
 * it, and the first step failed at dispatch with "the inbox of film-engine refused it
 * (stale-pid: pid 57413 is not a live process…)". Even that refusal left it `idle`.
 *
 * A recorded inbox pid that is not a live process, with no relay socket, is not a timer guess —
 * it is proof. SET-BASED over both places that can see that proof:
 *   1. the periodic reaper, whatever the last_seen age;
 *   2. the dispatch path, the moment an inbox refuses a hand-off as stale-pid / no-socket.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { installStubIO } from './helpers/stub-io.ts';
import db from '../src/db.ts';
import { findDeadInboxes, markUnreachable } from '../src/lib/dead-inbox.ts';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { whenInboxSettles } from '../src/lib/send-command.ts';

installStubIO();

/** A pid that certainly WAS a process and certainly is not one now. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(String(r.stdout));
}

let n = 0;
function cartridge(status: string, inboxPid: number, lastSeen = new Date().toISOString()): string {
  const id = `dead-inbox-${process.pid}-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,inbox_pid,inbox_token)
     VALUES (?,?,?,?,?,'claude',?,?,?,?,'tok')`,
  ).run(id, id, os.hostname(), '/tmp', id, status, lastSeen, `s-${id}`, inboxPid);
  return id;
}
const row = (id: string) => db.prepare('SELECT status, inbox_pid FROM agents WHERE id = ?').get(id) as { status: string; inbox_pid: number };
const noSocket = () => false;

// ── 1. The periodic reaper ─────────────────────────────────────────────────────────────

for (const status of ['idle', 'waiting', 'working']) {
  test(`reaper: a ${status} cartridge whose inbox pid is dead goes offline — even if seen seconds ago`, () => {
    const id = cartridge(status, deadPid());
    assert.ok(findDeadInboxes(db, { hasActiveSocket: noSocket }).includes(id),
      'a cartridge with a dead inbox and no relay was not recognised as unreachable');
    for (const dead of findDeadInboxes(db, { hasActiveSocket: noSocket })) markUnreachable(dead, 'dead-inbox');
    assert.deepEqual(row(id), { status: 'offline', inbox_pid: 0 },
      'still offered as available, still pointing at a process that is gone');
  });
}

test('reaper: a live inbox pid is left alone', () => {
  const id = cartridge('idle', process.pid);
  assert.ok(!findDeadInboxes(db, { hasActiveSocket: noSocket }).includes(id));
});

test('reaper: a live relay socket outranks a stale pid', () => {
  const id = cartridge('idle', deadPid());
  assert.ok(!findDeadInboxes(db, { hasActiveSocket: (a) => a === id }).includes(id),
    'a connected relay is proof of life; the pid is only evidence when nothing else is');
});

test('reaper: no recorded inbox (a hooks-only session) is not evidence of death', () => {
  const id = cartridge('idle', 0);
  assert.ok(!findDeadInboxes(db, { hasActiveSocket: noSocket }).includes(id));
});

test('reaper: a cartridge on ANOTHER machine is never judged by a pid on this one', () => {
  const id = cartridge('idle', deadPid());
  db.prepare("UPDATE agents SET machine = 'some-other-mac.local' WHERE id = ?").run(id);
  assert.ok(!findDeadInboxes(db, { hasActiveSocket: noSocket }).includes(id));
});

// ── 2. The dispatch path ───────────────────────────────────────────────────────────────

test('dispatch: an inbox that refuses as stale-pid marks the cartridge offline on the spot', async () => {
  const id = cartridge('idle', deadPid());
  const cmd = sendCommandToAgent(id, 'research ComfyUI', false);
  assert.ok(cmd, 'the command should be recorded');
  const out = await whenInboxSettles(cmd!.id);
  assert.equal(out?.ok, false);
  assert.equal(row(id).status, 'offline',
    'the dispatch proved nothing can reach this cartridge, and it is still offered as idle');
});
