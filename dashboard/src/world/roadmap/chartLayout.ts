/**
 * WHERE THINGS SIT ON THE ROADMAP CHART — pure, so it is tested without a screen.
 *
 * The chart is a timeline: x is a date, a lane is an epic, a waypoint is a feature. Everything
 * here turns the server's chart (dates and states — lib/roadmap.ts) into positions, and a
 * position back into a date when a waypoint is dragged.
 */
import type { RoadmapChart, RoadmapFeature } from '../../types';

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A date as a fraction (0–1) of the chart's window; clamped, so nothing is drawn off the chart. */
export function xOf(date: string, range: RoadmapChart['range']): number {
  const from = ms(range.from);
  const span = ms(range.to) + DAY - from;
  return Math.min(1, Math.max(0, (ms(date) - from) / span));
}

/** The day under a point of the chart — what a dragged waypoint is dropped on. */
export function dateAt(x: number, range: RoadmapChart['range']): string {
  const from = ms(range.from);
  // The window is whole days, the last one included: each day owns an equal slice of the width.
  const count = Math.round((ms(range.to) - from) / DAY) + 1;
  const index = Math.min(count - 1, Math.max(0, Math.floor(x * count + 1e-9)));
  return iso(from + index * DAY);
}

export interface MonthColumn { key: string; label: string; year: number; from: number; to: number }
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** One column per month of the window, in order, covering it exactly. */
export function monthColumns(range: RoadmapChart['range']): MonthColumn[] {
  const out: MonthColumn[] = [];
  let [y, m] = range.from.split('-').map(Number);
  for (let guard = 0; guard < 240; guard++) {
    const first = iso(Date.UTC(y, m - 1, 1));
    if (first > range.to) break;
    const next = iso(Date.UTC(y, m, 1));
    out.push({ key: first.slice(0, 7), label: MONTHS[m - 1], year: y, from: xOf(first, range), to: next > range.to ? 1 : xOf(next, range) });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The day a feature sits at: its target, else the day it was delivered; null when it has neither. */
export function dayOf(f: Pick<RoadmapFeature, 'targetDate' | 'completedAt'>): string | null {
  return f.targetDate || (f.completedAt ? f.completedAt.slice(0, 10) : null);
}

export interface Placed { feature: RoadmapFeature; x: number; row: number }

/**
 * A lane's dated features, left to right, each on the first tag row where its name does not run
 * into the one before it. `tagWidth` is a name tag's width as a fraction of the chart.
 */
export function placeLane(features: readonly RoadmapFeature[], range: RoadmapChart['range'], tagWidth = 0.11): { placed: Placed[]; unscheduled: RoadmapFeature[]; rows: number } {
  const dated = features.filter((f) => dayOf(f) !== null).map((f) => ({ feature: f, x: xOf(dayOf(f)!, range) })).sort((a, b) => a.x - b.x);
  const lastOnRow: number[] = [];
  const placed = dated.map((p) => {
    let row = lastOnRow.findIndex((x) => p.x - x >= tagWidth);
    if (row < 0) row = lastOnRow.length;
    lastOnRow[row] = p.x;
    return { ...p, row };
  });
  return { placed, unscheduled: features.filter((f) => dayOf(f) === null), rows: Math.max(1, lastOnRow.length) };
}

/** What the vision panel reads: three shares of the planned features (0–100), and the counts behind them. */
export function visionGauges(chart: Pick<RoadmapChart, 'epics' | 'unassigned' | 'totals'>): { delivered: number; scheduled: number; onTrack: number; total: number } {
  const all = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned];
  const total = all.length;
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
  return {
    total,
    delivered: pct(chart.totals.delivered),
    // Has a place on the timeline: a date, or it is already delivered.
    scheduled: pct(all.filter((f) => f.state === 'delivered' || f.targetDate !== '').length),
    onTrack: pct(total - chart.totals.late),
  };
}

/** Why a feature cannot be started from the chart, in words; '' when it can. */
export function startBlock(f: RoadmapFeature, names: ReadonlyMap<string, string>): string {
  if (f.state === 'delivered') return 'Already delivered';
  if (f.state === 'under-way') return 'Already under way';
  if (f.blockedBy.length > 0) return `Waits on ${f.blockedBy.map((id) => names.get(id) ?? 'another feature').join(', ')}`;
  return '';
}
