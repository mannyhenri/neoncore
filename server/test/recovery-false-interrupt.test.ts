/**
 * A healthy agent must not stay marked dead.
 *
 * WHAT HAPPENED, from the real activity table. gridlight ran `cargo test --bins licensing…`
 * and produced no events between 12:30:25 and 12:37:03 — a 6m38s gap, because PostToolUse
 * only fires when a tool FINISHES. `EXECUTOR_STALE_MS` is 5 minutes, so at 12:36:05 the
 * reconciler judged the executor dead and marked two running workflow steps `interrupted`.
 * At 12:37:03 the same agent posted activity again, proving it had been alive the whole time.
 *
 * Nothing un-marked them. The only thing that clears `recovery_status` is send-command.ts,
 * on a NEW dispatch — so a false positive is a one-way door, and the step stays stranded with
 * a "Session interrupted" banner over work that never stopped.
 *
 * THE FIX IS SELF-HEALING, NOT A BIGGER THRESHOLD. Tuning EXECUTOR_STALE_MS upward only moves
 * the cliff: a cargo build, an npm install, a large test suite will all eventually cross it,
 * and raising it delays detection of agents that really did die. Instead, proof of life
 * REVERSES the verdict. That is safe precisely because the detector re-fires: if the agent
 * goes quiet again it is re-marked within one sweep, so a wrongly-cleared interrupt costs a
 * few minutes, while a wrongly-kept one strands live work indefinitely.
 *
 * The set below is every way an agent demonstrates it is alive, derived from the call sites
 * that write `last_seen` FROM the agent's own traffic. Clearing on only one of them is the
 * half-fix this test exists to prevent: the gridlight case would be fixed while an agent that
 * proves itself by asking a permission question stays stranded.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { clearInterruptOnLife, reconcileInterruptedSteps } from '../src/lib/recovery.ts';
import { EXECUTOR_STALE_MS, DEFAULT_GRACE_MS } from '../src/lib/recovery-core.ts';

installStubIO();

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

let n = 0;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function agent(lastSeenMs = 0, status = 'working'): string {
  const id = `fi-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/repo/f', 'f', 'claude', status, ago(lastSeenMs));
  return id;
}

/** A running step owned by `executor`, started long enough ago to be past the grace window. */
function step(executor: string, recovery = ''): string {
  const wf = `wf-fi-${n}`;
  const id = `st-fi-${++n}`;
  db.prepare("INSERT OR IGNORE INTO workflows (id, name, status, created_at) VALUES (?,?,'running',?)")
    .run(wf, wf, new Date().toISOString());
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id,
              created_at, started_at, recovery_status)
              VALUES (?,?,?,'running','cartridge',?,?,?,?)`)
    .run(id, wf, 'a step', executor, new Date().toISOString(), ago(DEFAULT_GRACE_MS * 3), recovery);
  return id;
}
const recoveryOf = (id: string) =>
  (db.prepare('SELECT recovery_status FROM workflow_steps WHERE id = ?').get(id) as { recovery_status: string }).recovery_status;

// ─── The exact scenario that happened ───────────────────────────────────────

test('the gridlight case: a long tool call strands a step, and proof of life releases it', () => {
  // Alive, but silent for longer than the stale window — i.e. mid-`cargo test`.
  const a = agent(EXECUTOR_STALE_MS + 60_000, 'working');
  const s = step(a);

  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), 'interrupted', 'the reconciler should mark a silent executor');

  // The tool finishes and the hook posts. That is proof it was never dead.
  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), a);
  const cleared = clearInterruptOnLife(a);

  assert.equal(cleared, 1, 'proof of life must release the step it wrongly stranded');
  assert.equal(recoveryOf(s), '', 'the step is still flagged interrupted after the agent proved alive');
});

test('clearing is SAFE because the detector re-fires if the agent goes quiet again', () => {
  // This is the whole argument for reversing the verdict rather than raising the threshold.
  // A wrongly-cleared interrupt costs one sweep; a wrongly-kept one strands work forever.
  const a = agent(0, 'working');
  const s = step(a);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), '', 'a fresh agent should not be marked at all');

  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(ago(EXECUTOR_STALE_MS + 60_000), a);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), 'interrupted', 'a genuinely silent agent must still be caught');

  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), a);
  clearInterruptOnLife(a);
  assert.equal(recoveryOf(s), '');

  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(ago(EXECUTOR_STALE_MS + 60_000), a);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(s), 'interrupted', 'the detector did not re-fire — clearing is now a permanent blindfold');
});

// ─── What it must NOT do ────────────────────────────────────────────────────

test('proof of life from ONE agent never clears another agent\'s interrupt', () => {
  const alive = agent(0, 'working');
  const dead = agent(EXECUTOR_STALE_MS * 3, 'offline');
  const deadStep = step(dead);
  reconcileInterruptedSteps();
  assert.equal(recoveryOf(deadStep), 'interrupted');

  clearInterruptOnLife(alive);
  assert.equal(recoveryOf(deadStep), 'interrupted',
    'one agent waking up cleared a different agent\'s genuinely interrupted step');
});

test('a step that is no longer running is left alone', () => {
  // Recovery state on a finished step is history. Clearing it would rewrite the record of an
  // interruption that really happened and was really recovered from.
  const a = agent(0, 'working');
  const s = step(a, 'interrupted');
  db.prepare("UPDATE workflow_steps SET status = 'completed' WHERE id = ?").run(s);
  clearInterruptOnLife(a);
  assert.equal(recoveryOf(s), 'interrupted', 'a completed step\'s recovery history was rewritten');
});

test('an agent with nothing stranded is a no-op, not an error', () => {
  const a = agent(0, 'working');
  step(a);
  assert.equal(clearInterruptOnLife(a), 0);
  assert.equal(clearInterruptOnLife('no-such-agent'), 0);
});

// ─── THE SET: every signal that proves an agent is alive must clear ─────────

/**
 * Derived from the call sites that write `last_seen` out of the AGENT's own traffic.
 * Deliberately excludes trust.ts and epics.ts: those are a human toggling a setting from the
 * dashboard, which says nothing about whether the cartridge is still executing.
 */
const PROOF_OF_LIFE: { file: string; label: string; anchor: string }[] = [
  { file: 'routes/activity.ts', label: 'a tool hook posted activity', anchor: "status = 'working'" },
  { file: 'routes/agents.ts', label: 'the agent sent a message', anchor: 'last_message' },
  { file: 'routes/permissions.ts', label: 'the agent asked for permission', anchor: "status = 'waiting'" },
];

test('EVERY proof-of-life signal releases a false interrupt', () => {
  const missing: string[] = [];
  for (const p of PROOF_OF_LIFE) {
    const src = read(p.file);
    if (!src.includes('clearInterruptOnLife')) {
      missing.push(`${p.file} (${p.label}) never releases a stranded step`);
    }
  }
  assert.deepEqual(missing, [],
    `these signals prove the agent is alive but leave it marked dead:\n  ${missing.join('\n  ')}`);
});

test('send-command still clears on dispatch — the path that already worked', () => {
  // Regression guard on the one place that was already correct, so consolidating onto the new
  // helper cannot silently drop it.
  const src = read('lib/send-command.ts');
  assert.match(src, /recovery_status = ''|clearInterruptOnLife/,
    'dispatching to an agent no longer clears its interrupted steps');
});
