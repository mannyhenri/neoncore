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
}

/** Quantities that ADD when two servers are combined. */
export const SUMMED_KEYS = [
  'tokens', 'tokensPerHour', 'tokensPerDay', 'costUsd', 'costPerDay', 'samples', 'activeCartridges',
] as const;

/** Quantities that describe the QUESTION, identical on every server, so they carry through. */
export const WINDOW_KEYS = ['windowHours', 'days'] as const;

/**
 * `results` holds one entry per server asked, with `null` for any that failed or timed out.
 * A failed server is counted in `serversAsked` but contributes nothing — the readout can then
 * say it is partial instead of quietly under-reporting the fleet.
 */
export function mergeBurnRates(results: (ServerBurnRate | null)[], days: number): FleetBurnRate {
  const ok = results.filter((r): r is ServerBurnRate => r != null && Number.isFinite(r.tokensPerDay));

  const merged = {} as Record<string, number>;
  for (const k of SUMMED_KEYS) merged[k] = ok.reduce((sum, r) => sum + (Number(r[k]) || 0), 0);
  // Take the window from whoever answered; fall back to what we asked for.
  merged.days = ok[0]?.days ?? days;
  merged.windowHours = ok[0]?.windowHours ?? days * 24;

  return {
    ...(merged as unknown as ServerBurnRate),
    serversReporting: ok.length,
    serversAsked: results.length,
  };
}
