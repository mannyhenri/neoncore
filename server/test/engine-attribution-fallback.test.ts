/**
 * Attributing a trouble signal when the engine's step id is not OURS.
 *
 * The stepId lookup (engine-store.ts) assumes the emitting engine names a NeonCore
 * `workflow_steps.id`. Measured against the nine real events in the production database,
 * it never does:
 *
 *   real stepIds:      'converge-1', 'step-0', 's1'
 *   real step ids:     '0660cc69-d849-415b-a6c2-20820e0ea240' (390 rows, all uuids)
 *   events attributed: 0 of 9
 *
 * Those particular nine are correctly dropped — they came from gridlight running its OWN
 * workflow, and that agent owns zero NeonCore steps, so there is genuinely no function to
 * attribute them to. But the mismatch is structural, not incidental: NeonCore never hands
 * its step id to the engine (open-directory.ts sets GRIDLIGHT_SESSION_ID, MACHINE_NAME,
 * NEONCORE_URL and PERMISSION_MODE — no step id), so a gridlight cartridge running a
 * NeonCore step would STILL emit its own label and STILL be dropped. The demotion loop
 * could not fire on production data no matter how many turns failed.
 *
 * The fix uses a fact the database already has: while a cartridge executes a step, that
 * step's row carries `executor_id = <that agent>` and `status = 'running'`. So the agent
 * identifies the step even when the payload cannot.
 *
 * It stays EXACT rather than becoming a guess: attribution happens only when the agent owns
 * exactly ONE running step. Zero is nothing to attribute to, and two is ambiguous — both
 * drop, preserving the rule we already agreed on, that demoting the wrong function is worse
 * than demoting nothing because it removes work the model can do and leaves the real failure
 * in place.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { consumeActivityEvent, loadDemotions, clearDemotionsForModel } from '../src/lib/engine-store.js';
import { DEMOTION_FAILURE_THRESHOLD } from '../src/lib/engine-capability.js';

const MODEL = 'qwen2.5-coder-14b';

/** A payload shaped exactly like the real ones: the engine's OWN step label, not ours. */
function failingSignal(stepId: string) {
  return JSON.stringify({
    model: MODEL,
    stepId,
    signals: { proseInsteadOfToolCall: true, success: false },
    escalationHint: 'failing',
  });
}

let seq = 0;
function makeAgent(): string {
  const id = `agent-${++seq}`;
  db.prepare("INSERT INTO agents (id, name, machine, repo_path, agent_type, status, last_seen) VALUES (?,?,?,?,?,?,?)")
    .run(id, `test/${id}`, 'test-machine', '/tmp/repo', 'gridlight', 'working', new Date().toISOString());
  return id;
}

function makeStep(agentId: string, executorType: string, status: string): string {
  const now = new Date().toISOString();
  const wf = `wf-${++seq}`;
  db.prepare('INSERT OR IGNORE INTO workflows (id, name, created_at) VALUES (?,?,?)').run(wf, 't', now);
  const id = `step-${++seq}`;
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
    executor_type, executor_id, executor_config, auto_advance, status, depends_on, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, wf, 'step', '', 0, 0, executorType, agentId, '{}', 1, status, '[]', now);
  return id;
}

/** Drive enough failing turns to cross the demotion threshold. */
function drive(agentId: string, stepId: string) {
  for (let i = 0; i < DEMOTION_FAILURE_THRESHOLD; i++) {
    consumeActivityEvent('trouble_signals', failingSignal(stepId), agentId);
  }
}

const CASES: { label: string; runningSteps: string[]; expect: string[] }[] = [
  {
    label: 'exactly one running step — the agent identifies what the payload cannot',
    runningSteps: ['review-gate'],
    expect: ['review-gate'],
  },
  {
    label: 'no running step — nothing to attribute to, so nothing is demoted',
    runningSteps: [],
    expect: [],
  },
  {
    label: 'two running steps — ambiguous, so dropped rather than guessed',
    runningSteps: ['review-gate', 'claude-code'],
    expect: [],
  },
];

for (const c of CASES) {
  test(`unresolvable stepId, ${c.label}`, () => {
    clearDemotionsForModel(MODEL);
    const agent = makeAgent();
    for (const t of c.runningSteps) makeStep(agent, t, 'running');
    // A completed step must never be mistaken for the one in flight.
    makeStep(agent, 'quality-gate', 'completed');

    drive(agent, 'converge-1'); // the engine's own label — resolves to no NeonCore row

    assert.deepEqual(
      loadDemotions(MODEL).map((d) => d.functionId).sort(),
      [...c.expect].sort(),
    );
  });
}

test('a payload whose stepId DOES resolve still wins over the agent fallback', () => {
  clearDemotionsForModel(MODEL);
  const agent = makeAgent();
  makeStep(agent, 'claude-code', 'running');          // the fallback would pick this
  const real = makeStep(agent, 'review-gate', 'running'); // but the payload names this one

  drive(agent, real);

  assert.deepEqual(
    loadDemotions(MODEL).map((d) => d.functionId),
    ['review-gate'],
    'an explicit, resolvable step id is exact and must never be overridden by inference',
  );
});

/**
 * An EXPLICIT refusal must outrank our guess.
 *
 * The producer sends functionId: '' when it deliberately could not attribute a turn — two
 * different tools failed, so naming one would be a guess. With `||` that empty string read as
 * "absent" and fell through to the stepId/agent inference, turning the producer's refusal into
 * a false demotion through the exact door built to prevent them.
 */
test('an explicitly EMPTY functionId attributes to nothing, never to a guess', () => {
  clearDemotionsForModel(MODEL);
  const agent = makeAgent();
  makeStep(agent, 'review-gate', 'running'); // the agent fallback WOULD resolve to this

  for (let i = 0; i < DEMOTION_FAILURE_THRESHOLD; i++) {
    consumeActivityEvent('trouble_signals', JSON.stringify({
      model: MODEL,
      functionId: '',              // explicit refusal
      stepId: 'converge-1',
      signals: { proseInsteadOfToolCall: true, success: false },
    }), agent);
  }

  assert.deepEqual(
    loadDemotions(MODEL).map((d) => d.functionId), [],
    'an explicit empty functionId fell through to inference — the producer said "I cannot ' +
    'attribute this" and we demoted something anyway',
  );
});
