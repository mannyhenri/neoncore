import { describe, it, expect } from 'vitest';
import { deadlineFor, pennantFrame, rewardsFor, REWARD_STEPS, GAUGE_STEPS, GAUGE_OVERDUE } from '../milestones';
import type { DatedFeature } from '../milestones';
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

  it('the commons earns each fixture once, in order, and keeps it', () => {
    let last: string[] = [];
    for (let n = 0; n <= 60; n++) {
      const got = rewardsFor(n);
      expect(got.slice(0, last.length), `${n} delivered must not lose a reward`).toEqual(last);
      last = got;
      expect(got).toEqual(REWARD_STEPS.filter((s) => n >= s.at).map((s) => s.reward));
    }
    expect(rewardsFor(0)).toEqual([]);
    expect(last).toHaveLength(REWARD_STEPS.length);
    expect(new Set(REWARD_STEPS.map((s) => s.reward)).size).toBe(REWARD_STEPS.length);
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: every reward has drawn art and its own place on the map', ({ plate }) => {
    for (const s of REWARD_STEPS) {
      const spot = plate.rewards.find((r) => r.sprite === s.reward);
      expect(spot, `${s.reward} has no place on ${plate.id}`).toBeTruthy();
      expect(KIT[s.reward as keyof typeof KIT], `${s.reward} has no art`).toBeTruthy();
    }
    expect(new Set(plate.rewards.map((r) => r.id)).size).toBe(plate.rewards.length);
    // A project district needs somewhere for its gauge and its pennant.
    for (const d of plate.districts.filter((x) => plate.structures.some((st) => st.building && st.district === x.id))) {
      expect(d.x, `${d.id} has no anchor`).toBeGreaterThan(0);
    }
  });
});
