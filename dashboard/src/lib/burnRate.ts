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
export interface ServerBurnRate {
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
  /** How many servers actually answered, and how many were asked. */
  serversReporting: number;
  serversAsked: number;
  /** Named, with the reason — "reachable but on an old build" is not "down". */
  problems: Problem[];
}

/** Quantities that ADD when two servers are combined. */
import { problemsIn, type ServerAnswer, type Problem } from './serverAnswer';

export const SUMMED_KEYS = [
  'tokens', 'tokensPerHour', 'tokensPerDay', 'costUsd', 'costPerDay', 'samples', 'activeCartridges',
] as const;

/** Quantities that describe the QUESTION, identical on every server, so they carry through. */
export const WINDOW_KEYS = ['windowHours', 'days'] as const;

/**
 * `answers` holds one labelled entry per server asked. A server that failed contributes
 * nothing but is still counted and NAMED, with the reason, so a partial total can say which
 * machine is missing and what to do about it rather than only that one is.
 */
/** A well-formed answer. The old build's `[]` is truthy and fails this, which is the point. */
const usableRate = (r: ServerBurnRate) => Number.isFinite(r?.tokensPerDay);

export function mergeBurnRates(answers: ServerAnswer<ServerBurnRate>[], days: number): FleetBurnRate {
  const ok = answers.map((a) => a.result).filter((r): r is ServerBurnRate => r != null && usableRate(r));

  const merged = {} as Record<string, number>;
  for (const k of SUMMED_KEYS) merged[k] = ok.reduce((sum, r) => sum + (Number(r[k]) || 0), 0);
  // Take the window from whoever answered; fall back to what we asked for.
  merged.days = ok[0]?.days ?? days;
  merged.windowHours = ok[0]?.windowHours ?? days * 24;

  return {
    ...(merged as unknown as ServerBurnRate),
    serversReporting: ok.length,
    serversAsked: answers.length,
    problems: problemsIn(answers, usableRate),
  };
}
