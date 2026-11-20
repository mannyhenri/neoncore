import { describe, it, expect } from 'vitest';
import { CHARACTERS, assignCharacters } from '../sheets';
import { clampSpot, loadCustomSpots, saveCustomSpots } from '../customSpots';
import { PLATES } from '../sites';

/**
 * "We should always be using different characters."
 *
 * A character belongs to the AGENT, not to the engine: five Claude agents must not be five
 * copies of the same figure. Checked as a set over every crew size, and over a long random
 * run of arrivals and departures — not for one example crew.
 */
describe('who looks like whom', () => {
  it('there is a pool of drawn characters', () => {
    expect(CHARACTERS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(CHARACTERS).size).toBe(CHARACTERS.length);
  });

  it.each(Array.from({ length: 31 }, (_, n) => ({ n })))('a crew of $n: all different while the pool lasts, then as evenly spread as possible', ({ n }) => {
    const keys = Array.from({ length: n }, (_, i) => `m:repo-${i}`);
    const cast = assignCharacters(new Map(), keys, CHARACTERS);
    expect(cast.size).toBe(n);
    const uses = new Map<string, number>();
    for (const k of keys) {
      const c = cast.get(k)!;
      expect(CHARACTERS).toContain(c);
      uses.set(c, (uses.get(c) ?? 0) + 1);
    }
    if (n <= CHARACTERS.length) expect(uses.size, 'two agents share a character while unused ones remain').toBe(n);
    else expect(Math.max(...uses.values()) - Math.min(...CHARACTERS.map((c) => uses.get(c) ?? 0)), 'one character is over-used').toBeLessThanOrEqual(1);
  });

  it('an agent keeps its character while others come and go, and a newcomer takes the least-used one', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pool = Array.from({ length: 20 }, (_, i) => `m:r${i}`);
    let present: string[] = [];
    let cast = new Map<string, string>();
    for (let step = 0; step < 200; step++) {
      present = pool.filter((k) => (present.includes(k) ? rnd() > 0.15 : rnd() > 0.8));
      const next = assignCharacters(cast, present, CHARACTERS);
      expect(next.size).toBe(present.length);
      for (const k of present) if (cast.has(k)) expect(next.get(k), `${k} changed character`).toBe(cast.get(k));
      const stayed = present.filter((k) => cast.has(k));
      const uses = (c: string, among: string[]) => among.filter((k) => next.get(k) === c).length;
      const newcomers = present.filter((k) => !cast.has(k));
      if (newcomers.length === 1) {
        const least = Math.min(...CHARACTERS.map((c) => uses(c, stayed)));
        expect(uses(next.get(newcomers[0])!, stayed), 'the newcomer copied a common character').toBe(least);
      }
      cast = next;
    }
  });
});

describe('moving an agent by hand', () => {
  it('a dropped position is always kept on the plate', () => {
    for (const [x, y] of [[-1, -1], [0, 0], [0.5, 0.5], [1, 1], [9, 9], [0.5, -3], [NaN, 0.4]] as const) {
      const p = clampSpot({ x, y });
      expect(p.x).toBeGreaterThanOrEqual(0.02); expect(p.x).toBeLessThanOrEqual(0.98);
      expect(p.y).toBeGreaterThanOrEqual(0.12); expect(p.y).toBeLessThanOrEqual(0.98);
    }
    expect(clampSpot({ x: 0.4, y: 0.6 })).toEqual({ x: 0.4, y: 0.6 });
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: positions are remembered per plate, and bad stored data is ignored', ({ plate }) => {
    localStorage.clear();
    expect(loadCustomSpots(plate.id).size).toBe(0);
    saveCustomSpots(plate.id, new Map([['m:a', { x: 0.3, y: 0.5 }], ['m:b', { x: 5, y: 5, idle: true }]]));
    const back = loadCustomSpots(plate.id);
    expect(back.get('m:a')).toEqual({ x: 0.3, y: 0.5 });
    // "Dropped while idle" survives a reload, with the position still clamped to the plate.
    expect(back.get('m:b')).toEqual({ ...clampSpot({ x: 5, y: 5 }), idle: true });
    expect(loadCustomSpots('some-other-plate').size).toBe(0);
    localStorage.setItem(`neoncore.world.spots.${plate.id}`, '{not json');
    expect(loadCustomSpots(plate.id).size).toBe(0);
    saveCustomSpots(plate.id, new Map());
    expect(loadCustomSpots(plate.id).size).toBe(0);
  });
});
