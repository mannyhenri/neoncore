export const SUBSCRIPTION_PROVIDERS = ['claude', 'codex'] as const;
export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number];

export interface ProviderUsage {
  provider: SubscriptionProvider;
  ceilingTokens: number;
  tokensUsed: number;
  tokensPerDay: number;
  pctUsed: number;
  daysRemaining: number | null;
  samples: number;
  confidence: number;
  lastHitAt: string;
}

export function mergeSubscriptionUsage(groups: ProviderUsage[][]): ProviderUsage[] {
  const totals = new Map<SubscriptionProvider, ProviderUsage>();
  const completeRows = SUBSCRIPTION_PROVIDERS.flatMap((provider) => {
    const rows = groups.map((group) => group.find((row) => row.provider === provider));
    if (rows.some((row) => !row)) return [];
    const timestamps = rows.map((row) => Date.parse(row!.lastHitAt));
    if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) return [];
    if (Math.max(...timestamps) - Math.min(...timestamps) > 60_000) return [];
    return rows as ProviderUsage[];
  });
  for (const row of completeRows) {
    const current = totals.get(row.provider);
    if (!current) {
      totals.set(row.provider, { ...row });
      continue;
    }
    current.ceilingTokens += row.ceilingTokens;
    current.tokensUsed += row.tokensUsed;
    current.tokensPerDay += row.tokensPerDay;
    current.samples = Math.max(current.samples, row.samples);
    if (row.samples > 0) {
      current.confidence = current.confidence > 0
        ? Math.min(current.confidence, row.confidence)
        : row.confidence;
    }
    if (row.lastHitAt > current.lastHitAt) current.lastHitAt = row.lastHitAt;
  }
  return [...totals.values()].map((row) => ({
    ...row,
    pctUsed: row.ceilingTokens > 0 ? row.tokensUsed / row.ceilingTokens : 0,
    daysRemaining: row.tokensPerDay > 0
      ? Math.max(0, row.ceilingTokens - row.tokensUsed) / row.tokensPerDay
      : null,
  }));
}

export function subscriptionPillLabel(row: ProviderUsage): string {
  const provider = row.provider === 'claude' ? 'Claude' : 'Codex';
  const percent = `${Math.round(Math.max(0, row.pctUsed) * 100)}%`;
  const time = row.daysRemaining == null
    ? 'learning pace'
    : row.daysRemaining < 1
      ? `${Math.round(row.daysRemaining * 24)}h to 100%`
      : `${row.daysRemaining.toFixed(1)}d to 100%`;
  return `${provider} ${percent} · ${time}`;
}

/**
 * The gauge anchored on a reading of the provider's own meter — server/src/lib/usage-checkpoint.ts.
 * Not merged across servers: the meter is one account, so the first server that has an anchor
 * speaks for it (lib/burnRate.ts).
 */
export type UsageWindow = 'weekly' | 'session';
export interface UsageAnchor {
  provider: string; window: UsageWindow; basis: 'checkpoint' | 'rollover';
  pctUsed: number; pctAtCheckpoint: number; observedAt: string; resetsAt: string;
  pctPerDay: number; hoursToReset: number; hoursToWall: number | null; hitsWallBeforeReset: boolean;
  tokensPerPct: number | null; samples: number; pace: 'ok' | 'watch' | 'hold'; recommendation: string;
}

export const hoursLabel = (h: number): string => (h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`);

/** "Claude 62% · wall in 31h" when the wall comes first, "Claude 62% · resets in 2.1d" when it does not. */
export function usageAnchorLabel(a: UsageAnchor): string {
  const provider = a.provider === 'claude' ? 'Claude' : a.provider === 'codex' ? 'Codex' : a.provider;
  const pct = `${Math.round(Math.max(0, a.pctUsed) * 100)}%`;
  const when = a.pctUsed >= 1
    ? `resets in ${hoursLabel(a.hoursToReset)}`
    : a.hitsWallBeforeReset && a.hoursToWall !== null
      ? `wall in ${hoursLabel(a.hoursToWall)}`
      : `resets in ${hoursLabel(a.hoursToReset)}`;
  return `${provider} ${pct} · ${when}`;
}

/** One reading as a server stores it. */
export interface UsageCheckpoint {
  id: string; provider: string; window: UsageWindow; pctUsed: number;
  resetsAt: string; observedAt: string; localTokens: number;
}

/** A reading as the PERSON logged it: one row, stored once per server it reached. */
export interface FleetReading {
  key: string;
  provider: string;
  window: UsageWindow;
  pctUsed: number;
  resetsAt: string;
  observedAt: string;
  /** Where to delete it — one entry per server that holds a copy. */
  copies: { serverIndex: number; id: string }[];
}

/**
 * The desk logs a reading to EVERY server, so each holds its own row with its own id. Listed
 * raw, one reading would appear once per machine, and removing it from one would leave the
 * gauge on the others still anchored on the typo. Grouped here by what the person typed —
 * provider, window, percent, and the moment it was read (shared by the desk, to the minute for
 * readings from anywhere else) — so one row removes every copy.
 *
 * `answers[i]` is server i's list, or null when it did not answer; newest reading first.
 */
export function groupFleetReadings(answers: (UsageCheckpoint[] | null)[]): FleetReading[] {
  const byKey = new Map<string, FleetReading>();
  answers.forEach((list, serverIndex) => {
    for (const c of list ?? []) {
      const key = `${c.provider}|${c.window}|${Math.round(c.pctUsed * 1000)}|${c.observedAt.slice(0, 16)}`;
      const row = byKey.get(key);
      if (row) {
        if (!row.copies.some((x) => x.serverIndex === serverIndex && x.id === c.id)) row.copies.push({ serverIndex, id: c.id });
      } else {
        byKey.set(key, {
          key, provider: c.provider, window: c.window, pctUsed: c.pctUsed,
          resetsAt: c.resetsAt, observedAt: c.observedAt, copies: [{ serverIndex, id: c.id }],
        });
      }
    }
  });
  return [...byKey.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
}
