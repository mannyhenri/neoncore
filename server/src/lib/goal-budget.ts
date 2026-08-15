/**
 * BUDGET, CHECKED WHERE EVERY DISPATCH PASSES.
 *
 * The cap was consulted in exactly one place — `heartbeat-scheduler.ts` — so it covered
 * scheduled runs and nothing else. A manual launch, a queued task, a confer turn, a workflow
 * step and a dashboard prompt all ignored it completely. A goal could be 400% over its cap and
 * the only thing that noticed was the one path nobody was watching.
 *
 * `sendCommandToAgent` is the single funnel that nine dispatch call sites inherit from, and it
 * already resolves the goal for the brief. Checking here covers all nine at once.
 *
 * ── WARN, DO NOT BLOCK — AND WHY THE HEARTBEAT STILL BLOCKS ────────────────────────────
 * The user decided (2026-08-13) that budget should WARN. Blocking a dispatch mid-session is a
 * strong behaviour: it strands work someone is actively doing, and the cap is an estimate of
 * intent rather than a hard financial limit.
 *
 * The heartbeat gate is deliberately NOT changed to match. It fires unattended on a schedule
 * with nobody watching, so an over-budget goal there would spend indefinitely; a person at the
 * keyboard sees the warning and decides. Attended warns, unattended blocks — a real distinction,
 * not an inconsistency. Both read their numbers from this module so they cannot disagree about
 * what "over" means.
 *
 * ── WHY THE STATE IS PERSISTED ─────────────────────────────────────────────────────────
 * A warning on every dispatch is noise, and noise is how a real warning gets ignored. The
 * alert fires on the TRANSITION into warn and into over, once each. It is stored on the goal
 * rather than held in memory because the server restarts on every source save under `tsx
 * watch` — an in-memory guard would re-fire the same alert several times an hour while someone
 * is working on the code.
 */
import db from '../db.js';
import { goalForAgent } from './goal-brief.js';
import { goalCostUsd } from './goal-cost.js';

/** Fraction of the cap at which the first warning fires. */
export const BUDGET_WARN_RATIO = 0.9;

export type BudgetState = 'ok' | 'warn' | 'over';

export interface BudgetStatus {
  goalId: string;
  goalName: string;
  spentUsd: number;
  capUsd: number;
  /** spent / cap. Can exceed 1. */
  ratio: number;
  state: BudgetState;
}

/** Pure: the state a ratio implies. Separated so the thresholds are testable without a db. */
export function budgetStateFor(ratio: number): BudgetState {
  if (ratio >= 1) return 'over';
  if (ratio >= BUDGET_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * Where a goal stands against its cap, or null when there is nothing to enforce.
 *
 * Null for a goal with no cap set — a budget nobody declared is not a budget breached. That is
 * the live condition today (the one goal has `budget_usd = NULL`), so getting this wrong would
 * fire a warning on every dispatch in the fleet.
 */
export function goalBudgetStatus(goalId: string): BudgetStatus | null {
  const row = db.prepare('SELECT id, name, budget_usd FROM goals WHERE id = ?').get(goalId) as
    { id: string; name: string; budget_usd: number | null } | undefined;
  if (!row || row.budget_usd == null || row.budget_usd <= 0) return null;

  const spentUsd = goalCostUsd(goalId);
  const ratio = spentUsd / row.budget_usd;
  return {
    goalId: row.id,
    goalName: row.name,
    spentUsd,
    capUsd: row.budget_usd,
    ratio,
    state: budgetStateFor(ratio),
  };
}

/** The goal a cartridge is working under, resolved the same way the brief resolves it. */
export function budgetStatusForAgent(agentId: string): BudgetStatus | null {
  const goal = goalForAgent(agentId);
  return goal ? goalBudgetStatus(goal.id) : null;
}

/**
 * Should this dispatch raise an alert? Pure, so the escalation rule is testable directly.
 *
 * Only ESCALATIONS alert. Going from `warn` back to `ok` is silent — that happens when a cap is
 * raised, which is the user acting on the previous warning, and congratulating them on it would
 * train them to ignore the channel.
 */
export function shouldAlert(previous: BudgetState, current: BudgetState): boolean {
  const rank: Record<BudgetState, number> = { ok: 0, warn: 1, over: 2 };
  return rank[current] > rank[previous];
}

export interface BudgetAlert {
  goalId: string;
  goalName: string;
  state: 'warn' | 'over';
  spentUsd: number;
  capUsd: number;
  message: string;
}

/**
 * Record where a goal now stands and return an alert if this dispatch crossed a threshold.
 *
 * Called from the dispatch funnel. Never throws and never refuses: the caller carries on
 * regardless, which is what "warn, do not block" means in practice.
 */
export function noteBudgetOnDispatch(agentId: string): BudgetAlert | null {
  let status: BudgetStatus | null;
  try {
    status = budgetStatusForAgent(agentId);
  } catch {
    // A budget check must never be able to stop work being dispatched.
    return null;
  }
  if (!status) return null;

  const row = db.prepare('SELECT budget_alert_state FROM goals WHERE id = ?').get(status.goalId) as
    { budget_alert_state?: string } | undefined;
  const previous = (row?.budget_alert_state || 'ok') as BudgetState;

  if (previous !== status.state) {
    db.prepare('UPDATE goals SET budget_alert_state = ? WHERE id = ?').run(status.state, status.goalId);
  }
  if (!shouldAlert(previous, status.state)) return null;

  const pct = Math.round(status.ratio * 100);
  return {
    goalId: status.goalId,
    goalName: status.goalName,
    state: status.state as 'warn' | 'over',
    spentUsd: status.spentUsd,
    capUsd: status.capUsd,
    message: status.state === 'over'
      ? `"${status.goalName}" is over budget — $${status.spentUsd.toFixed(2)} of $${status.capUsd.toFixed(2)} (${pct}%). Work continues; raise the cap or stop dispatching to it.`
      : `"${status.goalName}" is at ${pct}% of budget — $${status.spentUsd.toFixed(2)} of $${status.capUsd.toFixed(2)}.`,
  };
}
