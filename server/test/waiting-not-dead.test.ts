/**
 * An agent blocked on a human is not a dead one.
 *
 * `detectInterruptedSteps` infers death from silence: no tool events for EXECUTOR_STALE_MS
 * (5 minutes) and no live socket means the executor is gone. That inference is sound for a
 * crash and wrong for a question — an agent that stopped to ask you something produces no tool
 * events BY DEFINITION, and will cross the threshold every single time while behaving
 * perfectly. It then gets its running step marked `interrupted`.
 *
 * Before the notification→waiting mapping this was invisible: a blocked agent was recorded as
 * `working` and aged to `idle`, so nothing could tell the two apart. Now that `waiting` is a
 * real state, the sweep can and must respect it.
 *
 * The self-heal (clearInterruptOnLife) does NOT cover this case, which is why the exemption is
 * necessary rather than merely tidy: it fires on the agent's next activity, and an agent
 * waiting on a human emits nothing until the human acts. The false interrupt would stand for
 * exactly as long as you took to answer.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { reconcileInterruptedSteps } from '../src/lib/recovery.ts';
import { EXECUTOR_STALE_MS, DEFAULT_GRACE_MS } from '../src/lib/recovery-core.ts';

installStubIO();

let n = 0;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** An agent that has been silent long enough to look dead to the sweep. */
function silentAgent(status: string): string {
  const id = `wnd-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/r', 'r', 'claude', status, ago(EXECUTOR_STALE_MS + 60_000));
  return id;
}

function runningStep(executor: string): string {
  const wf = `wf-wnd-${n}`;
  const id = `st-wnd-${++n}`;
  db.prepare("INSERT OR IGNORE INTO workflows (id, name, status, created_at) VALUES (?,?,'running',?)")
    .run(wf, wf, new Date().toISOString());
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id,
              created_at, started_at, recovery_status)
              VALUES (?,?,?,'running','cartridge',?,?,?,'')`)
    .run(id, wf, 'a step', executor, new Date().toISOString(), ago(DEFAULT_GRACE_MS * 3));
  return id;
}
const recoveryOf = (id: string) =>
  (db.prepare('SELECT recovery_status FROM workflow_steps WHERE id = ?').get(id) as { recovery_status: string }).recovery_status;

test('a WAITING agent is never marked interrupted, however long it waits', () => {
  const a = silentAgent('waiting');
  const s = runningStep(a);

  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), '',
    'an agent blocked on a human was declared dead for not producing tool events');

  // Still waiting an hour later. Silence is expected here, not evidence.
  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(ago(EXECUTOR_STALE_MS * 12), a);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), '', 'the exemption expired — a long wait is still a wait');
});

test('a genuinely silent WORKING agent is still caught — the sweep is not disabled', () => {
  // The exemption must be narrow. If it swallowed the crash case too, every stranded step
  // would sit `running` forever with nothing to notice it.
  const a = silentAgent('working');
  const s = runningStep(a);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), 'interrupted',
    'the sweep no longer detects a dead executor');
});

test('an OFFLINE agent is still caught even if it was waiting when it died', () => {
  // `waiting` means "blocked on a person"; `offline` is a real death signal that outranks it.
  // Without this, an agent that died mid-question would be exempt forever.
  const a = silentAgent('offline');
  const s = runningStep(a);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), 'interrupted',
    'an offline agent was exempted because of a stale waiting flag');
});

test('the exemption is decided by STATUS, not by how long it has been quiet', () => {
  // Two agents, identical silence, different states — only the waiting one is spared.
  const waiting = silentAgent('waiting');
  const working = silentAgent('working');
  const sw = runningStep(waiting);
  const sk = runningStep(working);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(sw), '');
  assert.equal(recoveryOf(sk), 'interrupted');
});
