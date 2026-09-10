/**
 * GAS-011 — the budget block on the token report: where the week actually stands.
 *
 * The badge answers "how long left" in four characters. This is the page you open when that
 * number surprises you, so it shows the parts the pill cannot: what the ceiling is, how much
 * of it is gone, the DATE the week runs out, and whether the current rate is above or below
 * the pace the budget allows.
 *
 * ── PACE IS THE STAT THE PILL CANNOT GIVE YOU ─────────────────────────────────────────
 * "2.9d left" tells you where you are; it does not tell you whether that is normal. A weekly
 * budget allows budget/7 per day, so spending against that allowance is the honest measure of
 * whether this week is unusual — 100% is exactly on plan, 210% means the week ends on
 * Thursday. It is the number a person can act on.
 *
 * ── THE SAME SUPPRESSION RULE AS THE BADGE, DELIBERATELY ──────────────────────────────
 * A partial fleet undercounts the rate, so every figure derived from it overstates headroom.
 * GAS-010 suppressed the pill for that reason and this suppresses the block for the same one.
 * A stats table is MORE dangerous than a pill when it is wrong, not less: it looks like a
 * ledger, and a ledger reads as fact.
 */
import { describe, it, expect } from 'vitest';
import { budgetStats } from '../lib/burnRate';
import type { FleetBurnRate, ServerProjection } from '../lib/burnRate';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

const fleet = (o: Partial<FleetBurnRate> = {}): FleetBurnRate => ({
  tokensPerDay: 240, tokensPerHour: 10, costPerDay: 100, samples: 10,
  budget: { usd: 700, basis: 'budget' },
  projection: { daysRemaining: 4.2, pctConsumed: 0.4, basis: 'budget', confidence: null } as ServerProjection,
  problems: [], serversReporting: 2, serversAsked: 2,
  ...o,
} as unknown as FleetBurnRate);

describe('GAS-011 budget stats', () => {
  it('reports the ceiling, what is gone, and what is left', () => {
    const s = budgetStats(fleet(), NOW)!;
    expect(s.budgetUsd).toBe(700);
    expect(s.consumedUsd).toBeCloseTo(280, 6);      // 40% of 700
    expect(s.remainingUsd).toBeCloseTo(420, 6);
    expect(s.basis).toBe('budget');
  });

  it('pace compares the real rate against what the budget allows per day', () => {
    // $700/week allows $100/day. Spending exactly that is 100%.
    expect(budgetStats(fleet(), NOW)!.pacePct).toBeCloseTo(1, 6);
    // Double the rate is double the pace — the week ends in half the time.
    expect(budgetStats(fleet({ costPerDay: 200 }), NOW)!.pacePct).toBeCloseTo(2, 6);
    // Under budget reads below 100%, which is the reassuring case and must not round away.
    expect(budgetStats(fleet({ costPerDay: 25 }), NOW)!.pacePct).toBeCloseTo(0.25, 6);
  });

  it('gives the DATE the budget runs out, not just a duration', () => {
    const s = budgetStats(fleet(), NOW)!;
    expect(s.exhaustionAt).toBe(NOW + 4.2 * DAY);
  });

  it('a zero burn has no exhaustion date — nothing is being spent', () => {
    const s = budgetStats(fleet({
      costPerDay: 0,
      projection: { daysRemaining: null, pctConsumed: 0, basis: 'budget', confidence: null } as ServerProjection,
    }), NOW)!;
    expect(s.exhaustionAt).toBeNull();
    expect(s.pacePct).toBe(0);
  });

  it('an overspent week floors what is left at zero and still shows the overrun', () => {
    const s = budgetStats(fleet({
      projection: { daysRemaining: 0, pctConsumed: 1.3, basis: 'budget', confidence: null } as ServerProjection,
    }), NOW)!;
    expect(s.remainingUsd).toBe(0);
    expect(s.consumedUsd).toBeCloseTo(910, 6);      // 130% of 700 — the overrun stays visible
  });

  it('no budget means no block at all', () => {
    expect(budgetStats(fleet({
      budget: { usd: null, basis: 'budget' },
      projection: { daysRemaining: null, pctConsumed: null, basis: 'unknown', confidence: null } as ServerProjection,
    }), NOW)).toBeNull();
  });

  it('a partial fleet suppresses the block, exactly as it suppresses the pill', () => {
    expect(budgetStats(fleet({ problems: [{ label: 'studio', reason: 'unreachable' }] }), NOW)).toBeNull();
  });

  /** Everything here is rendered; none of it may be unrenderable. */
  it('no combination yields NaN, Infinity or a negative', () => {
    const bad: string[] = [];
    for (const costPerDay of [0, 0.01, 100, 1e9, -5]) {
      for (const pct of [0, 0.5, 1, 1.3, null]) {
        for (const usd of [1, 700, 1e9]) {
          const s = budgetStats(fleet({
            costPerDay, budget: { usd, basis: 'budget' },
            projection: { daysRemaining: 1, pctConsumed: pct, basis: 'budget', confidence: null } as ServerProjection,
          }), NOW);
          if (!s) continue;
          for (const [k, v] of Object.entries(s)) {
            if (typeof v !== 'number') continue;
            if (!Number.isFinite(v) || v < 0) bad.push(`${k}=${v} at rate=${costPerDay} pct=${pct} budget=${usd}`);
          }
        }
      }
    }
    expect(bad, `unrenderable stats:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});
