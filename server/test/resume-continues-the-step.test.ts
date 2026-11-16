// FIRST import — everything below reaches db.ts.
import './helpers/isolated-db.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { clearInterruptOnLife, recoverStep } from '../src/lib/recovery.ts';
import { installStubIO } from './helpers/stub-io.ts';

/**
 * AFTER A CRASH, A RESUMED CARTRIDGE IS TOLD TO FINISH THE STEP IT WAS ON.
 *
 * Found by cutting the power on the sandbox in the middle of "Root Cause Analysis" and clicking
 * Resume session: the cartridge came back as itself (same id, same session, conversation
 * restored) and then sat idle at its prompt. Resuming restores a conversation, not the turn that
 * was killed. The step stayed `running` — its `interrupted` flag cleared by the proof of life —
 * and nothing would have asked the agent to carry on for 90 minutes (the silent-step threshold).
 *
 * Now, on the resumed session's first sign of life, every step that cartridge owed gets one
 * message: you were interrupted here, check where the work stands, finish, report. Only after a
 * real Resume relaunch (`recovery_status = 'recovering'`): a cartridge that merely LOOKED dead
 * during a long tool call is in the middle of its turn and must not be told to start over.
 *
 * And a transcript REPLAY (engines that cannot resume) re-sends the step's stored prompt, which
 * may hold session references ("[Instructions … unchanged]") pointing at a session that is
 * gone — the replay expands them into the text.
 */

const io = installStubIO();
const AGENT = 'resume-agent';
let n = 0;

beforeEach(() => {
  io.connect(AGENT);
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type, recovery_status)
              VALUES (?, 'box/ledger', 'box', '/tmp/ledger', 'ledger', 'idle', ?, 'sess-1', 'claude', '')`).run(AGENT, new Date().toISOString());
});

function runningStep(prompt = '[neoncore step x #1]\nDo the root cause analysis.', config: Record<string, unknown> = { prompt: 'Do the root cause analysis.', role: 'reviewer' }): { stepId: string; runId: string } {
  const runId = `resume-run-${++n}`, stepId = `resume-step-${n}`, now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, status, template_id, run_number, created_at) VALUES (?, 'Bug Investigation', 'running', 'tpl', 3, ?)`).run(runId, now);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, depends_on, position_x, position_y, created_at, started_at,
              dispatched_prompt, dispatch_agent_id, dispatch_session_id, recovery_status, interrupted_at)
              VALUES (?, ?, 'Root Cause Analysis', 'running', 'claude-code', ?, ?, '[]', 0, 0, ?, ?, ?, ?, 'sess-1', 'interrupted', ?)`)
    .run(stepId, runId, AGENT, JSON.stringify(config), now, now, prompt, AGENT, now);
  return { stepId, runId };
}
const sentTo = (agentId: string) => (db.prepare('SELECT text FROM commands WHERE agent_id = ? ORDER BY rowid').all(agentId) as { text: string }[]).map((r) => r.text);

test('a cartridge relaunched by Resume is told, on its first sign of life, to finish the step it owed', () => {
  const { stepId } = runningStep();
  db.prepare("UPDATE agents SET recovery_status = 'recovering' WHERE id = ?").run(AGENT);
  const before = sentTo(AGENT).length;
  clearInterruptOnLife(AGENT);                                  // the resumed session's first hook
  const sent = sentTo(AGENT).slice(before);
  assert.equal(sent.length, 1, 'expected exactly one continuation message');
  const t = sent[0];
  assert.match(t, new RegExp(`\\[neoncore step ${stepId} #`), 'the continuation carries no step marker');
  assert.match(t, /interrupt/i);
  assert.match(t, /Root Cause Analysis/);
  assert.match(t, /git status/, 'the agent is not told to check where the work stands');
  assert.match(t, new RegExp(`stepId: "${stepId}"`), 'the agent is not told how to report');
  assert.match(t, new RegExp(`/api/workflows/steps/${stepId}/instructions`), 'no way back to the instructions if the resume lost them');
  const step = db.prepare('SELECT status, recovery_status FROM workflow_steps WHERE id = ?').get(stepId) as { status: string; recovery_status: string };
  assert.deepEqual(step, { status: 'running', recovery_status: '' });
  // No longer `recovering` (sending a command clears the recovery fields — existing behaviour), so
  // the continuation can fire only once; the next line checks that directly.
  assert.notEqual((db.prepare('SELECT recovery_status FROM agents WHERE id = ?').get(AGENT) as { recovery_status: string }).recovery_status, 'recovering');

  clearInterruptOnLife(AGENT);                                  // later signs of life: nothing more
  assert.equal(sentTo(AGENT).length, before + 1, 'the continuation was sent twice');
});

test('a cartridge that only LOOKED dead (a long tool call) is not told to start over', () => {
  runningStep();
  const before = sentTo(AGENT).length;
  clearInterruptOnLife(AGENT);                                  // recovery_status '' — no Resume happened
  assert.equal(sentTo(AGENT).length, before, 'a live agent mid-turn was sent a continuation');
});

test('a replay into a session that is gone expands the references the stored prompt holds', () => {
  const instructions = 'Trace the coupon path end to end and name the file and line where the total goes wrong.';
  const stored = [
    '[neoncore step s #1]',
    '[Instructions for "Root Cause Analysis": unchanged — the same as your earlier dispatch of this step in this session. Follow them again. '
      + 'If they are no longer in your context: curl -s "${NEONCORE_URL:-http://x}/api/workflows/steps/STEP/instructions" -H "x"]',
  ].join('\n');
  const { stepId } = runningStep('', { prompt: instructions, role: 'reviewer' });
  db.prepare('UPDATE workflow_steps SET dispatched_prompt = ? WHERE id = ?').run(stored.replace('STEP', stepId), stepId);
  const before = sentTo(AGENT).length;
  const r = recoverStep(stepId);
  assert.ok(r.ok, JSON.stringify(r));
  const replay = sentTo(AGENT).slice(before).join('\n');
  assert.ok(replay.includes(instructions), 'the replay carried the reference, not the instructions');
  assert.doesNotMatch(replay, /unchanged — the same as your earlier dispatch/);
});
