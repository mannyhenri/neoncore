import { test } from 'node:test';
import assert from 'node:assert/strict';
// MUST be first: sets NEONCORE_DB_PATH before any module opens the database. ESM imports
// are hoisted, so a bare assignment in this file's body would run too late.
import './helpers/isolated-db.js';
import { FUNCTIONS, DEMOTION_CONSECUTIVE_FAILURES, type CapabilityProfile } from '../src/lib/engine-capability.js';
import { eligibilityMap, routeFunction } from '../src/lib/engine-router.js';
import {
  saveProfile, loadProfile, recordDemotion, loadDemotions,
  clearDemotionsForModel, observeTroubleSignals, consumeActivityEvent,
} from '../src/lib/engine-store.js';
import db from '../src/db.js';

/**
 * The half that did not exist.
 *
 * Every test before this one exercised the router as a library. The feature was still a
 * dead drop in both directions: nothing persisted a profile, and nothing had EVER read the
 * trouble_signals events Gridlight has been emitting since the second confer. A library
 * with passing tests that nothing calls is exactly the shape of that bug, so these tests
 * assert the wiring, not the logic.
 */

const MODEL = 'test-integration-model';

function profileFor(modelId: string): CapabilityProfile {
  return {
    modelId,
    measuredAt: new Date().toISOString(),
    vector: { toolCall: 1, safeEdit: 1, comprehension: 1, synthesis: 1, planning: 1, judgement: 1, instructionAdherence: 1 },
    trials: { toolCall: 20, safeEdit: 20, comprehension: 20, synthesis: 20, planning: 20, judgement: 20, instructionAdherence: 20 },
    interactiveTurnSeconds: 3,
    perDimensionSeconds: { toolCall: 3, safeEdit: 3, comprehension: 3, synthesis: 3, planning: 3, judgement: 3, instructionAdherence: 3 },
  };
}

test('a profile round-trips through the store', () => {
  const p = profileFor(MODEL);
  saveProfile(p);
  const back = loadProfile(MODEL);
  assert.ok(back, 'profile did not persist');
  assert.equal(back.modelId, MODEL);
  assert.equal(back.vector.toolCall, 1);
  assert.equal(back.trials?.toolCall, 20);
  assert.equal(back.interactiveTurnSeconds, 3);
});

test('an unknown model has no profile — and that means frontier, not permission', () => {
  assert.equal(loadProfile('never-measured-model'), null);
  const decisions = FUNCTIONS.filter((f) => f.tier !== 'T0')
    .map((f) => routeFunction(f.id, loadProfile('never-measured-model')));
  const leaked = decisions.filter((d) => d.engine === 'local').map((d) => d.functionId);
  assert.deepEqual(leaked, [], `unmeasured model routed local: ${leaked.join(', ')}`);
});

test('a persisted demotion overrides an ELIGIBLE verdict — for every function', () => {
  const p = profileFor(MODEL);
  saveProfile(p);
  clearDemotionsForModel(MODEL);

  // Set-based: demote each function in turn and assert the override holds for all of them,
  // not just the one convenient example.
  const failures: string[] = [];
  for (const fn of FUNCTIONS.filter((f) => f.tier !== 'T0')) {
    const before = routeFunction(fn.id, p, loadDemotions(MODEL));
    if (before.engine !== 'local') continue; // only meaningful where it WOULD have gone local
    recordDemotion(MODEL, fn.id, 'test-induced');
    const after = routeFunction(fn.id, p, loadDemotions(MODEL));
    if (after.engine !== 'frontier' || after.state !== 'INELIGIBLE') {
      failures.push(`${fn.id}: ${after.engine}/${after.state}`);
    }
  }
  assert.deepEqual(failures, [], `demotion did not override: ${failures.join(', ')}`);
  clearDemotionsForModel(MODEL);
});

test('re-probing clears demotions — the loop is a loop, not a ratchet', () => {
  // DECIDED-AND-MARKED: demotions do not expire on a timer; re-running the probe for a
  // model clears them. The probe is the authority; demotions are evidence accumulated
  // between probes. Without this, one bad turn on a flaky day pins a function to frontier
  // forever and the map can only ever get more pessimistic.
  saveProfile(profileFor(MODEL));
  recordDemotion(MODEL, 'read_file', 'test-induced');
  assert.ok(loadDemotions(MODEL).some((d) => d.functionId === 'read_file' && d.demoted));

  saveProfile(profileFor(MODEL)); // a fresh measurement
  assert.deepEqual(loadDemotions(MODEL), [], 're-probing left stale demotions behind');
});

test('trouble_signals are consumed: N consecutive failures demote', () => {
  saveProfile(profileFor(MODEL));
  clearDemotionsForModel(MODEL);

  const failing = {
    model: MODEL,
    stepId: 's1',
    escalationHint: 'failing',
    signals: {
      proseInsteadOfToolCall: true, emptyResponse: false, apiRetries: 0, toolErrors: 0,
      stepThrew: false, outputHasErrors: false, pendingQuestion: false,
      progress: { completed: 0, total: 1, percent: 0 }, success: false, testSuite: 'unknown',
    },
  };

  // One failure must NOT demote — a single bad turn is noise.
  observeTroubleSignals('read_file', failing);
  assert.deepEqual(loadDemotions(MODEL), [], 'demoted on a single failure');

  // N consecutive failures must.
  for (let i = 1; i < DEMOTION_CONSECUTIVE_FAILURES; i++) observeTroubleSignals('read_file', failing);
  const dem = loadDemotions(MODEL);
  assert.ok(dem.some((d) => d.functionId === 'read_file' && d.demoted),
    `expected demotion after ${DEMOTION_CONSECUTIVE_FAILURES} consecutive failures, got ${JSON.stringify(dem)}`);
  // The row must say WHY, or a human cannot audit the decision.
  assert.match(dem.find((d) => d.functionId === 'read_file')!.reason ?? '', /prose|signal|fail/i);
  clearDemotionsForModel(MODEL);
});

test('a success resets the consecutive-failure count', () => {
  saveProfile(profileFor(MODEL));
  clearDemotionsForModel(MODEL);
  const bad = { model: MODEL, stepId: 's', escalationHint: 'failing', signals: { success: false, proseInsteadOfToolCall: true } };
  const good = { model: MODEL, stepId: 's', escalationHint: 'none', signals: { success: true } };

  for (let i = 0; i < DEMOTION_CONSECUTIVE_FAILURES - 1; i++) observeTroubleSignals('search_code', bad);
  observeTroubleSignals('search_code', good);          // resets
  observeTroubleSignals('search_code', bad);           // back to 1, must not demote
  assert.deepEqual(loadDemotions(MODEL).filter((d) => d.functionId === 'search_code'), [],
    'a success did not reset the failure streak');
  clearDemotionsForModel(MODEL);
});

test('the eligibility map reflects store state end to end, across the whole registry', () => {
  saveProfile(profileFor(MODEL));
  clearDemotionsForModel(MODEL);
  const clean = eligibilityMap(loadProfile(MODEL), loadDemotions(MODEL));
  assert.equal(Object.keys(clean).length, FUNCTIONS.length);

  recordDemotion(MODEL, 'read_file', 'observed failure');
  const after = eligibilityMap(loadProfile(MODEL), loadDemotions(MODEL));
  assert.equal(after.read_file.engine, 'frontier');
  assert.equal(clean.read_file.engine, 'local', 'precondition: read_file should be local for a perfect profile');
  clearDemotionsForModel(MODEL);
});

test('THE REAL PATH: consumeActivityEvent, not the direct API', () => {
  // The previous end-to-end verification called observeTroubleSignals directly and so
  // proved the half written by hand while skipping the half that runs. This exercises the
  // function the activity route actually calls.
  saveProfile(profileFor(MODEL));
  clearDemotionsForModel(MODEL);

  const payload = (functionId?: string) => JSON.stringify({
    model: MODEL, functionId, signals: { proseInsteadOfToolCall: true, success: false },
  });

  // No functionId => NO demotion. Demoting the wrong function is worse than none: it
  // removes work the model can do and leaves the real failure in place.
  for (let i = 0; i < DEMOTION_CONSECUTIVE_FAILURES + 2; i++) {
    consumeActivityEvent('trouble_signals', payload(undefined));
  }
  assert.deepEqual(loadDemotions(MODEL), [], 'demoted despite having no attribution');

  // With a functionId, the streak accrues against THAT function and nothing else.
  for (let i = 0; i < DEMOTION_CONSECUTIVE_FAILURES; i++) {
    consumeActivityEvent('trouble_signals', payload('search_code'));
  }
  const dem = loadDemotions(MODEL);
  assert.deepEqual(dem.map((d) => d.functionId), ['search_code'],
    `expected only search_code demoted, got ${JSON.stringify(dem)}`);
  clearDemotionsForModel(MODEL);
});

test('attribution is a lookup: stepId -> executor_type, and unresolvable events are dropped', () => {
  // Measured on the 9 real events in the production database: 7 carry a stepId, 6 carry a
  // model, 6 carry both. So the resolvable and unresolvable cases BOTH occur in practice
  // and both need defined behaviour.
  saveProfile(profileFor(MODEL));
  clearDemotionsForModel(MODEL);

  // workflow_steps.workflow_id is a foreign key — the parent must exist. `name` and
  // `created_at` are the only NOT NULL columns without defaults.
  db.prepare('INSERT OR IGNORE INTO workflows (id, name, created_at) VALUES (?, ?, ?)')
    .run('wf-1', 'test-wf', new Date().toISOString());

  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
    executor_type, executor_id, executor_config, auto_advance, status, result, error, depends_on, created_at)
    VALUES ('step-rg', 'wf-1', 'n', '', 0, 0, 'review-gate', '', '{}', 0, 'pending', '', '', '[]', ?)`)
    .run(new Date().toISOString());

  const ev = (stepId?: string) => JSON.stringify({
    model: MODEL, stepId, signals: { proseInsteadOfToolCall: true, success: false },
  });

  // Unresolvable stepId -> dropped, never guessed.
  for (let i = 0; i < DEMOTION_CONSECUTIVE_FAILURES + 2; i++) consumeActivityEvent('trouble_signals', ev('no-such-step'));
  for (let i = 0; i < DEMOTION_CONSECUTIVE_FAILURES + 2; i++) consumeActivityEvent('trouble_signals', ev(undefined));
  assert.deepEqual(loadDemotions(MODEL), [], 'an unattributable event produced a demotion');

  // Resolvable stepId -> demotes the function that step performs, and only that one.
  for (let i = 0; i < DEMOTION_CONSECUTIVE_FAILURES; i++) consumeActivityEvent('trouble_signals', ev('step-rg'));
  assert.deepEqual(loadDemotions(MODEL).map((d) => d.functionId), ['review-gate'],
    'stepId did not resolve to the step\'s executor_type');
  clearDemotionsForModel(MODEL);
});

test('the model is persisted from the signal payload — the relay never sends one', () => {
  // agents.model cannot come from registration: the relay body has no model field at all.
  // Every signal event carries the model the turn ran on, so that is the real data path.
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, branch, current_task,
    status, pending_question, trust_mode, agent_mode, last_seen, session_id, agent_type)
    VALUES ('agent-gl', 'gl', 'm', '/tmp/r', 'r', 'main', '', 'working', '', 0, 'trust', ?, 's', 'gridlight')`)
    .run(new Date().toISOString());

  consumeActivityEvent('trouble_signals', JSON.stringify({ model: MODEL, signals: { success: true } }), 'agent-gl');
  const row = db.prepare('SELECT model FROM agents WHERE id = ?').get('agent-gl') as { model: string };
  assert.equal(row.model, MODEL, 'model was not persisted from the signal payload');
});

test('the failure streak survives a restart — it lives in the table, not a Map', () => {
  saveProfile(profileFor(MODEL));
  clearDemotionsForModel(MODEL);
  const bad = { model: MODEL, signals: { proseInsteadOfToolCall: true, success: false } };

  // Two failures, then simulate a restart by re-reading state from the DB rather than
  // relying on any in-process counter.
  observeTroubleSignals('list_files', bad);
  observeTroubleSignals('list_files', bad);
  const streak = (db.prepare('SELECT failure_streak FROM engine_demotions WHERE model_id = ? AND function_id = ?')
    .get(MODEL, 'list_files') as { failure_streak: number } | undefined)?.failure_streak;
  assert.equal(streak, 2, 'streak was not persisted between turns');

  // The third failure, which after a restart would previously have counted as the first.
  observeTroubleSignals('list_files', bad);
  assert.ok(loadDemotions(MODEL).some((d) => d.functionId === 'list_files'),
    'third failure did not demote — the counter did not survive');
  clearDemotionsForModel(MODEL);
});
