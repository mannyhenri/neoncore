/**
 * "How long until 100%" — the burn rate divided into the declared ceiling.
 *
 * lib/burn-rate.ts answers how FAST spend is happening; lib/budget.ts holds how much there is
 * to spend. This is the only place the two meet, and it is pure for the same reason
 * usage-series.ts is: the arithmetic has invariants worth testing directly, and the whole
 * value of the number is that a person can trust it.
 *
 * ── NO CEILING MEANS NO NUMBER ────────────────────────────────────────────────────────
 * `budgetUsd` is null when the user has not set one (never 0 — see lib/budget.ts). That case
 * returns `basis: 'unknown'` with null figures rather than a day count, and the badge renders
 * "set a budget". An unlabelled projection the reader cannot trace back to an assumption is
 * the outcome this epic treats as worse than showing nothing at all: a confidently wrong ETA
 * destroys trust in the readout permanently, while an honest blank costs nothing.
 *
 * ── NOTHING MAY LEAVE HERE AS Infinity, NaN OR NEGATIVE ───────────────────────────────
 * Every field is rendered as text. A zero burn rate divides to Infinity ("Infinity days
 * left"), an absent budget to NaN ("NaN days"), and an overspent one to a negative ("-3 days
 * left" — a countdown running backwards). Each is handled at its source rather than formatted
 * away in the component, because a second consumer would have to rediscover the same guards.
 */
import type { BudgetBasis } from './budget.js';

const DAY_MS = 86_400_000;

/** `unknown` is this module's addition: there is a rate but no ceiling to divide it into. */
export type ProjectionBasis = BudgetBasis | 'unknown';

export interface Projection {
  /** Days until the budget is exhausted at the current rate. Null when unprojectable. */
  daysRemaining: number | null;
  /** Fraction of the budget spent this window. May exceed 1 — an overrun is not clamped away. */
  pctConsumed: number | null;
  basis: ProjectionBasis;
  /**
   * How far the estimate can be trusted, 0..1 — null until something MEASURES it.
   *
   * Deliberately not invented. Local cost is priced from a rate table (lib/pricing.ts), and
   * nothing yet compares that against billed reality; GAS-015 reconciles against the Admin
   * API's cost report and fills this with the observed delta. A fabricated 0.8 here would be
   * exactly the unlabelled confidence this epic exists to avoid.
   */
  confidence: number | null;
}

export interface ProjectionInput {
  /** USD per day, from computeBurnRate. */
  costPerDay: number;
  /** The weekly ceiling, or null when unset. */
  budgetUsd: number | null;
  /** Epoch ms at which the current budget window began. */
  windowStart: number;
  now?: number;
  basis?: BudgetBasis;
}

const UNPROJECTABLE: Projection = {
  daysRemaining: null, pctConsumed: null, basis: 'unknown', confidence: null,
};

export function project(input: ProjectionInput): Projection {
  const { costPerDay, budgetUsd, windowStart, now = Date.now(), basis = 'budget' } = input;

  // No ceiling, or a ceiling that cannot be divided into: say so rather than guess.
  if (budgetUsd === null || !Number.isFinite(budgetUsd) || budgetUsd <= 0) return UNPROJECTABLE;

  // A negative rate is not physical; a clock skewed behind the window start is. Both floor at
  // zero so neither can push consumption below nothing.
  const rate = Number.isFinite(costPerDay) && costPerDay > 0 ? costPerDay : 0;
  const elapsedDays = Math.max(0, (now - windowStart) / DAY_MS);

  const consumedUsd = rate * elapsedDays;
  const pctConsumed = consumedUsd / budgetUsd;
  const remainingUsd = budgetUsd - consumedUsd;

  // Not spending anything means there is no exhaustion date — null, not Infinity.
  const daysRemaining = rate === 0 ? null : Math.max(0, remainingUsd / rate);

  return { daysRemaining, pctConsumed, basis, confidence: null };
}
