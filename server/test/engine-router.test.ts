import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FUNCTIONS, TIER_BARS, DIMENSIONS, SCENARIOS, MIN_TRIALS, getFunction,
  type CapabilityProfile,
} from '../src/lib/engine-capability.js';
import { routeFunction, eligibilityMap } from '../src/lib/engine-router.js';

/**
 * Set-based over the whole registry.
 *
 * An example-based test ("read_file routes local for a good model") passes on a router
 * that handles one tier and throws on the rest — which is the exact half-done fix this
 * project's standard exists to prevent. Every assertion below iterates FUNCTIONS.
 */

const perfect: CapabilityProfile = {
  modelId: 'test-perfect',
  measuredAt: '2026-07-31T00:00:00Z',
  vector: { toolCall: 1, safeEdit: 1, comprehension: 1, synthesis: 1, planning: 1, judgement: 1, instructionAdherence: 1 },
  interactiveTurnSeconds: 2,
  trials: { toolCall: 30, safeEdit: 30, comprehension: 30, synthesis: 30, planning: 30, judgement: 30, instructionAdherence: 30 },
};
const useless: CapabilityProfile = {
  modelId: 'test-useless',
  measuredAt: '2026-07-31T00:00:00Z',
  vector: { toolCall: 0, safeEdit: 0, comprehension: 0, synthesis: 0, planning: 0, judgement: 0, instructionAdherence: 0 },
  interactiveTurnSeconds: 300,
  trials: { toolCall: 30, safeEdit: 30, comprehension: 30, synthesis: 30, planning: 30, judgement: 30, instructionAdherence: 30 },
};

test('the registry is the 44 functions the design enumerates', () => {
  assert.equal(FUNCTIONS.length, 44, `expected 44 functions, got ${FUNCTIONS.length}`);
  const ids = FUNCTIONS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate function ids in the registry');
});

test('every function is decidable — no function may fall through the router', () => {
  const undecided: string[] = [];
  for (const fn of FUNCTIONS) {
    for (const profile of [perfect, useless, null]) {
      const d = routeFunction(fn.id, profile);
      if (!d || (d.engine !== 'local' && d.engine !== 'frontier')) undecided.push(`${fn.id} (${profile?.modelId ?? 'no-profile'})`);
      if (!d?.reason) undecided.push(`${fn.id}: decision carries no reason`);
    }
  }
  assert.deepEqual(undecided, [], `${undecided.length} undecidable: ${undecided.join(', ')}`);
});

test('an unknown function id is rejected rather than silently routed', () => {
  // The failure mode this guards: a typo'd id quietly routing local because a lookup
  // returned undefined and the code treated it as "no bar to clear".
  assert.throws(() => routeFunction('not_a_real_function', perfect), /unknown function/i);
});

test('no profile means UNMEASURED means frontier — for every function that uses a model', () => {
  // T0 is excluded deliberately: it makes no model call, so there is nothing to measure
  // and nothing to escalate. Its always-local behaviour is pinned by its own test below.
  const wrong = FUNCTIONS.filter((fn) => fn.tier !== 'T0').filter((fn) => {
    const d = routeFunction(fn.id, null);
    return d.state !== 'UNMEASURED' || d.engine !== 'frontier';
  }).map((f) => f.id);
  assert.deepEqual(wrong, [], `unmeasured functions that did not escalate: ${wrong.join(', ')}`);
});

test('a model that fails the gate routes NOTHING local, whatever else it scores', () => {
  // The gate is not the bottom of an ordinal scale — it is checked independently.
  const goodAtEverythingButTools: CapabilityProfile = {
    ...perfect, modelId: 'test-no-tools',
    vector: { ...perfect.vector, toolCall: 0.1 },
  };
  const leaked = FUNCTIONS.filter((fn) => {
    const d = routeFunction(fn.id, goodAtEverythingButTools);
    return d.engine === 'local' && fn.tier !== 'T0';
  }).map((f) => f.id);
  assert.deepEqual(leaked, [], `gate failed but these still routed local: ${leaked.join(', ')}`);
});

test('T0 always routes local — it makes no model call at all', () => {
  const t0 = FUNCTIONS.filter((f) => f.tier === 'T0');
  assert.ok(t0.length > 0, 'expected at least one T0 function');
  for (const fn of t0) {
    for (const profile of [perfect, useless, null]) {
      assert.equal(routeFunction(fn.id, profile).engine, 'local', `${fn.id} must always be local`);
    }
  }
});

test('a perfect model still escalates nothing it should, and a useless model escalates all but T0', () => {
  const perfectFrontier = FUNCTIONS.filter((f) => routeFunction(f.id, perfect).engine === 'frontier');
  assert.deepEqual(perfectFrontier.map((f) => f.id), [], 'a perfect profile should clear every bar');

  const uselessLocal = FUNCTIONS.filter((f) => routeFunction(f.id, useless).engine === 'local' && f.tier !== 'T0');
  assert.deepEqual(uselessLocal.map((f) => f.id), [], 'a useless profile should clear nothing but T0');
});

test('every tier referenced by a function has a bar, and every bar names known dimensions', () => {
  const tiersUsed = [...new Set(FUNCTIONS.map((f) => f.tier))];
  const missing = tiersUsed.filter((t) => !(t in TIER_BARS));
  assert.deepEqual(missing, [], `tiers used with no bar defined: ${missing.join(', ')}`);

  const unknownDims: string[] = [];
  for (const [tier, bar] of Object.entries(TIER_BARS)) {
    for (const dim of Object.keys(bar)) {
      if (!DIMENSIONS.includes(dim as never)) unknownDims.push(`${tier}.${dim}`);
    }
  }
  assert.deepEqual(unknownDims, [], `bars reference dimensions the probe cannot measure: ${unknownDims.join(', ')}`);
});

test('latency gates interactive functions independently of capability', () => {
  // A capable but slow model: must keep batch work, lose interactive work.
  const slow: CapabilityProfile = { ...perfect, modelId: 'test-slow', interactiveTurnSeconds: 300 };
  const interactive = FUNCTIONS.filter((f) => f.latency === 'interactive' && f.tier !== 'T0');
  const batch = FUNCTIONS.filter((f) => f.latency === 'batch' && f.tier !== 'T0');
  assert.ok(interactive.length > 0 && batch.length > 0, 'registry must contain both latency classes');

  const stillInteractive = interactive.filter((f) => routeFunction(f.id, slow).engine === 'local').map((f) => f.id);
  assert.deepEqual(stillInteractive, [], `slow model kept interactive work: ${stillInteractive.join(', ')}`);

  const lostBatch = batch.filter((f) => routeFunction(f.id, slow).engine !== 'local').map((f) => f.id);
  assert.deepEqual(lostBatch, [], `slow model wrongly lost batch work it is capable of: ${lostBatch.join(', ')}`);
});

test('eligibilityMap covers the whole registry exactly once', () => {
  const map = eligibilityMap(perfect);
  assert.equal(Object.keys(map).length, FUNCTIONS.length);
  const uncovered = FUNCTIONS.filter((f) => !map[f.id]).map((f) => f.id);
  assert.deepEqual(uncovered, [], `functions missing from the map: ${uncovered.join(', ')}`);
});

test('SCENARIOS ids all resolve in the registry — the check that was missing', () => {
  // This is the test whose absence let a hand-maintained id map into the reporting script
  // one milestone after documenting that exact pattern. A typo previously threw at report
  // time; now it fails here, loudly, before anyone runs a report.
  const bad: string[] = [];
  for (const [scenario, ids] of Object.entries(SCENARIOS)) {
    for (const id of ids) {
      try { getFunction(id); } catch { bad.push(`${scenario} -> ${id}`); }
    }
  }
  assert.deepEqual(bad, [], `SCENARIOS reference unknown functions: ${bad.join(', ')}`);
});

test('a knife-edge rate at small N is INCONCLUSIVE, not a pass', () => {
  // 3/5 = 0.60 against a 0.60 bar passed on the point estimate under the old router.
  // Its 95% interval spans roughly 15-95%, which is not evidence of anything.
  const knifeEdge: CapabilityProfile = {
    modelId: 'test-knife', measuredAt: 'x',
    vector: { ...perfect.vector, synthesis: 0.6 },
    trials: { ...perfect.trials, synthesis: 5 },
    interactiveTurnSeconds: 2,
  };
  const t3 = FUNCTIONS.filter((f) => f.tier === 'T3');
  assert.ok(t3.length > 0);
  for (const fn of t3) {
    const d = routeFunction(fn.id, knifeEdge);
    assert.equal(d.state, 'INCONCLUSIVE', `${fn.id}: expected INCONCLUSIVE, got ${d.state} (${d.reason})`);
    assert.equal(d.engine, 'frontier', `${fn.id} must escalate while undecided`);
  }
});

test('too few trials cannot clear a bar, for any function', () => {
  const thin: CapabilityProfile = {
    ...perfect, modelId: 'test-thin',
    trials: Object.fromEntries(DIMENSIONS.map((d) => [d, MIN_TRIALS - 1])) as never,
  };
  const passed = FUNCTIONS.filter((f) => f.tier !== 'T0' && routeFunction(f.id, thin).engine === 'local').map((f) => f.id);
  assert.deepEqual(passed, [], `cleared a bar on N<${MIN_TRIALS}: ${passed.join(', ')}`);
});

test('latency uses the tier-relevant dimension, not the cheapest turn', () => {
  // A model fast on the gate probe but slow on planning must NOT keep interactive T4 work.
  const fastGateSlowPlanning: CapabilityProfile = {
    ...perfect, modelId: 'test-mixed',
    interactiveTurnSeconds: 2,
    perDimensionSeconds: { toolCall: 2, planning: 120 },
  };
  const t4Interactive = FUNCTIONS.filter((f) => f.tier === 'T4' && f.latency === 'interactive');
  assert.ok(t4Interactive.length > 0, 'expected interactive T4 functions');
  for (const fn of t4Interactive) {
    assert.equal(routeFunction(fn.id, fastGateSlowPlanning).engine, 'frontier',
      `${fn.id} cleared on the gate probe latency instead of planning latency`);
  }
});

test('sufficiency is asymmetric: a definitive fail needs less evidence than a pass', () => {
  // 0/5 has an upper bound of ~0.434, entirely below the 0.60 bar — conclusive at N=5.
  // 5/5 has a lower bound of ~0.566 — NOT conclusive at the same N.
  // Applying one floor to both directions would relabel proven incapability as "undecided".
  const zeroAtFive: CapabilityProfile = {
    ...perfect, modelId: 'test-zero',
    vector: { ...perfect.vector, comprehension: 0 },
    trials: { ...perfect.trials, comprehension: 5 },
  };
  const t2 = FUNCTIONS.filter((f) => f.tier === 'T2');
  assert.ok(t2.length > 0);
  for (const fn of t2) {
    const d = routeFunction(fn.id, zeroAtFive);
    assert.equal(d.state, 'INELIGIBLE', `${fn.id}: a 0/5 must be a definitive fail, got ${d.state} (${d.reason})`);
  }

  const perfectAtFive: CapabilityProfile = {
    ...perfect, modelId: 'test-perfect-thin',
    trials: Object.fromEntries(DIMENSIONS.map((d) => [d, 5])) as never,
  };
  const certified = FUNCTIONS.filter((f) => f.tier !== 'T0' && routeFunction(f.id, perfectAtFive).engine === 'local');
  assert.deepEqual(certified.map((f) => f.id), [], 'a flawless N=5 run must not certify anything');
});
