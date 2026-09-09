/**
 * The declared weekly budget — the "tank" the burn rate divides into.
 *
 * NeonCore has always measured the FLOW precisely (lib/burn-rate.ts averages every token
 * class out of `session_usage`). What it has never had is a ceiling, so it could say how fast
 * spend was happening but never how long it could continue. This is that ceiling, declared by
 * the user rather than fetched: no Anthropic API reports remaining subscription quota, so the
 * number is necessarily an estimate and the code says so via `basis`.
 *
 * ── UNSET IS NOT ZERO ─────────────────────────────────────────────────────────────────
 * `usdWeekly` is `null` when no budget exists and a number when one does. It is never 0-as-
 * unset, because the projection has to distinguish "I have no idea how long you have" from
 * "you are already out". Collapsing them renders a confident "0 days left" to a user who
 * simply never set a budget, which is the exact failure the epic's basis rule exists to stop.
 *
 * Stored in the existing `settings` key/value table rather than a new one — that store already
 * holds every other piece of instance configuration and is served by GET/PUT /api/settings.
 */

/** THE REGISTRY. Every settings key this feature owns; validation iterates it. */
export const BUDGET_KEYS = ['usage_budget_usd_weekly', 'usage_budget_basis'] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

/** What the number rests on. `measured` is reserved for GAS-013's learned ceiling. */
export type BudgetBasis = 'budget' | 'measured';
const BASES: readonly BudgetBasis[] = ['budget', 'measured'];

export interface Budget {
  /** USD per week, or null when no budget is set. Never 0 for "unset". */
  usdWeekly: number | null;
  basis: BudgetBasis;
}

/**
 * Read path, deliberately forgiving: a value that should never have been stored reads as
 * unset rather than as NaN. `validateBudgetValue` is what stops it being written; this is the
 * second line, so a hand-edited database degrades to "no basis" instead of a broken gauge.
 */
export function parseWeeklyBudget(raw: string | undefined | null): number | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;   // 0, -0 and negatives are all "no budget"
  return n;
}

export function parseBasis(raw: string | undefined | null): BudgetBasis {
  const t = (raw ?? '').trim() as BudgetBasis;
  return BASES.includes(t) ? t : 'budget';
}

/** Assemble the pair from a settings snapshot. Pure — the caller supplies the rows. */
export function budgetFrom(settings: Record<string, string | undefined>): Budget {
  return {
    usdWeekly: parseWeeklyBudget(settings.usage_budget_usd_weekly),
    basis: parseBasis(settings.usage_budget_basis),
  };
}

/**
 * Write path. Returns an error message, or null when the value is acceptable — including for
 * keys this feature does not own, which must pass through untouched: the same store holds
 * `fleet_token`, `projects_dir` and the API keys, and a budget validator has no business
 * rejecting any of them.
 *
 * PUT /api/settings is a generic string upsert, so without this `"banana"` stores cleanly and
 * surfaces days later as NaN days remaining.
 */
export function validateBudgetValue(key: string, value: string): string | null {
  if (!(BUDGET_KEYS as readonly string[]).includes(key)) return null;

  if (key === 'usage_budget_basis') {
    const t = value.trim();
    if (!t) return null;                              // blank clears it back to the default
    return BASES.includes(t as BudgetBasis) ? null
      : `usage_budget_basis must be one of ${BASES.join(', ')} (got "${value}")`;
  }

  const t = value.trim();
  if (!t) return null;                                // blank clears the budget
  const n = Number(t);
  if (!Number.isFinite(n)) return `usage_budget_usd_weekly must be a number (got "${value}")`;
  if (n < 0) return `usage_budget_usd_weekly cannot be negative (got "${value}")`;
  return null;
}
