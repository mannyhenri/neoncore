/**
 * The ceiling learned from where the wall actually was.
 *
 * GAS-012 records a row each time a usage limit is hit, carrying the spend at that moment.
 * This turns those rows into a ceiling and marks it `measured`, so the gauge can eventually
 * stop dividing a number the user guessed at. Until then it returns null and the declared
 * budget stands.
 *
 * ── A `measured` LABEL HAS TO BE EARNED ───────────────────────────────────────────────
 * Every task in this epic has followed one rule: never present a guess as a measurement. This
 * is where breaking it is most tempting, because a ceiling derived from a single observation
 * looks exactly like data. Below the observation threshold, or below the confidence threshold,
 * this returns null and nothing changes. There are ZERO rows in this fleet today, so null is
 * the honest answer right now and will be for a while.
 *
 * ── NOT EVERY LIMIT SIGNAL IS A CEILING ───────────────────────────────────────────────
 * A 429 or a transient rate-limit says the API pushed back at that instant. It says nothing
 * about how much the week allows, and averaging those in would drag the estimate toward
 * whatever spend happened to be on the clock during a burst. Only plan-limit markers count.
 */
import type { LimitEvent } from './limit-events.js';

/** Markers that describe a PLAN ceiling. Throttles are deliberately excluded. */
export const CEILING_MARKERS = ['usage-limit-reached', 'reached-your-limit', 'approaching-usage-limit'] as const;

/** Two points that agree are still two points. */
export const MIN_OBSERVATIONS = 3;

/** Below this, the observations do not describe one ceiling and we say nothing. */
export const CONFIDENCE_THRESHOLD = 0.6;

export interface LearnedCeiling {
  usdWeekly: number;
  /** 0..1, from how tightly the observations agree. Never invented — derived from spread. */
  confidence: number;
  samples: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function learnedCeiling(events: LimitEvent[]): LearnedCeiling | null {
  const ceilingMarkers = new Set<string>(CEILING_MARKERS);
  const costs = (events || [])
    .filter((e) => ceilingMarkers.has(e.marker))
    .map((e) => e.cost_usd_at_event)
    .filter((c) => Number.isFinite(c) && c >= 0);

  if (costs.length < MIN_OBSERVATIONS) return null;

  // MEDIAN, not mean: one observation taken during an unusual burst should not move the
  // estimate, and the walls cluster near the true ceiling by definition.
  const usdWeekly = median(costs);
  if (!(usdWeekly > 0)) return null;                 // all-zero observations describe nothing

  /**
   * Confidence from SPREAD, not from sample count alone. Observations of one real ceiling sit
   * close together; observations that disagree by an order of magnitude are not measuring the
   * same thing, however many of them there are. Relative range is the plainest expression of
   * that, and it is derived from the data rather than chosen to look reassuring.
   */
  const spread = (Math.max(...costs) - Math.min(...costs)) / usdWeekly;
  const tightness = Math.max(0, 1 - spread);
  // More observations of the same wall justify more trust, but cannot rescue a wide spread.
  const evidence = Math.min(1, costs.length / (MIN_OBSERVATIONS * 2));
  const confidence = Math.max(0, Math.min(1, tightness * (0.7 + 0.3 * evidence)));

  if (confidence < CONFIDENCE_THRESHOLD) return null;
  return { usdWeekly, confidence, samples: costs.length };
}
