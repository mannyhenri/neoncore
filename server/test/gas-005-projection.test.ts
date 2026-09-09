/**
 * GAS-005 — turn a burn rate and a declared ceiling into "how long until 100%".
 *
 * Pure, like lib/usage-series.ts and lib/burn-rate.ts: the arithmetic has invariants that a
 * route handler cannot be tested for in isolation, and the whole value of this number is that
 * it is trustworthy. `costPerDay` comes from computeBurnRate, `budgetUsd` from budgetFrom.
 *
 * ── THE CONTRACT THAT MATTERS MOST: NO BUDGET MEANS NO NUMBER ─────────────────────────
 * GAS-004 made "unset" null rather than 0 precisely so this function can tell "I have no idea
 * how long you have" from "you are already out". A projection with no ceiling must return
 * `basis: 'unknown'` and null figures — never a plausible-looking day count. The badge renders
 * that as "set a budget", and an unlabelled number the user cannot trace is the one outcome
 * the epic treats as worse than showing nothing.
 *
 * ── AND NOTHING MAY EVER BE Infinity, NaN OR NEGATIVE ─────────────────────────────────
 * Every one of those reaches the badge as text. "Infinity days left" is absurd, "NaN days" is
 * broken, and "-3 days left" is a countdown running backwards. Division by a zero burn rate
 * produces the first, an unset budget the second, and an overspent budget the third, so the
 * invariant is swept over a grid rather than asserted at the three points I happened to think
 * of. GAS-006 then names each edge state individually.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/projection.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

test('a full tank projects budget divided by burn', () => {
  const p = project({ costPerDay: 100, budgetUsd: 700, windowStart: NOW, now: NOW });
  assert.equal(p.daysRemaining, 7);
  assert.equal(p.pctConsumed, 0);
  assert.equal(p.basis, 'budget');
});

test('mid-window, spend so far is charged against the budget', () => {
  const p = project({ costPerDay: 100, budgetUsd: 700, windowStart: NOW - 2 * DAY, now: NOW });
  assert.equal(p.daysRemaining, 5);                       // $200 spent, $500 left, $100/day
  assert.ok(Math.abs(p.pctConsumed! - 2 / 7) < 1e-9);
});

test('no budget yields no number at all, not a zero', () => {
  const p = project({ costPerDay: 100, budgetUsd: null, windowStart: NOW, now: NOW });
  assert.equal(p.basis, 'unknown');
  assert.equal(p.daysRemaining, null, 'a projection without a ceiling must not produce a day count');
  assert.equal(p.pctConsumed, null);
});

test('a zero burn rate yields null, never Infinity', () => {
  const p = project({ costPerDay: 0, budgetUsd: 700, windowStart: NOW, now: NOW });
  assert.equal(p.daysRemaining, null, 'nothing is being spent, so there is no exhaustion date');
  assert.notEqual(p.daysRemaining, Infinity);
});

test('an overspent budget floors at zero and reports the overrun honestly', () => {
  const p = project({ costPerDay: 100, budgetUsd: 700, windowStart: NOW - 10 * DAY, now: NOW });
  assert.equal(p.daysRemaining, 0, 'a countdown must not run backwards');
  assert.ok(p.pctConsumed! > 1, 'consumption past the ceiling should read above 100%, not clamp');
});

test('a measured basis passes through untouched', () => {
  const p = project({ costPerDay: 100, budgetUsd: 700, windowStart: NOW, now: NOW, basis: 'measured' });
  assert.equal(p.basis, 'measured');
});

/** THE INVARIANT SWEEP — the grid, not the three points I thought of. */
test('no input grid produces Infinity, NaN or a negative day count', () => {
  const bad: string[] = [];
  const rates = [0, 0.0001, 1, 100, 1e6, -5];
  const budgets = [null, 0.01, 1, 700, 1e9];
  const elapsed = [0, 0.5, 1, 7, 1000, -1];
  for (const costPerDay of rates) {
    for (const budgetUsd of budgets) {
      for (const e of elapsed) {
        const p = project({ costPerDay, budgetUsd, windowStart: NOW - e * DAY, now: NOW });
        for (const [field, v] of [['daysRemaining', p.daysRemaining], ['pctConsumed', p.pctConsumed]] as const) {
          if (v === null) continue;
          const why = !Number.isFinite(v) ? 'not finite' : v < 0 ? 'negative' : null;
          if (why) bad.push(`${field}=${v} (${why}) at costPerDay=${costPerDay} budget=${budgetUsd} elapsed=${e}d`);
        }
        if (budgetUsd === null && p.basis !== 'unknown') {
          bad.push(`basis=${p.basis} with no budget at costPerDay=${costPerDay} elapsed=${e}d`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `these reach the badge as unrenderable text:\n  ${bad.join('\n  ')}`);
});
