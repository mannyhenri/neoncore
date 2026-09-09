/**
 * GAS-006 — every degenerate state the projection can be asked for has a DEFINED render.
 *
 * GAS-005's invariant sweep proved a 180-point grid never produces Infinity, NaN or a negative
 * day count. That is a floor, not a specification: "finite" is not the same as "what should
 * the badge actually say here". This names each state the epic calls out and pins the exact
 * output, so a future change that turns "no budget" into a plausible 0 — arithmetically
 * finite, and exactly the lie the epic exists to prevent — fails here rather than shipping.
 *
 * ── THE TWO SAMPLE-SHAPED STATES, AND AN HONEST LIMIT ─────────────────────────────────
 * "Window shorter than one sample" is observable: no elapsed time means nothing consumed yet,
 * so the render is a full tank. "Single-sample window" is NOT observable at this layer —
 * `project()` takes a rate, and a rate averaged from one turn is arithmetically identical to
 * one averaged from three thousand. computeBurnRate returns `samples`, but threading it here
 * to populate `confidence` would mean inventing a trust number, which GAS-005 deliberately
 * refused. So the render asserted is the true one — a normal projection — and the gap is
 * named rather than papered over: thin evidence is not currently distinguishable to a reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type Projection } from '../src/lib/projection.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

/** THE STATE REGISTRY. Each row is a state the epic names and the render it must produce. */
const STATES: {
  state: string;
  input: Parameters<typeof project>[0];
  expect: (p: Projection) => string | null;   // null = correct, else what is wrong
}[] = [
  {
    state: 'no budget set',
    input: { costPerDay: 100, budgetUsd: null, windowStart: NOW, now: NOW },
    expect: (p) => p.basis !== 'unknown' ? `basis ${p.basis}, want unknown`
      : p.daysRemaining !== null ? `daysRemaining ${p.daysRemaining}, want null — a day count with no ceiling is a lie`
      : p.pctConsumed !== null ? `pctConsumed ${p.pctConsumed}, want null` : null,
  },
  {
    state: 'zero burn',
    input: { costPerDay: 0, budgetUsd: 700, windowStart: NOW - DAY, now: NOW },
    expect: (p) => p.daysRemaining !== null ? `daysRemaining ${p.daysRemaining}, want null — nothing is being spent, so there is no exhaustion date`
      : p.pctConsumed !== 0 ? `pctConsumed ${p.pctConsumed}, want 0` : null,
  },
  {
    state: 'burn exceeding budget within the window',
    input: { costPerDay: 1000, budgetUsd: 700, windowStart: NOW - DAY, now: NOW },
    expect: (p) => p.daysRemaining !== 0 ? `daysRemaining ${p.daysRemaining}, want 0`
      : !(p.pctConsumed! > 1) ? `pctConsumed ${p.pctConsumed}, want >1 so the overrun is visible` : null,
  },
  {
    state: 'budget already exhausted exactly',
    input: { costPerDay: 100, budgetUsd: 700, windowStart: NOW - 7 * DAY, now: NOW },
    expect: (p) => p.daysRemaining !== 0 ? `daysRemaining ${p.daysRemaining}, want 0`
      : Math.abs(p.pctConsumed! - 1) > 1e-9 ? `pctConsumed ${p.pctConsumed}, want exactly 1` : null,
  },
  {
    state: 'window shorter than one sample (no elapsed time)',
    input: { costPerDay: 100, budgetUsd: 700, windowStart: NOW, now: NOW },
    expect: (p) => p.pctConsumed !== 0 ? `pctConsumed ${p.pctConsumed}, want 0 — nothing has elapsed`
      : p.daysRemaining !== 7 ? `daysRemaining ${p.daysRemaining}, want the full tank of 7` : null,
  },
  {
    state: 'single-sample window (rate from one turn)',
    input: { costPerDay: 42, budgetUsd: 420, windowStart: NOW, now: NOW },
    expect: (p) => p.daysRemaining !== 10 ? `daysRemaining ${p.daysRemaining}, want 10`
      : p.basis !== 'budget' ? `basis ${p.basis}, want budget` : null,
  },
  {
    state: 'clock behind the window start (skew)',
    input: { costPerDay: 100, budgetUsd: 700, windowStart: NOW + 5 * DAY, now: NOW },
    expect: (p) => p.pctConsumed !== 0 ? `pctConsumed ${p.pctConsumed}, want 0 — negative elapsed must not credit the budget`
      : p.daysRemaining !== 7 ? `daysRemaining ${p.daysRemaining}, want 7` : null,
  },
];

test('every named edge state has a defined render, not merely a finite one', () => {
  const wrong: string[] = [];
  for (const { state, input, expect } of STATES) {
    const problem = expect(project(input));
    if (problem) wrong.push(`${state}: ${problem}`);
  }
  assert.deepEqual(wrong, [],
    `these states do not render as specified:\n  ${wrong.join('\n  ')}`);
});

test('the state registry covers every case the epic names', () => {
  // Guards the guard: a state quietly dropped from the table above would make the test above
  // pass while covering less.
  const named = STATES.map((s) => s.state).join(' | ');
  for (const required of ['no budget', 'zero burn', 'exceeding budget', 'exhausted',
                          'shorter than one sample', 'single-sample']) {
    assert.ok(named.includes(required), `the epic names "${required}" but no row covers it`);
  }
  assert.equal(STATES.length, 7, 'a row was added or removed without updating this count');
});
