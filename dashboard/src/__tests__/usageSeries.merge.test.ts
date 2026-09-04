import { describe, it, expect } from 'vitest';
import { mergeSeries, POINT_SUMMED_KEYS, type UsageSeries, type SeriesPoint } from '../lib/usageSeries';
import type { ServerAnswer } from '../lib/serverAnswer';

const from = (label: string, result: UsageSeries | null): ServerAnswer<UsageSeries> =>
  ({ label, result });

/**
 * The reporting chart across two machines.
 *
 * The failure this guards is subtle and would look like a finding rather than a bug: each
 * server computes its own window from its own clock, so the two arrays can differ in length
 * and in where they start. Merging by INDEX shifts one machine's history against the other's
 * and draws a spend change on a day nothing changed — on the page whose entire purpose is
 * "did my spend move, and when".
 *
 * SET-BASED over misalignment SHAPES rather than one hand-built pair, because there are
 * several ways two servers disagree about a window and an example test fixes on whichever one
 * the author happened to imagine.
 */

const H = 3_600_000;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function pt(ms: number, tokens: number): SeriesPoint {
  return { t: iso(ms), tokens, costUsd: tokens / 1000, samples: 1 };
}

function srv(points: SeriesPoint[]): UsageSeries {
  return {
    bucket: 'hour', days: 7, series: points,
    total: {
      tokens: points.reduce((n, p) => n + p.tokens, 0),
      costUsd: points.reduce((n, p) => n + p.costUsd, 0),
      samples: points.length,
    },
    byCartridge: [],
  };
}

/** THE SET: the ways two servers' windows can fail to line up. */
const SHAPES: { label: string; a: SeriesPoint[]; b: SeriesPoint[]; overlapHours: number[] }[] = [
  {
    label: 'identical windows',
    a: [pt(T0, 10), pt(T0 + H, 20), pt(T0 + 2 * H, 30)],
    b: [pt(T0, 1), pt(T0 + H, 2), pt(T0 + 2 * H, 3)],
    overlapHours: [0, 1, 2],
  },
  {
    label: 'one server started later — shorter array, same buckets',
    a: [pt(T0, 10), pt(T0 + H, 20), pt(T0 + 2 * H, 30)],
    b: [pt(T0 + 2 * H, 3)],
    overlapHours: [2],
  },
  {
    label: 'one server reaches further back',
    a: [pt(T0 - H, 5), pt(T0, 10)],
    b: [pt(T0, 1)],
    overlapHours: [0],
  },
  {
    label: 'no overlap at all — disjoint uptime',
    a: [pt(T0, 10)],
    b: [pt(T0 + 5 * H, 7)],
    overlapHours: [],
  },
];

describe('federated usage series', () => {
  it('aligns by timestamp, never by index', () => {
    const failures: string[] = [];

    for (const shape of SHAPES) {
      const merged = mergeSeries([from('a', srv(shape.a)), from('b', srv(shape.b))], 'hour', 7);

      // Every timestamp either server reported must survive, exactly once.
      const want = new Set([...shape.a, ...shape.b].map((p) => p.t));
      const got = merged.series.map((p) => p.t);
      if (new Set(got).size !== got.length) failures.push(`${shape.label}: duplicate buckets in the merge`);
      if (got.length !== want.size) failures.push(`${shape.label}: ${got.length} buckets, expected ${want.size}`);

      // Where both servers reported the SAME hour, the value must be the sum of the two.
      for (const h of shape.overlapHours) {
        const t = iso(T0 + h * H);
        const point = merged.series.find((p) => p.t === t);
        const av = shape.a.find((p) => p.t === t)?.tokens ?? 0;
        const bv = shape.b.find((p) => p.t === t)?.tokens ?? 0;
        if (point?.tokens !== av + bv) {
          failures.push(`${shape.label}: bucket ${t} is ${point?.tokens}, expected ${av + bv}`);
        }
      }

      // Ascending, always — a chart plots in array order.
      const stamps = merged.series.map((p) => Date.parse(p.t));
      if (stamps.some((v, i) => i > 0 && v <= stamps[i - 1])) {
        failures.push(`${shape.label}: merged series is not strictly ascending`);
      }
    }

    assert(failures);
  });

  it('conserves every summed field across the merge', () => {
    const failures: string[] = [];
    for (const shape of SHAPES) {
      const merged = mergeSeries([from('a', srv(shape.a)), from('b', srv(shape.b))], 'hour', 7);
      for (const k of POINT_SUMMED_KEYS) {
        const want = [...shape.a, ...shape.b].reduce((n, p) => n + p[k], 0);
        const got = merged.series.reduce((n, p) => n + p[k], 0);
        if (Math.abs(got - want) > 1e-9) failures.push(`${shape.label}: ${k} merged to ${got}, inputs hold ${want}`);
      }
    }
    assert(failures);
  });

  it('a server that fails or answers with old code contributes nothing but is counted', () => {
    // `[]` is what a server running pre-usage-series code returns: truthy, not an error.
    const merged = mergeSeries(
      [from('this', srv([pt(T0, 10)])), from('down.local', null), from('old.local', [] as unknown as UsageSeries)],
      'hour', 7,
    );
    expect(merged.series).toHaveLength(1);
    expect(merged.total.tokens).toBe(10);
    expect(merged.serversReporting).toBe(1);
    expect(merged.serversAsked).toBe(3);
    for (const p of merged.series) expect(Number.isFinite(p.tokens)).toBe(true);
    // The two failures are distinguished, not lumped into one "partial".
    expect(merged.problems).toEqual([
      { label: 'down.local', reason: 'unreachable' },
      { label: 'old.local', reason: 'outdated' },
    ]);
  });

  it('is empty, not NaN, when every server fails', () => {
    const merged = mergeSeries([from('a', null), from('b', null)], 'day', 30);
    expect(merged.series).toEqual([]);
    expect(merged.total.tokens).toBe(0);
    expect(Number.isFinite(merged.total.costUsd)).toBe(true);
    expect(merged.days).toBe(30);
  });
});

function assert(failures: string[]) {
  expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
}
