/**
 * GAS-007 — serve the budget and the projection from /api/activity/burn-rate.
 *
 * The endpoint already returns the rate. This composes the two halves that exist but have
 * never met in a response: `budgetFrom()` (lib/budget.ts — the declared ceiling, null when
 * unset) and `project()` (lib/projection.ts — the arithmetic). Kept pure, with settings
 * passed in, so the composition is testable without an HTTP harness and the route stays a
 * thin shell.
 *
 * ── ADDITIVE, BECAUSE THE BADGE FANS OUT ACROSS SERVERS ───────────────────────────────
 * BurnRate.tsx queries every server in `activeServers` and merges the answers. Those servers
 * can be on different builds, so one that has never heard of `budget` must not break the
 * badge. The contract is therefore: every existing field keeps its name and meaning, and the
 * new data arrives under two new keys that an old client simply ignores.
 *
 * ── THE WINDOW ANCHOR, WHICH THE EPIC LEFT OPEN ───────────────────────────────────────
 * project() needs a windowStart and Open Question 1 — whether the badge leads with the 5-hour
 * meter or the weekly one — is unresolved. The budget setting is `usage_budget_usd_weekly`, so
 * this assumes the WEEKLY meter, and anchors on the convention already in the codebase:
 * `bucketStart(now, 'week')` from usage-series.ts, which floors to Monday UTC. Reusing it
 * rather than inventing an anchor means the badge and the tokens chart agree on what "this
 * week" means — two views of the same spend that disagreed on the window would be worse than
 * either alone. Asserted below against bucketStart directly, so the two cannot drift apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetProjection } from '../src/lib/projection.js';
import { bucketStart } from '../src/lib/usage-series.js';

const NOW = Date.UTC(2026, 8, 10, 9, 30, 0);            // a Thursday
const DAY = 86_400_000;

test('with no budget set, the response says so instead of guessing', () => {
  const out = budgetProjection({ costPerDay: 120, settings: {}, now: NOW });
  assert.equal(out.budget.usd, null, 'unset must stay null, never 0');
  assert.equal(out.projection.basis, 'unknown');
  assert.equal(out.projection.daysRemaining, null,
    'a day count with no ceiling behind it is the one thing this feature must not render');
  assert.equal(out.projection.pctConsumed, null);
});

test('with a budget set, the projection is computed against it', () => {
  const settings = { usage_budget_usd_weekly: '700' };
  const out = budgetProjection({ costPerDay: 100, settings, now: NOW });
  assert.equal(out.budget.usd, 700);
  assert.equal(out.projection.basis, 'budget');
  // Thursday 09:30 UTC is 3 days 9.5h past Monday 00:00 → ~$337.50 spent of $700.
  const elapsedDays = (NOW - bucketStart(NOW, 'week')) / DAY;
  assert.ok(Math.abs(out.projection.pctConsumed! - (100 * elapsedDays) / 700) < 1e-9);
  assert.ok(out.projection.daysRemaining! > 0 && out.projection.daysRemaining! < 7);
});

test('the budget window is the SAME week the tokens chart buckets by', () => {
  const out = budgetProjection({ costPerDay: 100, settings: { usage_budget_usd_weekly: '700' }, now: NOW });
  assert.equal(out.windowStart, bucketStart(NOW, 'week'),
    'a badge and a chart that disagree on "this week" are worse than either alone');
  // Monday UTC, midnight.
  const d = new Date(out.windowStart);
  assert.equal(d.getUTCDay(), 1, 'weeks floor to Monday');
  assert.equal(d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds(), 0);
});

test('the basis stored in settings reaches the response', () => {
  const out = budgetProjection({
    costPerDay: 100,
    settings: { usage_budget_usd_weekly: '700', usage_budget_basis: 'measured' },
    now: NOW,
  });
  assert.equal(out.projection.basis, 'measured');
});

test('the addition is ADDITIVE — exactly two new keys, no existing field touched', () => {
  const out = budgetProjection({ costPerDay: 100, settings: {}, now: NOW });
  assert.deepEqual(Object.keys(out).sort(), ['budget', 'projection', 'windowStart'],
    'the route spreads these onto the existing payload; anything else would rename or shadow a field a shipped client reads');
  assert.deepEqual(Object.keys(out.budget).sort(), ['basis', 'usd']);
});

/** Degenerate rates must not produce unrenderable text — the guarantee GAS-005/006 established. */
test('no rate or settings combination yields Infinity, NaN or a negative', () => {
  const bad: string[] = [];
  for (const costPerDay of [0, 0.001, 100, 1e9, -5, NaN]) {
    for (const raw of [undefined, '', '0', '-10', '700', 'banana']) {
      const out = budgetProjection({ costPerDay, settings: { usage_budget_usd_weekly: raw }, now: NOW });
      for (const [k, v] of [['daysRemaining', out.projection.daysRemaining],
                            ['pctConsumed', out.projection.pctConsumed]] as const) {
        if (v === null) continue;
        if (!Number.isFinite(v) || v < 0) bad.push(`${k}=${v} at costPerDay=${costPerDay} budget=${JSON.stringify(raw)}`);
      }
    }
  }
  assert.deepEqual(bad, [], `unrenderable values reach the badge:\n  ${bad.join('\n  ')}`);
});
