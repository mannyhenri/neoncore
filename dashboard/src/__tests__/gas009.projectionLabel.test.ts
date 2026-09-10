/**
 * GAS-009 — the projection pill: a time-to-empty beside the rate, never without its basis.
 *
 * ── WHY THIS IS A FUNCTION AND NOT JSX ────────────────────────────────────────────────
 * The epic's one non-negotiable is that the badge states what its number rests on: "2.9d left"
 * from a budget the user typed and "2.9d left" from a measured ceiling are different claims,
 * and an unlabelled figure is worse than no figure. A component that assembles a number and a
 * suffix from two pieces can always be edited into rendering just the number. So the label is
 * built here as ONE string with the basis already inside it, which makes the number
 * unrenderable on its own, and that property is asserted over a grid rather than at one point.
 *
 * The component keeps only markup, matching how lib/burn-rate.ts, lib/usage-series.ts and
 * lib/projection.ts already split arithmetic from presentation in this codebase.
 *
 * GAS-010 owns what the badge shows when there is NO projection — the "set a budget"
 * affordance and the degraded-server case. Here that returns null, and the badge simply keeps
 * showing the bare rate it shows today.
 */
import { describe, it, expect } from 'vitest';
import { projectionLabel } from '../lib/burnRate';
import type { FleetBurnRate } from '../lib/burnRate';

const fleet = (projection: Partial<FleetBurnRate['projection']> | undefined): FleetBurnRate =>
  ({ projection, budget: { usd: 700, basis: 'budget' } } as unknown as FleetBurnRate);

const P = (daysRemaining: number | null, basis = 'budget') =>
  fleet({ daysRemaining, pctConsumed: 0.2, basis, confidence: null } as FleetBurnRate['projection']);

describe('GAS-009 projection pill', () => {
  it('shows days to empty with its basis', () => {
    expect(projectionLabel(P(2.94))).toBe('2.9d left · budget');
  });

  it('drops to hours under a day, because "0.4d left" is not a unit anyone reads', () => {
    expect(projectionLabel(P(0.5))).toBe('12h left · budget');
    expect(projectionLabel(P(1 / 24))).toBe('1h left · budget');
  });

  it('an exhausted budget reads as none left, not as a negative or a blank', () => {
    expect(projectionLabel(P(0))).toBe('0h left · budget');
  });

  it('a measured ceiling says so — the whole point of the suffix', () => {
    expect(projectionLabel(P(3, 'measured'))).toBe('3.0d left · measured');
  });

  it('no projection yields nothing here; GAS-010 owns that affordance', () => {
    expect(projectionLabel(P(null))).toBeNull();
    expect(projectionLabel(fleet({ daysRemaining: null, pctConsumed: null, basis: 'unknown', confidence: null }))).toBeNull();
    expect(projectionLabel(fleet(undefined))).toBeNull();          // a server on an older build
  });

  it('large horizons stay readable rather than printing every digit', () => {
    expect(projectionLabel(P(365.7))).toBe('366d left · budget');
  });

  /** THE INVARIANT: a number can never reach the badge without the thing it rests on. */
  it('every renderable label carries its basis, and none is NaN or Infinity', () => {
    const bad: string[] = [];
    for (const days of [0, 0.001, 0.5, 1, 2.94, 30, 365.7, 1e6, NaN, Infinity, -3, null]) {
      for (const basis of ['budget', 'measured', 'unknown']) {
        const label = projectionLabel(P(days as number | null, basis));
        if (label === null) continue;
        if (!label.includes(basis)) bad.push(`"${label}" omits its basis (${basis})`);
        if (/NaN|Infinity|-\d/.test(label)) bad.push(`"${label}" is not renderable text`);
      }
    }
    expect(bad, `unlabelled or unrenderable projections reach the badge:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});
