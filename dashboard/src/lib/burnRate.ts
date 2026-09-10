/**
 * Merging the burn rate across a FEDERATED fleet.
 *
 * Each NeonCore server owns its own database. A cartridge on the studio machine writes its
 * turns to the studio server's `session_usage`; this server has never seen a row of it. So a
 * header readout built on `api.getBurnRate()` alone reports one machine and silently calls it
 * "the fleet" — which is worse than showing nothing, because the number looks complete.
 *
 * The dashboard already solved this shape for agents (hooks/useAgents.ts fans reads across
 * `activeServers` and merges). This is the same fan-out for one scalar per server.
 *
 * WHY THE KEYS ARE CLASSIFIED RATHER THAN SUMMED WHOLESALE. `days`/`windowHours` describe the
 * window every server was asked for; adding them would report a 14-day window for two servers
 * asked about 7. Every other numeric field is an extensive quantity and must add. A new field
 * that is neither is a bug, so the split is asserted in the test rather than left implicit.
 */

/** One server's answer to GET /activity/burn-rate. */
/** The account ceiling and the projection, added by GAS-007. Optional: an older server has neither. */
export interface ServerBudget { usd: number | null; basis: 'budget' | 'measured' }
export interface ServerProjection {
  daysRemaining: number | null;
  pctConsumed: number | null;
  basis: 'budget' | 'measured' | 'unknown';
  confidence: number | null;
}

export interface ServerBurnRate {
  subscriptionUsage?: import('./subscriptionUsage').ProviderUsage[];
  budget?: ServerBudget;
  projection?: ServerProjection;
  /** Epoch ms the budget window began — Monday 00:00 UTC, identical on every server. */
  windowStart?: number;
  windowHours: number;
  tokens: number;
  tokensPerHour: number;
  tokensPerDay: number;
  costUsd: number;
  costPerDay: number;
  samples: number;
  days: number;
  activeCartridges: number;
}

export interface FleetBurnRate extends ServerBurnRate {
  subscriptionUsage: import('./subscriptionUsage').ProviderUsage[];
  /** Always present on a merged result, even when no server reported one. */
  budget: ServerBudget;
  projection: ServerProjection;
  /** How many servers actually answered, and how many were asked. */
  serversReporting: number;
  serversAsked: number;
  /** Named, with the reason — "reachable but on an old build" is not "down". */
  problems: Problem[];
}

/** Quantities that ADD when two servers are combined. */
import { problemsIn, type ServerAnswer, type Problem } from './serverAnswer';
import { mergeSubscriptionUsage } from './subscriptionUsage';

export const SUMMED_KEYS = [
  'tokens', 'tokensPerHour', 'tokensPerDay', 'costUsd', 'costPerDay', 'samples', 'activeCartridges',
] as const;

/** Quantities that describe the QUESTION, identical on every server, so they carry through. */
export const WINDOW_KEYS = ['windowHours', 'days'] as const;

/**
 * Properties of the ACCOUNT, not of a machine (GAS-008). Identical on every server by
 * definition, so they are taken ONCE and never summed — summing a budget across three servers
 * would triple the ceiling and report headroom that does not exist.
 */
export const ACCOUNT_KEYS = ['budget', 'projection', 'windowStart'] as const;
/** Values recomputed from every server rather than summed or selected from one server. */
export const DERIVED_KEYS = ['subscriptionUsage'] as const;

/**
 * `answers` holds one labelled entry per server asked. A server that failed contributes
 * nothing but is still counted and NAMED, with the reason, so a partial total can say which
 * machine is missing and what to do about it rather than only that one is.
 */
/** A well-formed answer. The old build's `[]` is truthy and fails this, which is the point. */
const usableRate = (r: ServerBurnRate) => Number.isFinite(r?.tokensPerDay);

export function mergeBurnRates(answers: ServerAnswer<ServerBurnRate>[], days: number, now = Date.now()): FleetBurnRate {
  const ok = answers.map((a) => a.result).filter((r): r is ServerBurnRate => r != null && usableRate(r));

  const merged = {} as Record<string, number>;
  for (const k of SUMMED_KEYS) merged[k] = ok.reduce((sum, r) => sum + (Number(r[k]) || 0), 0);
  // Take the window from whoever answered; fall back to what we asked for.
  merged.days = ok[0]?.days ?? days;
  merged.windowHours = ok[0]?.windowHours ?? days * 24;

  /**
   * THE BUDGET IS A THIRD CLASS OF KEY (GAS-008), and the bug this file's header predicted.
   *
   * It is neither extensive nor a description of the question: it is a property of the
   * Anthropic ACCOUNT. Summing three servers' budgets would yield a fleet ceiling three times
   * the real one and the projection would report MORE headroom than exists — the failure
   * direction that actually hurts, because the gauge says four days and the work stops in one.
   * So it is taken ONCE.
   */
  const reported = ok.filter((r) => typeof r.budget?.usd === 'number') as (ServerBurnRate & { budget: ServerBudget })[];
  const distinct = [...new Set(reported.map((r) => r.budget.usd as number))];
  const conflict = distinct.length > 1;
  const accountBudget = conflict ? null : (distinct[0] ?? null);
  const windowStart = ok.find((r) => typeof r.windowStart === 'number')?.windowStart ?? null;

  /**
   * pctConsumed is DERIVED from the merged rate, not summed from the servers.
   *
   * Summing is arithmetically identical while every server reports one — each is
   * (its rate × the same elapsed) / the same budget. But a server on an older build
   * contributes its RATE to the total and has no projection to contribute, so summing would
   * count its spend in costPerDay and omit it from pctConsumed. Deriving keeps the two
   * consistent whatever mix of builds answered.
   *
   * daysRemaining cannot be merged at all: it is budget × (1 − pct) / rate, and rates that add
   * do not make quotients that add. Recomputed from the merged rate.
   */
  const rate = merged.costPerDay;
  const elapsedDays = windowStart == null ? 0 : Math.max(0, (now - windowStart) / 86_400_000);
  const usable = accountBudget != null && accountBudget > 0;
  const pctConsumed = usable ? (rate * elapsedDays) / (accountBudget as number) : null;
  const daysRemaining = usable && rate > 0
    ? Math.max(0, ((accountBudget as number) * (1 - (pctConsumed as number))) / rate)
    : null;

  const budgetProblems: Problem[] = conflict
    ? reported.map((_r, i) => ({ label: answers[i]?.label ?? `server ${i + 1}`, reason: 'budget-conflict' as const }))
    : [];

  return {
    ...(merged as unknown as ServerBurnRate),
    budget: { usd: accountBudget, basis: (accountBudget != null && !conflict ? reported[0]?.budget.basis : 'budget') ?? 'budget' },
    projection: {
      daysRemaining,
      pctConsumed,
      basis: usable ? ((reported[0]?.budget.basis ?? 'budget') as 'budget' | 'measured') : 'unknown',
      confidence: null,
    },
    windowStart: windowStart ?? undefined,
    serversReporting: ok.length,
    serversAsked: answers.length,
    problems: [...problemsIn(answers, usableRate), ...budgetProblems],
    // Mixed builds are normal during deployment. A server without this field owns an unknown
    // share of both the ceiling and current usage, so showing a partial gauge would be false.
    subscriptionUsage: ok.length === answers.length
      && ok.every((row) => Array.isArray(row.subscriptionUsage))
      ? mergeSubscriptionUsage(ok.map((row) => row.subscriptionUsage!))
      : [],
  };
}

/**
 * The projection pill's text — ONE string with the basis already inside it (GAS-009).
 *
 * The epic's non-negotiable is that the badge says what its number rests on: "2.9d left" from
 * a budget the user typed and the same figure from a measured ceiling are different claims,
 * and an unlabelled one is worse than none at all. Returning the number and the suffix
 * separately would let a later edit render just the number; returning them fused makes that
 * impossible, and a test asserts the property over a grid rather than at one point.
 *
 * Null means "nothing to say here" — no budget, an unusable rate, or a server too old to carry
 * a projection. The badge then shows the bare rate it has always shown. GAS-010 owns turning
 * that silence into a "set a budget" affordance.
 */
export function projectionLabel(rate: FleetBurnRate): string | null {
  const p = rate?.projection;
  const days = p?.daysRemaining;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return null;
  if (!p?.basis || p.basis === 'unknown') return null;

  // Under a day, days are the wrong unit — "0.4d left" is not something anyone reads as time.
  // At a year or more the decimal is noise. Neither branch can emit a sign, so the label
  // cannot render a countdown running backwards even if a future caller hands one over.
  const time = days < 1
    ? `${Math.round(days * 24)}h`
    : days >= 100
      ? `${Math.round(days)}d`
      : `${days.toFixed(1)}d`;

  return `${time} left · ${p.basis}`;
}

/**
 * What the badge puts in the projection slot — including when it cannot put a number there
 * (GAS-010).
 *
 * Three ways to have no figure, with three different right answers:
 *
 *   NO BUDGET      unknowable, but the user can fix it — so prompt, rather than stay blank.
 *   PARTIAL FLEET  a rate summed from only some servers is LOWER than the truth, so a
 *                  projection built on it reports MORE headroom than exists. That is the
 *                  failure direction that hurts: the gauge says four days and the work stops
 *                  in one. Suppressed rather than shown with a caveat, because a caveat under
 *                  a confident number gets read as decoration. The badge's existing `*` and
 *                  tooltip already say the rate itself is partial.
 *   CONFLICT       servers disagree on the budget. One exists, so "set a budget" is the wrong
 *                  advice; the projection is unsound, so a figure would be a lie. Silence, plus
 *                  the problem the merge already reports.
 */
export type ProjectionSlot = { kind: 'projection' | 'prompt'; text: string } | null;

export function projectionSlot(rate: FleetBurnRate): ProjectionSlot {
  // Any unanswered or outdated server makes the rate an undercount, and an undercount is
  // exactly what must not be turned into a reassuring number.
  if (rate?.problems?.length) return null;

  const label = projectionLabel(rate);
  if (label) return { kind: 'projection', text: label };

  // No ceiling and nothing wrong with the fleet: the one case the user can act on.
  if (rate?.budget && rate.budget.usd == null) return { kind: 'prompt', text: 'set a budget' };

  return null;
}

/**
 * The budget block on the token report (GAS-011) — where the week actually stands.
 *
 * The badge answers "how long left" in four characters. This is what you open when that number
 * surprises you: the ceiling, how much is gone, the DATE the week runs out, and whether the
 * current rate is above or below the pace the budget allows.
 *
 * PACE is the figure the pill cannot give you. "2.9d left" says where you are; it does not say
 * whether that is normal. A weekly budget allows budget/7 per day, so spending measured against
 * that allowance is the honest answer — 100% is exactly on plan, 210% means the week ends on
 * Thursday. It is the number a person can act on.
 *
 * Suppressed on a partial fleet for the same reason GAS-010 suppresses the pill, and with more
 * force: an undercounted rate makes every figure here overstate headroom, and a stats table
 * reads as a ledger, which is believed harder than a pill.
 */
export interface BudgetStats {
  budgetUsd: number;
  consumedUsd: number;
  /** Floored at zero: an overspent week has nothing left, not a negative amount. */
  remainingUsd: number;
  /** Epoch ms the budget runs out at the current rate, or null when nothing is being spent. */
  exhaustionAt: number | null;
  /** Actual daily spend over what the budget allows per day. 1 is exactly on plan. */
  pacePct: number;
  basis: 'budget' | 'measured';
}

export function budgetStats(rate: FleetBurnRate, now = Date.now()): BudgetStats | null {
  if (rate?.problems?.length) return null;              // an undercount must not become a ledger

  const usd = rate?.budget?.usd;
  const p = rate?.projection;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  if (!p || p.basis === 'unknown') return null;

  const pct = Number.isFinite(p.pctConsumed as number) ? Math.max(0, p.pctConsumed as number) : 0;
  const consumedUsd = usd * pct;
  const perDayAllowed = usd / 7;
  const spend = Number.isFinite(rate.costPerDay) && rate.costPerDay > 0 ? rate.costPerDay : 0;

  return {
    budgetUsd: usd,
    consumedUsd,
    remainingUsd: Math.max(0, usd - consumedUsd),
    exhaustionAt: typeof p.daysRemaining === 'number' && Number.isFinite(p.daysRemaining)
      ? now + p.daysRemaining * 86_400_000
      : null,
    pacePct: perDayAllowed > 0 ? spend / perDayAllowed : 0,
    basis: p.basis,
  };
}
