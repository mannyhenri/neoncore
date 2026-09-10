/**
 * GAS-013 — learn the real ceiling from where the wall actually was.
 *
 * GAS-012 records a row each time a usage limit is hit, with the spend at that moment. This
 * turns those rows into a ceiling and marks it `measured`, so the badge can eventually stop
 * dividing a number the user guessed at.
 *
 * ── THERE ARE ZERO ROWS TODAY, AND THAT IS THE MOST IMPORTANT CASE ────────────────────
 * Capture started an hour ago; no limit has been hit since. Every other task in this epic has
 * followed one rule — never present a guess as a measurement — and this is where it is most
 * tempting to break it, because a ceiling learned from one observation looks like data. So:
 * below the observation threshold this returns null, the basis stays `budget`, and nothing
 * changes. A `measured` label has to be earned.
 *
 * ── NOT EVERY LIMIT SIGNAL IS A CEILING ───────────────────────────────────────────────
 * GAS-012's registry records five markers, and only some describe a PLAN ceiling. A 429 or a
 * transient rate-limit says the API pushed back right now — it says nothing about how much the
 * week allows, and averaging those in would drag the estimate toward whatever spend happened
 * to be on the clock during a burst. Only the plan-limit markers count, and the split is
 * asserted so a marker added later has to be classified deliberately.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  learnedCeiling, CEILING_MARKERS, MIN_OBSERVATIONS, CONFIDENCE_THRESHOLD,
} from '../src/lib/learned-ceiling.js';
import { LIMIT_PATTERNS } from '../src/lib/limit-events.js';

const ev = (marker: string, costUsd: number, daysAgo = 1) => ({
  id: `e${Math.random()}`, agent_id: 'a', marker,
  detected_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  tokens_at_event: 1_000_000, cost_usd_at_event: costUsd,
});

test('no observations means no ceiling — the state the fleet is actually in today', () => {
  assert.equal(learnedCeiling([]), null);
});

test('too few observations means no ceiling, however tightly they agree', () => {
  const tight = Array.from({ length: MIN_OBSERVATIONS - 1 }, () => ev('usage-limit-reached', 700));
  assert.equal(learnedCeiling(tight), null,
    'perfect agreement between two points is still two points');
});

test('enough tight observations yield a ceiling near them, marked measured', () => {
  const out = learnedCeiling([
    ev('usage-limit-reached', 690), ev('usage-limit-reached', 700), ev('usage-limit-reached', 710),
  ])!;
  assert.ok(out, 'three consistent walls are evidence');
  assert.ok(Math.abs(out.usdWeekly - 700) < 15, `ceiling ${out.usdWeekly} should sit near the observations`);
  assert.ok(out.confidence >= CONFIDENCE_THRESHOLD);
  assert.equal(out.samples, 3);
});

test('scattered observations are not a ceiling — low confidence yields null', () => {
  const scattered = [
    ev('usage-limit-reached', 100), ev('usage-limit-reached', 700), ev('usage-limit-reached', 4000),
  ];
  assert.equal(learnedCeiling(scattered), null,
    'walls that disagree by 40x describe no single ceiling');
});

test('transient throttles are not ceiling evidence', () => {
  const throttles = [ev('rate-limited', 12), ev('http-429', 15), ev('rate-limited', 9), ev('http-429', 11)];
  assert.equal(learnedCeiling(throttles), null,
    'a 429 says the API pushed back now, not how much the week allows');
});

test('a mixed history counts only the plan-limit observations', () => {
  const mixed = [
    ev('usage-limit-reached', 700), ev('rate-limited', 8), ev('reached-your-limit', 705),
    ev('http-429', 12), ev('usage-limit-reached', 695),
  ];
  const out = learnedCeiling(mixed)!;
  assert.equal(out.samples, 3, 'the two throttles must not count as observations');
  assert.ok(Math.abs(out.usdWeekly - 700) < 15);
});

test('EVERY marker in the limit registry is classified deliberately', () => {
  // The guard against a forgotten marker: one added to GAS-012 and never classified here
  // would silently be treated as a throttle and never contribute to a ceiling.
  const known = new Set<string>([...CEILING_MARKERS, 'rate-limited', 'http-429']);
  const unclassified = LIMIT_PATTERNS.map((p) => p.marker).filter((m) => !known.has(m));
  assert.deepEqual(unclassified, [],
    `these limit markers are neither ceiling nor throttle: ${unclassified.join(', ')}`);
});

test('nothing it returns is NaN, Infinity or negative', () => {
  const bad: string[] = [];
  for (const costs of [[0, 0, 0], [1e9, 1e9, 1e9], [0.01, 0.01, 0.01], [700, 700, 700, 700, 700]]) {
    const out = learnedCeiling(costs.map((c) => ev('usage-limit-reached', c)));
    if (!out) continue;
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'number') continue;
      if (!Number.isFinite(v) || v < 0) bad.push(`${k}=${v} for ${JSON.stringify(costs)}`);
    }
  }
  assert.deepEqual(bad, [], `unusable ceiling values:\n  ${bad.join('\n  ')}`);
});

/**
 * The override. A learned ceiling is only worth anything if it reaches the gauge, and the
 * basis must change with it — otherwise the badge says "budget" over a number the user never
 * typed, which is the same lie as an unlabelled figure.
 */
import { budgetProjection } from '../src/lib/projection.js';

test('a learned ceiling replaces the declared budget AND relabels the basis', () => {
  const settings = { usage_budget_usd_weekly: '700' };
  const declared = budgetProjection({ costPerDay: 100, settings });
  assert.equal(declared.budget.usd, 700);
  assert.equal(declared.budget.basis, 'budget');

  const measured = budgetProjection({
    costPerDay: 100, settings,
    learned: { usdWeekly: 1200, confidence: 0.8, samples: 4 },
  });
  assert.equal(measured.budget.usd, 1200, 'the measured ceiling wins over the guess');
  assert.equal(measured.budget.basis, 'measured');
  assert.equal(measured.projection.basis, 'measured', 'the badge must say which it is');
});

test('a learned ceiling is used even when NO budget was ever declared', () => {
  const out = budgetProjection({
    costPerDay: 100, settings: {},
    learned: { usdWeekly: 900, confidence: 0.9, samples: 5 },
  });
  assert.equal(out.budget.usd, 900);
  assert.equal(out.projection.basis, 'measured');
  assert.ok(out.projection.daysRemaining! > 0, 'and it projects, rather than reporting unknown');
});

test('no learned ceiling leaves the declared budget exactly as it was', () => {
  const settings = { usage_budget_usd_weekly: '700' };
  for (const learned of [undefined, null]) {
    const out = budgetProjection({ costPerDay: 100, settings, learned: learned as never });
    assert.equal(out.budget.usd, 700);
    assert.equal(out.budget.basis, 'budget');
  }
});
