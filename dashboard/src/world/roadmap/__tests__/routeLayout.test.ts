import { describe, it, expect } from 'vitest';
import type { RoadmapEpic, RoadmapFeature, RoadmapFeatureState } from '../../../types';
import { ROUTE, STAGE_COLOUR, STAGE_LABEL, currentStop, epicStage, routeLayout, type EpicStage } from '../routeLayout';

const feature = (state: RoadmapFeatureState): RoadmapFeature => ({ id: Math.random().toString(36), name: 'F', slug: 'f', state, epicId: 'e', startDate: '', targetDate: '', completedAt: null, dependsOn: [], blockedBy: [], summary: '' });
const epic = (states: RoadmapFeatureState[], over: Partial<RoadmapEpic> = {}): RoadmapEpic => ({
  id: 'e', name: 'E', outcome: '', icon: '', position: 0, features: states.map(feature), nextUp: null,
  progress: { done: states.filter((s) => s === 'delivered').length, total: states.length }, ...over,
});
const STAGES: EpicStage[] = ['commended', 'delivered', 'late', 'under-way', 'blocked', 'planned'];

describe('where an epic stands on the route', () => {
  const cases: [string, RoadmapEpic, EpicStage][] = [
    ['no features', epic([]), 'planned'],
    ['nothing started', epic(['planned', 'planned']), 'planned'],
    ['one under way', epic(['planned', 'under-way']), 'under-way'],
    ['one delivered, rest planned', epic(['delivered', 'planned']), 'under-way'],
    ['a late feature', epic(['delivered', 'late', 'under-way']), 'late'],
    ['the epic itself is late', epic(['planned'], { late: true }), 'late'],
    ['waiting on another epic', epic(['planned'], { blockedBy: ['x'] }), 'blocked'],
    ['waiting AND late: late is what needs you', epic(['planned'], { blockedBy: ['x'], late: true }), 'late'],
    ['all delivered (an older server: no date fields)', epic(['delivered', 'delivered']), 'delivered'],
    ['all delivered, after its date', epic(['delivered'], { deliveredAt: '2026-11-13T10:00:00Z', onTime: false }), 'delivered'],
    ['all delivered on time', epic(['delivered'], { deliveredAt: '2026-11-13T10:00:00Z', onTime: true }), 'commended'],
  ];
  it.each(cases.map(([name, e, want]) => ({ name, e, want })))('$name → $want', ({ e, want }) => expect(epicStage(e)).toBe(want));
  it('every stage has a word and a colour of its own', () => {
    expect(Object.keys(STAGE_LABEL).sort()).toEqual([...STAGES].sort());
    expect(new Set(Object.values(STAGE_COLOUR)).size).toBe(STAGES.length);
    expect(new Set(Object.values(STAGE_LABEL)).size).toBe(STAGES.length);
  });
});

describe('the route\'s layout', () => {
  /** Every plan from 0 to 20 epics, for every stage the first undelivered epic can be in, in three box sizes. */
  const plans = Array.from({ length: 21 }, (_, n) => n).flatMap((n) => Array.from({ length: n + 1 }, (_, doneCount) => ({ n, doneCount })))
    .flatMap(({ n, doneCount }) => (doneCount < n ? (['late', 'under-way', 'blocked', 'planned'] as EpicStage[]) : (['planned'] as EpicStage[])).map((cur) => ({ n, doneCount, cur })));
  const boxes = [{ w: 700, h: 300 }, { w: 1300, h: 380 }, { w: 2400, h: 520 }];

  it(`holds for all ${plans.length * boxes.length} plans × boxes: every epic a stop, in order, on the canvas, labels clear of each other, one leg into each`, () => {
    for (const { n, doneCount, cur } of plans) for (const { w, h } of boxes) {
      const stages: EpicStage[] = Array.from({ length: n }, (_, i) => (i < doneCount ? (i % 2 ? 'delivered' : 'commended') : i === doneCount ? cur : 'planned'));
      const r = routeLayout(stages, w, h);
      const tag = `${n} epics, ${doneCount} done, ${cur}, ${w}×${h}`;
      expect(r.stops, tag).toHaveLength(n);
      expect(r.legs, tag).toHaveLength(n + 1);
      expect(r.width, tag).toBeGreaterThanOrEqual(w);
      const xs = [r.launch.x, ...r.stops.map((s) => s.x), r.destination.x];
      for (let i = 1; i < xs.length; i++) expect(xs[i], `${tag}: left to right`).toBeGreaterThan(xs[i - 1]);
      for (const s of r.stops) {
        // The node and its label (above or below it) are inside the canvas.
        expect(s.x - ROUTE.label / 2, tag).toBeGreaterThanOrEqual(0);
        expect(s.x + ROUTE.label / 2, tag).toBeLessThanOrEqual(r.width - ROUTE.right * 0.5);
        expect(s.y - ROUTE.node / 2, tag).toBeGreaterThan(0);
        expect(s.y + ROUTE.node / 2, tag).toBeLessThan(h);
      }
      // Neighbours are on opposite sides; two labels on the SAME side are at least a label apart.
      r.stops.forEach((s, i) => {
        if (i > 0) expect(s.side, tag).not.toBe(r.stops[i - 1].side);
        if (i > 1) expect(s.x - r.stops[i - 2].x, `${tag}: labels`).toBeGreaterThanOrEqual(ROUTE.label);
        if (i > 0) expect(s.x - r.stops[i - 1].x, `${tag}: nodes`).toBeGreaterThan(ROUTE.node);
      });
      // The legs: travelled behind the ship, one being flown, the rest ahead — in that order.
      const at = currentStop(stages);
      expect(at, tag).toBe(doneCount);
      expect(r.legs.map((l) => l.state), tag).toEqual(Array.from({ length: n + 1 }, (_, i) => (i < at ? 'travelled' : i === at ? 'flying' : 'ahead')));
      for (const l of r.legs) expect(l.d, tag).toMatch(/^M [\d.]+ [\d.]+ C /);
      // The ship: at the launch with no plan, at the destination when all is delivered, at its stop once started, on the way otherwise.
      if (n === 0) expect(r.ship, tag).toEqual(r.launch);
      else if (doneCount === n) expect(r.ship, tag).toEqual(r.destination);
      else if (cur === 'under-way' || cur === 'late') expect(r.ship, tag).toEqual({ x: r.stops[at].x, y: r.stops[at].y });
      else { expect(r.ship.x, tag).toBeLessThan(r.stops[at].x); expect(r.ship.x, tag).toBeGreaterThan(at === 0 ? r.launch.x : r.stops[at - 1].x); }
    }
  // 2583 layouts: ~3.5 s alone, ~9 s under the full suite's load — past vitest's 5 s default.
  }, 30_000);

  it('a plan too long for the box makes the route wider, never tighter', () => {
    expect(routeLayout(Array(3).fill('planned'), 1300, 380).width).toBe(1300);
    const long = routeLayout(Array(20).fill('planned'), 1300, 380);
    expect(long.width).toBe(ROUTE.left + ROUTE.right + 21 * ROUTE.minStep);
    expect(long.stops[1].x - long.stops[0].x).toBeCloseTo(ROUTE.minStep, 5);
  });
});
