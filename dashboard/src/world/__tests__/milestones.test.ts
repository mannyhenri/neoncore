import { describe, it, expect } from 'vitest';
import { deadlineFor, pennantFrame, badgesFor, FEATURE_BADGES, GAUGE_STEPS, GAUGE_OVERDUE } from '../milestones';
import type { DatedFeature, BadgeFeature } from '../milestones';
import { PLATES } from '../sites';
import { KIT } from '../kit';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-19T12:00:00Z').getTime();
const feature = (over: Record<string, unknown> = {}) => ({
  projectId: 'p1', status: 'active' as const, origin: '' as const,
  createdAt: new Date(now - 10 * DAY).toISOString(), targetDate: new Date(now + 10 * DAY).toISOString(), ...over,
});
// A feature created `total` days before its date, with `left` days still to go.
const at = (left: number, total = 100) => feature({ createdAt: new Date(now - (total - left) * DAY).toISOString(), targetDate: new Date(now + left * DAY).toISOString() });

describe('deadline gauge', () => {
  it('drains through every level as the date comes closer, then goes into the red — and never climbs back', () => {
    const seen: string[] = [];
    let last = -1;
    for (let left = 100; left >= -5; left--) {
      const d = deadlineFor([at(left)], 'p1', now)!;
      expect(d.frames[0], `${left} days left`).toBeGreaterThanOrEqual(last);
      last = d.frames[0];
      const key = `${d.frames.join('+')}:${d.state}`;
      if (seen[seen.length - 1] !== key) seen.push(key);
      expect(d.daysLeft).toBe(left);
    }
    expect(seen).toEqual(['0:ok', '1:ok', '2:ok', '3:tight', '4+5:tight', '6+7:overdue']);
    // Every frame of the drawn gauge is used by exactly one level.
    expect([...GAUGE_STEPS, GAUGE_OVERDUE].flatMap((s) => s.frames)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let i = 0; i < 8; i++) expect(KIT[`gauge-${i}` as keyof typeof KIT], `gauge-${i}`).toBeTruthy();
  });

  it('reads the NEAREST open, dated, planned feature of that project — and nothing else', () => {
    const far = at(80), near = at(20);
    expect(deadlineFor([far, near], 'p1', now)!.daysLeft).toBe(20);
    // Not counted: another project's, a finished or paused one, an imported one, one with no date or a bad date.
    for (const other of [{ projectId: 'p2' }, { status: 'achieved' }, { status: 'paused' }, { origin: 'imported' }, { targetDate: '' }, { targetDate: undefined }, { targetDate: 'soon' }]) {
      expect(deadlineFor([far, { ...at(1), ...other } as DatedFeature], 'p1', now)!.daysLeft, JSON.stringify(other)).toBe(80);
    }
    expect(deadlineFor([], 'p1', now)).toBeNull();
    expect(deadlineFor([feature({ targetDate: '' })], 'p1', now)).toBeNull();
  });
});

describe('delivery', () => {
  it('the pennant climbs with the share of planned features delivered — for every count up to 8', () => {
    expect(pennantFrame(0, 0)).toBeNull();
    for (let total = 1; total <= 8; total++) {
      let last = -1;
      for (let done = 0; done <= total; done++) {
        const f = pennantFrame(done, total)!;
        expect(f).toBeGreaterThanOrEqual(last);
        last = f;
        if (done === 0) expect(f).toBe(0);
        if (done === total) expect(f, 'all delivered: flying at the top').toBe(3);
        if (done > 0 && done < total) expect([1, 2]).toContain(f);
      }
    }
    for (let i = 0; i < 4; i++) { expect(KIT[`pennant-${i}` as keyof typeof KIT]).toBeTruthy(); expect(KIT[`burst-${i}` as keyof typeof KIT]).toBeTruthy(); }
  });

  it('every step of the feature process earns one badge, in order — for every phase a feature can be in', () => {
    expect(FEATURE_BADGES.map((b) => b.step)).toEqual(['scoped', 'answered', 'planned', 'accepted', 'staffed', 'built', 'delivered']);
    const PHASES = ['scoping', 'clarifying', 'planning', 'proposed', 'staffing', 'running', 'paused', 'completed'] as const;
    const want: Record<(typeof PHASES)[number], number> = { scoping: 0, clarifying: 1, planning: 2, proposed: 3, staffing: 4, running: 5, paused: 5, completed: 6 };
    const goal = (over: Record<string, unknown>) => ({ projectId: 'p1', status: 'active', origin: '', updatedAt: '2026-11-19T10:00:00Z', doneAt: '', pilot: null, ...over }) as BadgeFeature;
    for (const phase of PHASES) expect(badgesFor([goal({ pilot: { phase } })], 'p1'), phase).toBe(want[phase]);
    // Delivered: all seven. Never started, cancelled, imported, or another project's: none.
    expect(badgesFor([goal({ status: 'achieved', doneAt: '2026-11-19T11:00:00Z', pilot: { phase: 'completed' } })], 'p1')).toBe(7);
    for (const none of [{ pilot: null }, { pilot: { phase: 'cancelled' } }, { origin: 'imported', status: 'achieved' }, { projectId: 'p2', pilot: { phase: 'running' } }]) {
      expect(badgesFor([goal(none)], 'p1'), JSON.stringify(none)).toBe(0);
    }
    expect(badgesFor([], 'p1')).toBe(0);
    // Each badge has drawn art, and no two steps share one.
    for (const b of FEATURE_BADGES) expect(KIT[b.sprite as keyof typeof KIT], b.sprite).toBeTruthy();
    expect(new Set(FEATURE_BADGES.map((b) => b.sprite)).size).toBe(FEATURE_BADGES.length);
  });

  it('the badges belong to the feature under way: they RESET when a new one starts, and stay full after a delivery until then', () => {
    const goal = (over: Record<string, unknown>) => ({ projectId: 'p1', status: 'active', origin: '', updatedAt: '2026-11-19T10:00:00Z', doneAt: '', pilot: null, ...over }) as BadgeFeature;
    const delivered = goal({ status: 'achieved', doneAt: '2026-11-19T09:00:00Z', pilot: { phase: 'completed' } });
    // The last feature was delivered and nothing new has started: the full row stays up.
    expect(badgesFor([delivered, goal({ pilot: null })], 'p1')).toBe(7);
    // A new feature starts: back to what THAT feature has earned.
    expect(badgesFor([delivered, goal({ pilot: { phase: 'scoping' } })], 'p1')).toBe(0);
    expect(badgesFor([delivered, goal({ pilot: { phase: 'proposed' } })], 'p1')).toBe(3);
    // Two under way: the one touched most recently is the one on the banner.
    expect(badgesFor([goal({ pilot: { phase: 'running' }, updatedAt: '2026-11-19T08:00:00Z' }), goal({ pilot: { phase: 'clarifying' }, updatedAt: '2026-11-19T12:00:00Z' })], 'p1')).toBe(1);
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: every project district has an anchor for its gauge, pennant and banner', ({ plate }) => {
    for (const d of plate.districts.filter((x) => plate.structures.some((st) => st.building && st.district === x.id))) {
      expect(d.x, `${d.id} has no anchor`).toBeGreaterThan(0);
    }
  });
});
