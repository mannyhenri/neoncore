/**
 * Token burn as a TIME SERIES — the reporting page behind the header badge.
 *
 * The badge answers "how fast right now". This answers "how did that change, and when" —
 * which is the question you ask after changing your approach, or after hitting a plan
 * ceiling and needing to know what the spend actually looked like at that moment.
 *
 * Bucketing happens HERE, in one pure function, rather than in SQL. The math has three
 * invariants that a GROUP BY expression cannot be tested for in isolation: the buckets must
 * tile the window with no gap and no overlap, the series must sum to exactly the unbucketed
 * total, and an empty stretch must appear as a zero rather than a missing point (a chart that
 * closes gaps by joining neighbours draws a quiet weekend as a straight busy line).
 *
 * Everything is UTC. A local-time bucket boundary would shift under the reader and make two
 * charts of the same window disagree.
 */
import { rowCostUsd } from './pricing.js';
import type { UsageSample } from './burn-rate.js';

export type Bucket = 'hour' | 'day' | 'week';

/** THE SET. Every granularity the page offers. */
export const BUCKETS: Bucket[] = ['hour', 'day', 'week'];

export const BUCKET_MS: Record<Bucket, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/**
 * The start of the bucket containing `ms`.
 *
 * Weeks floor to MONDAY, not to "seven days back from now" — a rolling seven-day offset makes
 * every reload re-cut the buckets, so the same week changes shape between two views of the
 * same data.
 */
export function bucketStart(ms: number, bucket: Bucket): number {
  const d = new Date(ms);
  if (bucket === 'hour') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  }
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === 'day') return dayStart;
  const daysSinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return dayStart - daysSinceMonday * 86_400_000;
}

export interface SeriesPoint {
  /** ISO timestamp of the bucket START. */
  t: string;
  /** All four token classes, summed. Same definition as the header badge. */
  tokens: number;
  costUsd: number;
  /** Turns recorded in this bucket — how much evidence the point rests on. */
  samples: number;
}

/**
 * Dense series over [fromMs, toMs]. Buckets with no activity are present with zeros.
 *
 * The range is inclusive of the bucket CONTAINING `fromMs`, so a window that starts mid-hour
 * still shows that hour rather than silently dropping the partial one at the left edge.
 */
export function buildSeries(
  rows: UsageSample[],
  bucket: Bucket,
  fromMs: number,
  toMs: number,
): SeriesPoint[] {
  const step = BUCKET_MS[bucket];
  const first = bucketStart(fromMs, bucket);

  const acc = new Map<number, { tokens: number; costUsd: number; samples: number }>();
  for (let t = first; t <= toMs; t += step) acc.set(t, { tokens: 0, costUsd: 0, samples: 0 });

  for (const r of rows) {
    const ms = Date.parse(r.recorded_at);
    if (!Number.isFinite(ms)) continue; // a row with an unparseable stamp is dropped, not NaN'd
    const key = bucketStart(ms, bucket);
    const cell = acc.get(key);
    if (!cell) continue; // outside the requested window
    cell.tokens +=
      (r.input_tokens || 0) + (r.output_tokens || 0) +
      (r.cache_read_tokens || 0) + (r.cache_creation_tokens || 0);
    cell.costUsd += rowCostUsd(r);
    cell.samples += 1;
  }

  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t: new Date(t).toISOString(), ...v }));
}
