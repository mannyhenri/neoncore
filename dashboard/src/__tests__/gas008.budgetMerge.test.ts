/**
 * GAS-008 — one account-wide budget applied to the merged fleet, never summed.
 *
 * burnRate.ts already classifies keys: SUMMED_KEYS are extensive and add, WINDOW_KEYS describe
 * the question and carry through, and its header says "a new field that is neither is a bug".
 * The budget is a THIRD class and the bug the file predicted: it is a property of the Anthropic
 * ACCOUNT, not of a machine. Summing three servers' budgets yields a fleet ceiling three times
 * the real one, and the projection then reports MORE headroom than exists — the failure
 * direction that actually hurts, because the gauge says four days and the work stops in one.
 *
 * ── WHY pctConsumed MAY BE SUMMED WHILE daysRemaining MAY NOT ─────────────────────────
 * Every server prices the same account against the same Monday-UTC window, so each one's
 * pctConsumed is (its rate × the same elapsed) / the same budget. The parts therefore add to
 * the whole exactly. daysRemaining does not: it is budget × (1 − pct) / rate, and rates that
 * add do not make quotients that add. It is recomputed from the merged rate.
 *
 * ── DRIFT GUARD ───────────────────────────────────────────────────────────────────────
 * That recomputation is a second implementation of arithmetic the server already owns
 * (lib/projection.ts). The identity test below is what stops the two drifting: merging a
 * SINGLE server must reproduce that server's own projection exactly. If either side changes
 * its formula, that test fails rather than the badge quietly disagreeing with the API.
 */
import { describe, it, expect } from 'vitest';
import { mergeBurnRates, type ServerBurnRate } from '../lib/burnRate';
import type { ServerAnswer } from '../lib/serverAnswer';

const WINDOW_START = Date.UTC(2026, 8, 7);          // a Monday
/** The fixtures below encode a shared elapsed of 1.4 days (100/day spends 20% of $700 in 1.4d). */
const ELAPSED_DAYS = 1.4;
const NOW = WINDOW_START + ELAPSED_DAYS * 86_400_000;

/**
 * pct is DERIVED, never passed: every server prices the same account over the same window, so
 * (rate x elapsed) / budget is the only self-consistent value. An earlier version of this file
 * let each fixture state its own pct and one of them silently contradicted its own rate.
 */
function server(costPerDay: number, budgetUsd: number | null): ServerBurnRate {
  const pct = budgetUsd ? (costPerDay * ELAPSED_DAYS) / budgetUsd : null;
  return {
    windowHours: 168, days: 7, tokens: 1000, tokensPerHour: 10, tokensPerDay: 240,
    costUsd: costPerDay * 7, costPerDay, samples: 5, activeCartridges: 1,
    budget: { usd: budgetUsd, basis: 'budget' },
    projection: {
      daysRemaining: budgetUsd && costPerDay ? Math.max(0, (budgetUsd * (1 - (pct ?? 0))) / costPerDay) : null,
      pctConsumed: pct, basis: budgetUsd == null ? 'unknown' : 'budget', confidence: null,
    },
    windowStart: WINDOW_START,
  } as ServerBurnRate;
}
const ans = (rs: ServerBurnRate[]): ServerAnswer<ServerBurnRate>[] =>
  rs.map((r, i) => ({ label: `s${i}`, result: r }));

describe('GAS-008 fleet-safe budget merge', () => {
  it('does NOT sum the budget across servers', () => {
    const m = mergeBurnRates(ans([server(100, 700), server(50, 700), server(25, 700)]), 7, NOW);
    expect(m.budget.usd).toBe(700);          // not 2100
    expect(m.costPerDay).toBe(175);          // the RATE still sums
  });

  it('projects the merged rate against the single budget', () => {
    // 0.2 + 0.1 = 0.3 of $700 spent → $490 left at a merged $150/day.
    const m = mergeBurnRates(ans([server(100, 700), server(50, 700)]), 7, NOW);
    expect(m.projection.pctConsumed).toBeCloseTo(0.3, 10);
    expect(m.projection.daysRemaining).toBeCloseTo((700 * 0.7) / 150, 10);
    expect(m.projection.basis).toBe('budget');
  });

  it('IDENTITY: merging one server reproduces that server’s own projection', () => {
    const one = server(120, 700);
    const m = mergeBurnRates(ans([one]), 7, NOW);
    expect(m.projection.pctConsumed).toBeCloseTo(one.projection!.pctConsumed!, 10);
    expect(m.projection.daysRemaining).toBeCloseTo(one.projection!.daysRemaining!, 10);
  });

  it('servers that DISAGREE on the budget yield no projection, and say why', () => {
    const m = mergeBurnRates(ans([server(100, 700), server(50, 400)]), 7, NOW);
    expect(m.budget.usd).toBeNull();
    expect(m.projection.basis).toBe('unknown');
    expect(m.projection.daysRemaining).toBeNull();
    expect(m.problems.some((p) => p.reason === 'budget-conflict')).toBe(true);
  });

  it('a server on an OLD build carries no budget — absence is not disagreement', () => {
    const old = server(50, null);
    delete (old as Partial<ServerBurnRate>).budget;
    delete (old as Partial<ServerBurnRate>).projection;
    const m = mergeBurnRates(ans([server(100, 700), old]), 7, NOW);
    expect(m.budget.usd).toBe(700);
    expect(m.projection.basis).toBe('budget');
    expect(m.problems.some((p) => p.reason === 'budget-conflict')).toBe(false);
    expect(m.costPerDay).toBe(150);          // its rate still counts
  });

  it('no server has a budget → no projection, and no conflict either', () => {
    const m = mergeBurnRates(ans([server(100, null), server(50, null)]), 7, NOW);
    expect(m.budget.usd).toBeNull();
    expect(m.projection.basis).toBe('unknown');
    expect(m.projection.daysRemaining).toBeNull();
    expect(m.problems.some((p) => p.reason === 'budget-conflict')).toBe(false);
  });

  it('a zero merged rate yields null days, never Infinity', () => {
    const m = mergeBurnRates(ans([server(0, 700)]), 7, NOW);
    expect(m.projection.daysRemaining).toBeNull();
  });
});
