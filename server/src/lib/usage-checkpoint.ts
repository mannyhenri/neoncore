/**
 * A usage CHECKPOINT: the number Claude itself shows — "62% of the weekly limit, resets
 * Sunday 14:00" — logged by the person who saw it.
 *
 * REPORTED: "would it help to add my current claude usage at any point and then neoncore
 * could adjust based on a bunch of calculations... would it basically help to add more state
 * throughout the week?"
 *
 * Yes, because it is a different KIND of number. Everything else in this directory is local:
 * tokens counted from hooks, priced from a table, divided into a ceiling the user guessed or
 * that limit events might one day teach us. The percentage Claude displays is ground truth
 * from the other side — it includes claude.ai chats, Desktop, cache accounting and the exact
 * reset time, none of which the fleet can see. A local count will always drift from it.
 *
 * One checkpoint pins the drift. Two in the same window give the real pace in the currency
 * that matters (percent per day) and, with the local token count between them, how many of
 * OUR tokens make one of THEIR percent — which is what lets the gauge keep moving between
 * checkpoints instead of freezing at the last thing typed in.
 *
 * ── WHAT IS DERIVED, AND WHAT IS NOT ──────────────────────────────────────────────────
 * Derived: the current percent (checkpoint + local tokens since, when the exchange rate is
 * known; otherwise the checkpoint's own average pace), hours to the wall, hours to reset,
 * whether the wall comes first, and a pace verdict. Not derived: a ceiling in tokens when no
 * two checkpoints have measured one — `tokensPerPct` stays null and the projection says so by
 * carrying `samples`. A number that was not measured is not presented as one.
 *
 * ── PACE IS A RECOMMENDATION, NOT A THROTTLE ──────────────────────────────────────────
 * `hold` and `watch` are shown, never enforced. The dispatch path does not read this module.
 * Automating a slowdown before the projection has been watched being right for a couple of
 * weeks would trade a visible number for an invisible brake, and an invisible brake is the
 * kind of thing that gets blamed on a bug elsewhere.
 */
import { median } from './statistics.js';

export const USAGE_WINDOWS = ['weekly', 'session'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long each window runs. `session` is the rolling five-hour meter. */
export const WINDOW_LENGTH_MS: Record<UsageWindow, number> = {
  weekly: 7 * DAY_MS,
  session: 5 * HOUR_MS,
};

/** Within this, a wall inside the window is "act now"; beyond it, "keep an eye on it". */
export const HOLD_HORIZON_HOURS = 24;

export type Pace = 'ok' | 'watch' | 'hold';

export interface UsageCheckpoint {
  id: string;
  provider: string;
  window: UsageWindow;
  /** 0..1 — what the provider displayed. */
  pctUsed: number;
  /** ISO — when the provider says this window resets. */
  resetsAt: string;
  /** ISO — when the person read the number. */
  observedAt: string;
  /** Tokens the fleet counted for this provider from the window's start to observedAt. */
  localTokens: number;
}

export interface UsageAnchor {
  provider: string;
  window: UsageWindow;
  basis: 'checkpoint' | 'rollover';
  /** 0..n — extrapolated to now. Not clamped at 1: an overrun is information. */
  pctUsed: number;
  pctAtCheckpoint: number;
  observedAt: string;
  resetsAt: string;
  pctPerDay: number;
  hoursToReset: number;
  /** Null when the pace is zero — nothing is being spent, so there is no wall. */
  hoursToWall: number | null;
  hitsWallBeforeReset: boolean;
  /** Our tokens per one of the provider's percent. Null until two checkpoints measured it. */
  tokensPerPct: number | null;
  /** Checkpoints in the current window that this anchor rests on. */
  samples: number;
  pace: Pace;
  recommendation: string;
}

export interface CheckpointInput {
  provider?: unknown;
  window?: unknown;
  /** Percent as displayed, 0..100. */
  pctUsed?: unknown;
  resetsAt?: unknown;
  observedAt?: unknown;
}

export interface ValidCheckpoint {
  provider: string;
  window: UsageWindow;
  pctUsed: number;       // 0..1
  resetsAt: string;
  observedAt: string;
}

/**
 * Every way a checkpoint can be wrong, stated. `providers` is passed in rather than imported
 * so this stays pure and the route decides which providers exist.
 */
export function validateCheckpoint(
  input: CheckpointInput,
  providers: readonly string[],
  now = Date.now(),
): { ok: true; value: ValidCheckpoint } | { ok: false; error: string } {
  const provider = String(input.provider ?? '').toLowerCase();
  if (!providers.includes(provider)) return { ok: false, error: `provider must be one of ${providers.join(', ')}` };

  const window = String(input.window ?? 'weekly') as UsageWindow;
  if (!USAGE_WINDOWS.includes(window)) return { ok: false, error: `window must be one of ${USAGE_WINDOWS.join(', ')}` };

  const pct = Number(input.pctUsed);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, error: 'pctUsed must be a number from 0 to 100, as the provider shows it' };

  const observed = input.observedAt == null ? now : Date.parse(String(input.observedAt));
  if (!Number.isFinite(observed) || observed > now + 60_000 || observed < now - 31 * DAY_MS) {
    return { ok: false, error: 'observedAt must be a valid time within the past month and not in the future' };
  }

  const resets = Date.parse(String(input.resetsAt ?? ''));
  if (!Number.isFinite(resets)) return { ok: false, error: 'resetsAt must be a valid time — the reset the provider shows next to the percentage' };
  if (resets <= observed) return { ok: false, error: 'resetsAt must be after the time the number was read' };
  if (resets - observed > WINDOW_LENGTH_MS[window] + HOUR_MS) {
    return { ok: false, error: `resetsAt is more than one ${window} window away — check the window or the date` };
  }

  return {
    ok: true,
    value: {
      provider, window, pctUsed: pct / 100,
      resetsAt: new Date(resets).toISOString(),
      observedAt: new Date(observed).toISOString(),
    },
  };
}

/** The window a checkpoint describes starts one window-length before it resets. */
export function windowStartOf(c: Pick<UsageCheckpoint, 'window' | 'resetsAt'>): number {
  return Date.parse(c.resetsAt) - WINDOW_LENGTH_MS[c.window];
}

/** Two checkpoints describe the same window when they name the same reset (to the hour). */
function sameWindow(a: UsageCheckpoint, b: UsageCheckpoint): boolean {
  return a.window === b.window && Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) <= HOUR_MS;
}

/**
 * Our tokens per one of the provider's percent, from every pair of consecutive checkpoints
 * that share a window and both moved. Median, so one mis-typed reading does not own the rate.
 */
export function tokensPerPercent(checkpoints: UsageCheckpoint[]): number | null {
  const sorted = [...checkpoints].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const rates: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (!sameWindow(a, b)) continue;
    const dPct = (b.pctUsed - a.pctUsed) * 100;
    const dTok = b.localTokens - a.localTokens;
    if (dPct > 0 && dTok > 0) rates.push(dTok / dPct);
  }
  return rates.length ? median(rates) : null;
}

export interface AnchorInput {
  /** Every checkpoint for one provider, any window mix, any order. */
  checkpoints: UsageCheckpoint[];
  window: UsageWindow;
  /** Tokens the fleet counted for this provider since the latest checkpoint was read. */
  localTokensSinceLatest: number;
  /** Tokens the fleet counted since the latest checkpoint's reset — for after a rollover. */
  localTokensSinceReset: number;
  now?: number;
}

function paceOf(pctUsed: number, hoursToWall: number | null, hoursToReset: number): Pace {
  if (pctUsed >= 1) return 'hold';
  if (hoursToWall === null || hoursToWall >= hoursToReset) return 'ok';
  return hoursToWall <= HOLD_HORIZON_HOURS ? 'hold' : 'watch';
}

const hrs = (h: number) => (h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`);

function recommend(a: Omit<UsageAnchor, 'recommendation'>): string {
  const pct = `${Math.round(a.pctUsed * 100)}%`;
  if (a.pctUsed >= 1) return `${pct} used — the ${a.window} limit is spent; it resets in ${hrs(a.hoursToReset)}. Hold non-urgent work until then.`;
  if (a.hoursToWall === null) return `${pct} used, nothing spent recently. Resets in ${hrs(a.hoursToReset)}.`;
  if (!a.hitsWallBeforeReset) return `${pct} used, on pace to reset in ${hrs(a.hoursToReset)} with headroom (wall in ${hrs(a.hoursToWall)} at this rate).`;
  if (a.pace === 'hold') return `${pct} used — at this pace the wall comes in ${hrs(a.hoursToWall)}, ${hrs(a.hoursToReset - a.hoursToWall)} before the reset. Hold low-priority lanes and prefer small dispatches.`;
  return `${pct} used — at this pace the wall comes in ${hrs(a.hoursToWall)}, before the reset in ${hrs(a.hoursToReset)}. Watch it; defer what can wait until after the reset.`;
}

/**
 * The projection anchored on the latest checkpoint for `window`, or null when there is none.
 *
 * After the checkpoint's reset has passed, the window it described is gone. If two checkpoints
 * had measured tokens-per-percent, the new window is projected from local tokens alone
 * (`basis: 'rollover'`) — that is the continuity a checkpoint buys. Without that rate there is
 * nothing honest to say about the new window, and null is returned so the gauge asks for a
 * fresh reading rather than showing last week's.
 */
export function anchorFromCheckpoints(input: AnchorInput): UsageAnchor | null {
  const now = input.now ?? Date.now();
  const inWindow = input.checkpoints.filter((c) => c.window === input.window);
  if (inWindow.length === 0) return null;
  const latest = inWindow.reduce((a, b) => (Date.parse(b.observedAt) > Date.parse(a.observedAt) ? b : a));
  const rate = tokensPerPercent(inWindow);
  const length = WINDOW_LENGTH_MS[input.window];

  let resetsAtMs = Date.parse(latest.resetsAt);
  let basis: UsageAnchor['basis'] = 'checkpoint';
  let pctAtCheckpoint = latest.pctUsed;
  let observedAt = latest.observedAt;
  let pctUsed: number;
  let samples = inWindow.filter((c) => sameWindow(c, latest)).length;

  if (resetsAtMs <= now) {
    // The described window is over. Roll forward as many windows as have elapsed.
    if (rate === null) return null;
    while (resetsAtMs <= now) resetsAtMs += length;
    basis = 'rollover';
    pctAtCheckpoint = 0;
    observedAt = new Date(resetsAtMs - length).toISOString();
    pctUsed = input.localTokensSinceReset > 0 ? input.localTokensSinceReset / rate / 100 : 0;
    samples = 0;
  } else if (rate !== null) {
    pctUsed = latest.pctUsed + Math.max(0, input.localTokensSinceLatest) / rate / 100;
  } else {
    // No exchange rate yet: carry the checkpoint forward at its own average pace.
    const elapsedAtRead = Math.max(HOUR_MS, Date.parse(latest.observedAt) - windowStartOf(latest));
    const perMs = latest.pctUsed / elapsedAtRead;
    pctUsed = latest.pctUsed + perMs * Math.max(0, now - Date.parse(latest.observedAt));
  }

  const windowStart = resetsAtMs - length;
  const sorted = inWindow.filter((c) => sameWindow(c, latest)).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  // Pace: the slope between the last two readings when there are two, else the window average.
  let pctPerDay: number;
  if (basis === 'checkpoint' && sorted.length >= 2) {
    const a = sorted[sorted.length - 2], b = sorted[sorted.length - 1];
    const days = (Date.parse(b.observedAt) - Date.parse(a.observedAt)) / DAY_MS;
    pctPerDay = days > 0 ? Math.max(0, (b.pctUsed - a.pctUsed) / days) : 0;
  } else {
    const elapsedDays = Math.max(1 / 24, (now - windowStart) / DAY_MS);
    pctPerDay = pctUsed / elapsedDays;
  }

  const hoursToReset = Math.max(0, (resetsAtMs - now) / HOUR_MS);
  const hoursToWall = pctUsed >= 1 ? 0 : pctPerDay > 0 ? ((1 - pctUsed) / pctPerDay) * 24 : null;
  const hitsWallBeforeReset = hoursToWall !== null && hoursToWall < hoursToReset;
  const pace = paceOf(pctUsed, hoursToWall, hoursToReset);

  const partial = {
    provider: latest.provider, window: input.window, basis,
    pctUsed, pctAtCheckpoint, observedAt, resetsAt: new Date(resetsAtMs).toISOString(),
    pctPerDay, hoursToReset, hoursToWall, hitsWallBeforeReset, tokensPerPct: rate, samples, pace,
  };
  return { ...partial, recommendation: recommend(partial) };
}
