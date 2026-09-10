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

/**
 * ── COMPOSITION FOR THE API (GAS-007) ─────────────────────────────────────────────────
 *
 * The two halves that exist but had never met in a response: the declared ceiling from
 * lib/budget.ts and the arithmetic above. Pure — settings are passed in, not read — so the
 * route stays a thin shell and this is testable without an HTTP harness.
 *
 * THE WINDOW ANCHOR. `project()` needs a windowStart and the epic's Open Question 1 — whether
 * the badge leads with the 5-hour meter or the weekly one — is unresolved. The setting is
 * `usage_budget_usd_weekly`, so this assumes the WEEKLY meter and anchors on the convention
 * already in this codebase: `bucketStart(now, 'week')`, which floors to Monday UTC. Reusing it
 * rather than inventing an anchor keeps the badge and the tokens chart agreeing on what "this
 * week" means; two views of the same spend that disagreed on the window would be worse than
 * either alone. If the 5-hour meter wins later, only this line changes.
 *
 * `windowStart` is returned rather than kept private so a client can render "resets in 3 days"
 * without recomputing an anchor it would have to keep in sync.
 */
import { budgetFrom } from './budget.js';
import { bucketStart } from './usage-series.js';

export interface BudgetProjection {
  budget: { usd: number | null; basis: BudgetBasis };
  projection: Projection;
  /** Epoch ms the current budget window began — Monday 00:00 UTC. */
  windowStart: number;
}

export function budgetProjection(input: {
  costPerDay: number;
  settings: Record<string, string | undefined>;
  now?: number;
  /** A ceiling learned from real limit events (GAS-013). Overrides the declared budget. */
  learned?: { usdWeekly: number; confidence: number; samples: number } | null;
}): BudgetProjection {
  const now = input.now ?? Date.now();
  const windowStart = bucketStart(now, 'week');
  const declared = budgetFrom(input.settings);

  /**
   * A MEASURED ceiling outranks a declared one (GAS-013). The user's number is a guess about
   * a limit Anthropic does not publish; a learned one is where the wall actually was. The
   * basis changes with it, because a badge reading "budget" over a figure the user never typed
   * is the same lie as an unlabelled number — and learnedCeiling() already refuses to return
   * anything below its confidence threshold, so reaching here means it was earned.
   */
  const usdWeekly = input.learned ? input.learned.usdWeekly : declared.usdWeekly;
  const basis: BudgetBasis = input.learned ? 'measured' : declared.basis;

  return {
    budget: { usd: usdWeekly, basis },
    projection: project({ costPerDay: input.costPerDay, budgetUsd: usdWeekly, windowStart, now, basis }),
    windowStart,
  };
}
