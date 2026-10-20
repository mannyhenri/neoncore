/**
 * A PROMPT THE ENGINE ALREADY RECEIVED IS NOT ORPHANED.
 *
 * Observed 2026-10-18: step "Architecture Mapping" was dispatched at 09:54:31, the cartridge's
 * UserPromptSubmit hook logged it at 09:54:32 — and the session guard re-sent the whole prompt
 * at 09:54:40. The session id recorded at dispatch was the row's PREVIOUS session; the prompt
 * itself started the new one. "Session changed" was read as "prompt lost", so the agent got the
 * same 4.6k-char task twice, mid-work.
 *
 * Two misjudgments, both covered here as one set of cases:
 *   1. The guard ignored the one signal that proves consumption — the engine's own prompt hook
 *      (activity.event_type = 'user_prompt'). Each step prompt now carries a unique marker on
 *      line 1, so the 4,000-char hook cap can never cut it off.
 *   2. The guard judged and re-sent to `executor_id`, but a review gate can dispatch to a
 *      different cartridge (`reviewAgentId`). The agent actually dispatched to is now recorded.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { redispatchOrphanedSteps, markStepPrompt, stepMarkerOf } from '../src/lib/step-session-guard.js';

installStubIO();

let n = 0;
const iso = () => new Date().toISOString();

function agentWithSession(sessionId: string): string {
  const id = `cg-ag-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status,
              last_seen, active_queue_item_id, pending_question, session_id)
              VALUES (?,?,'m',?,?,'claude','idle',?,'','',?)`)
    .run(id, `t/${id}`, `/r/${id}`, `r${id}`, iso(), sessionId);
  return id;
}

function step(opts: { executor: string; dispatchAgent?: string; dispatchSession: string }): { id: string; prompt: string } {
  const id = `cg-s-${++n}`;
  const prompt = markStepPrompt(id, 'do the research\n'.repeat(400)); // ~6.4k: past the hook cap
  db.prepare(`INSERT INTO workflows (id, name, status, template_id, created_at)
              VALUES (?,?, 'running','tpl',?)`).run(`w-${id}`, 'run', iso());
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id,
              executor_config, auto_advance, recovery_status, position_y, created_at, started_at,
              dispatched_prompt, dispatch_session_id, dispatch_agent_id, recovery_attempts)
              VALUES (?,?,?,'running','claude-code',?,'{}',1,'',0,?,?,?,?,?,0)`)
    .run(id, `w-${id}`, 'step', opts.executor, iso(), iso(), prompt, opts.dispatchSession, opts.dispatchAgent ?? '');
  return { id, prompt };
}

/** What the UserPromptSubmit hook records: the prompt, capped at 4,000 chars. */
function engineReceived(agentId: string, prompt: string, eventType = 'user_prompt'): void {
  db.prepare(`INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp)
              VALUES (?,?,?,'',?,'{}',?)`).run(`act-${++n}`, agentId, eventType, prompt.slice(0, 4000), iso());
}

const CASES: { label: string; make: () => { id: string; target: string }; resend: boolean; why: string }[] = [
  {
    label: 'session replaced, engine never logged the prompt',
    make: () => { const a = agentWithSession('NEW'); return { id: step({ executor: a, dispatchSession: 'OLD' }).id, target: a }; },
    resend: true, why: 'the real orphan — nobody read it',
  },
  {
    label: 'session replaced, engine DID log the prompt (the 2026-10-18 duplicate)',
    make: () => {
      const a = agentWithSession('NEW');
      const s = step({ executor: a, dispatchSession: 'OLD' });
      engineReceived(a, s.prompt);
      return { id: s.id, target: a };
    },
    resend: false, why: 'the prompt started the new session — re-sending duplicates live work',
  },
  {
    label: 'session replaced, only the SERVER logged the send (user_command)',
    make: () => {
      const a = agentWithSession('NEW');
      const s = step({ executor: a, dispatchSession: 'OLD' });
      engineReceived(a, s.prompt, 'user_command');
      return { id: s.id, target: a };
    },
    resend: true, why: 'the server writing its own log is not proof an engine read anything',
  },
  {
    label: 'a DIFFERENT step\'s prompt was logged',
    make: () => {
      const a = agentWithSession('NEW');
      const other = step({ executor: a, dispatchSession: 'NEW' });
      engineReceived(a, other.prompt);
      return { id: step({ executor: a, dispatchSession: 'OLD' }).id, target: a };
    },
    resend: true, why: 'consumption is per dispatch, not per agent',
  },
  {
    label: 'review gate: reviewer session replaced, executor unchanged',
    make: () => {
      const exec = agentWithSession('E1');
      const rev = agentWithSession('R2');
      return { id: step({ executor: exec, dispatchAgent: rev, dispatchSession: 'R1' }).id, target: rev };
    },
    resend: true, why: 'the reviewer is where the prompt went',
  },
  {
    label: 'review gate: executor session replaced, reviewer unchanged',
    make: () => {
      const exec = agentWithSession('E2');
      const rev = agentWithSession('R1');
      return { id: step({ executor: exec, dispatchAgent: rev, dispatchSession: 'R1' }).id, target: rev };
    },
    resend: false, why: 'the executor\'s session has nothing to do with the critic prompt',
  },
];

test('EVERY guard case is judged on whether the engine actually received the prompt', () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const { id } = c.make();
    const resent = redispatchOrphanedSteps().includes(id);
    if (resent !== c.resend) wrong.push(`${c.label}: resent=${resent}, expected ${c.resend} — ${c.why}`);
  }
  assert.deepEqual(wrong, [], `the session guard misjudges:\n  ${wrong.join('\n  ')}`);
});

test('a re-send goes to the agent the prompt was dispatched to, not the step executor', () => {
  const exec = agentWithSession('E9');
  const rev = agentWithSession('R9-NEW');
  const { id } = step({ executor: exec, dispatchAgent: rev, dispatchSession: 'R9-OLD' });
  const before = (db.prepare('SELECT COUNT(*) c FROM commands WHERE agent_id = ?').get(rev) as { c: number }).c;
  assert.ok(redispatchOrphanedSteps().includes(id));
  const after = (db.prepare('SELECT COUNT(*) c FROM commands WHERE agent_id = ?').get(rev) as { c: number }).c;
  const toExec = (db.prepare('SELECT COUNT(*) c FROM commands WHERE agent_id = ?').get(exec) as { c: number }).c;
  assert.equal(after - before, 1, 'the reviewer did not get the re-send');
  assert.equal(toExec, 0, 'the critic prompt was sent to the executor');
});

test('a consumed prompt adopts the live session so it is not re-judged every sweep', () => {
  const a = agentWithSession('LIVE');
  const s = step({ executor: a, dispatchSession: 'STALE' });
  engineReceived(a, s.prompt);
  redispatchOrphanedSteps();
  const row = db.prepare('SELECT dispatch_session_id, recovery_attempts FROM workflow_steps WHERE id = ?')
    .get(s.id) as { dispatch_session_id: string; recovery_attempts: number };
  assert.deepEqual(row, { dispatch_session_id: 'LIVE', recovery_attempts: 0 });
});

test('the marker is on line 1, unique per dispatch, and survives the 4,000-char hook cap', () => {
  const a = markStepPrompt('step-x', 'x'.repeat(9000));
  const b = markStepPrompt('step-x', 'x'.repeat(9000));
  assert.ok(stepMarkerOf(a));
  assert.notEqual(stepMarkerOf(a), stepMarkerOf(b), 'two dispatches of one step must be told apart');
  assert.ok(a.slice(0, 4000).includes(stepMarkerOf(a)!));
  assert.equal(stepMarkerOf('no marker here'), null);
});

test('EVERY site that stores a dispatched prompt marks it and records the agent it went to', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/workflow-executor-v2.ts'), 'utf8');
  const writes = [...src.matchAll(/dispatched_prompt = \?/g)];
  assert.ok(writes.length >= 3, `expected the known dispatch sites, found ${writes.length}`);
  const bad: string[] = [];
  for (const m of writes) {
    const line = src.slice(0, m.index!).split('\n').length;
    const around = src.slice(m.index!, m.index! + 400);
    if (!/dispatch_agent_id = \?/.test(around)) bad.push(`line ${line}: agent not recorded`);
    const before = src.slice(Math.max(0, m.index! - 1500), m.index!);
    if (!/markStepPrompt\(/.test(before)) bad.push(`line ${line}: prompt not marked`);
  }
  assert.deepEqual(bad, []);
});
