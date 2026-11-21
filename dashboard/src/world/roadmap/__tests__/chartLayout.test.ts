/**
 * THE ROADMAP CHART PUTS EVERY FEATURE WHERE ITS DATE IS — and a drag puts the date where the
 * feature was dropped. Checked over whole windows, every day of them, not a sample.
 */
import { describe, it, expect } from 'vitest';
import { calendarYears, xOf, dateAt, monthColumns, placeLane, dayOf, visionGauges, startBlock } from '../chartLayout';
import type { RoadmapFeature } from '../../../types';

const RANGES = [
  { from: '2026-01-01', to: '2026-12-31' },
  { from: '2026-10-01', to: '2027-02-28' },
  { from: '2028-02-01', to: '2028-02-29' },   // a leap February on its own
];
const DAY = 86_400_000;
const days = (r: { from: string; to: string }) => {
  const out: string[] = [];
  for (let t = Date.parse(`${r.from}T00:00:00Z`); t <= Date.parse(`${r.to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const feature = (id: string, over: Partial<RoadmapFeature> = {}): RoadmapFeature => ({
  id, name: id, slug: id, state: 'planned', epicId: 'e', startDate: '', targetDate: '', completedAt: null, dependsOn: [], blockedBy: [], summary: '', ...over,
});

describe('roadmap chart layout', () => {
  it.each(RANGES)('$from → $to: every day has its own place, in order, and dropping on that place gives the day back', (range) => {
    const all = days(range);
    const xs = all.map((d) => xOf(d, range));
    expect(xs[0]).toBe(0);
    for (let i = 1; i < xs.length; i++) expect(xs[i], all[i]).toBeGreaterThan(xs[i - 1]);
    expect(xs[xs.length - 1]).toBeLessThan(1);
    for (const d of all) expect(dateAt(xOf(d, range), range), d).toBe(d);
    // Off either end is the nearest end, never a day outside the window.
    expect(dateAt(-0.3, range)).toBe(range.from);
    expect(dateAt(1.7, range)).toBe(range.to);
    expect(xOf('1999-01-01', range)).toBe(0);
    expect(xOf('2099-01-01', range)).toBe(1);
  });

  it.each(RANGES)('$from → $to: the month columns cover the window exactly, with no gap and no overlap', (range) => {
    const cols = monthColumns(range);
    expect(cols[0].from).toBe(0);
    expect(cols[cols.length - 1].to).toBe(1);
    for (let i = 1; i < cols.length; i++) expect(cols[i].from).toBeCloseTo(cols[i - 1].to, 10);
    expect(cols.map((c) => c.key)).toEqual([...new Set(days(range).map((d) => d.slice(0, 7)))]);
    // Every day falls in the column of its own month.
    for (const d of days(range)) {
      const x = xOf(d, range);
      const col = cols.find((c) => x >= c.from && x < c.to)!;
      expect(col.key, d).toBe(d.slice(0, 7));
    }
  });

  it('a lane shows every dated feature once, left to right, and no two name tags on one row collide', () => {
    const range = RANGES[0];
    const features = [
      feature('a', { targetDate: '2026-03-10' }), feature('b', { targetDate: '2026-03-14' }), feature('c', { targetDate: '2026-03-20' }),
      feature('d', { targetDate: '2026-08-01' }), feature('e'), feature('f', { state: 'delivered', completedAt: '2026-02-02T10:00:00Z' }),
      feature('g', { targetDate: '2026-03-12' }),
    ];
    const { placed, unscheduled, rows } = placeLane(features, range, 0.1);
    expect(placed.map((p) => p.feature.id)).toEqual(['f', 'a', 'g', 'b', 'c', 'd']);
    expect(unscheduled.map((f) => f.id)).toEqual(['e']);
    expect(placed.length + unscheduled.length).toBe(features.length);
    for (let r = 0; r < rows; r++) {
      const onRow = placed.filter((p) => p.row === r);
      for (let i = 1; i < onRow.length; i++) expect(onRow[i].x - onRow[i - 1].x, `row ${r}`).toBeGreaterThanOrEqual(0.1);
    }
    expect(rows).toBe(Math.max(...placed.map((p) => p.row)) + 1);
    expect(placeLane([], range).rows).toBe(1);
    expect(dayOf(feature('x'))).toBeNull();
  });

  it('the vision gauges are shares of the planned features, and an empty roadmap reads zero', () => {
    const chart = (features: RoadmapFeature[]) => ({
      epics: [{ id: 'e', name: 'E', outcome: '', icon: '', position: 0, features: features.slice(0, 2), progress: { done: 0, total: 0 }, nextUp: null }],
      unassigned: features.slice(2),
      totals: Object.fromEntries(['planned', 'under-way', 'delivered', 'late'].map((s) => [s, features.filter((f) => f.state === s).length])) as never,
    });
    expect(visionGauges(chart([]))).toEqual({ total: 0, delivered: 0, scheduled: 0, onTrack: 0 });
    const four = [
      feature('a', { state: 'delivered' }), feature('b', { state: 'late', targetDate: '2026-01-01' }),
      feature('c', { state: 'planned', targetDate: '2026-09-01' }), feature('d'),
    ];
    expect(visionGauges(chart(four))).toEqual({ total: 4, delivered: 25, scheduled: 75, onTrack: 75 });
  });

  it('Start says why it cannot start a feature — for every state and a blocked one', () => {
    const names = new Map([['a', 'Access control']]);
    expect(startBlock(feature('x'), names)).toBe('');
    expect(startBlock(feature('x', { state: 'late' }), names)).toBe('');
    expect(startBlock(feature('x', { state: 'delivered' }), names)).toMatch(/delivered/i);
    expect(startBlock(feature('x', { state: 'under-way' }), names)).toMatch(/under way/i);
    expect(startBlock(feature('x', { blockedBy: ['a'] }), names)).toBe('Waits on Access control');
    expect(startBlock(feature('x', { blockedBy: ['zz'] }), names)).toMatch(/another feature/);
  });

  it('the chart shows whole calendar years around the plan', () => {
    expect(calendarYears({ from: '2026-11-01', to: '2026-12-31' })).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(calendarYears({ from: '2026-10-01', to: '2027-01-31' })).toEqual({ from: '2026-01-01', to: '2027-12-31' });
    expect(monthColumns(calendarYears({ from: '2026-03-01', to: '2026-03-31' }))).toHaveLength(12);
    expect(monthColumns(calendarYears({ from: '2026-10-01', to: '2027-01-31' }))).toHaveLength(24);
  });
});
