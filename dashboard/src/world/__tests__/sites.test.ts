import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PLATES, placeCrew, assignSlots } from '../sites';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Set-based over every plate and every crew size: nobody is ever drawn off the plate or on top of someone else. */
describe('world plates and placement', () => {
  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: image exists, sites are on the plate and distinct', ({ plate }) => {
    expect(existsSync(resolve(HERE, '../../../public', plate.src.replace(/^\//, ''))), `${plate.src} is missing from public/`).toBe(true);
    expect(plate.width / plate.height).toBeGreaterThan(1);
    expect(plate.sites.length).toBeGreaterThanOrEqual(8);
    expect(new Set(plate.sites.map((s) => s.id)).size).toBe(plate.sites.length);
    for (const s of plate.sites) {
      expect(s.x, s.id).toBeGreaterThan(0.03); expect(s.x, s.id).toBeLessThan(0.97);
      expect(s.y, s.id).toBeGreaterThan(0.2); expect(s.y, s.id).toBeLessThan(0.95);
    }
  });

  it.each(PLATES.flatMap((plate) => [0, 1, plate.sites.length, plate.sites.length + 1, plate.sites.length * 3, 60].map((n) => ({ name: `${plate.id} × ${n}`, plate, n }))))(
    '$name crew: everyone placed, on the plate, no two in the same spot',
    ({ plate, n }) => {
      const keys = Array.from({ length: n }, (_, i) => `m:repo-${String(i).padStart(2, '0')}`);
      const placed = placeCrew(keys, plate);
      expect(placed.size).toBe(n);
      const spots = new Set<string>();
      for (const k of keys) {
        const p = placed.get(k)!;
        expect(p, k).toBeDefined();
        expect(p.x).toBeGreaterThanOrEqual(0.02); expect(p.x).toBeLessThanOrEqual(0.98);
        expect(p.y).toBeGreaterThanOrEqual(0.15); expect(p.y).toBeLessThanOrEqual(0.98);
        expect(plate.sites.some((s) => s.id === p.siteId)).toBe(true);
        spots.add(`${p.x.toFixed(4)},${p.y.toFixed(4)}`);
      }
      expect(spots.size, 'two crew members share a spot').toBe(n);
    },
  );

  it('placement is stable: the same keys always land on the same spots', () => {
    const keys = ['m:a', 'm:b', 'm:c'];
    expect([...placeCrew(keys, PLATES[0])]).toEqual([...placeCrew(keys, PLATES[0])]);
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: has an entry point on the plate for agents walking in', ({ plate }) => {
    expect(plate.entry.x).toBeGreaterThan(0); expect(plate.entry.x).toBeLessThan(1);
    expect(plate.entry.y).toBeGreaterThan(0); expect(plate.entry.y).toBeLessThan(1);
  });

  /**
   * SITES ARE STICKY. An agent keeps its site for as long as it is on site, whoever else
   * arrives or leaves — otherwise one agent joining makes the whole crew walk to new spots.
   * Checked over a long random sequence of arrivals and departures, not one example.
   */
  it('an agent keeps its slot while others come and go; newcomers take the lowest free slot', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pool = Array.from({ length: 30 }, (_, i) => `m:r${i}`);
    let present: string[] = [];
    let slots = new Map<string, number>();
    for (let step = 0; step < 300; step++) {
      present = pool.filter((k) => (present.includes(k) ? rnd() > 0.15 : rnd() > 0.8));
      const next = assignSlots(slots, present);
      expect(next.size).toBe(present.length);
      expect(new Set(next.values()).size, 'two agents share a slot').toBe(present.length);
      const used = new Set<number>();
      for (const k of present) {
        if (slots.has(k)) { expect(next.get(k), `${k} was moved`).toBe(slots.get(k)); used.add(slots.get(k)!); }
      }
      // Newcomers fill the lowest slots nobody who stayed is using.
      const fresh = present.filter((k) => !slots.has(k)).map((k) => next.get(k)!).sort((a, b) => a - b);
      const free: number[] = [];
      for (let i = 0; free.length < fresh.length; i++) if (!used.has(i)) free.push(i);
      expect(fresh).toEqual(free);
      slots = next;
    }
  });

  /**
   * "What happens if I have a dozen agents running?" — every site has to be far enough from
   * every other that two figures with their panels do not sit on top of each other, and the
   * plate has to seat a dozen without anyone doubling up. Set-based over every PAIR of sites.
   */
  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: seats at least a dozen, and no two sites crowd each other', ({ plate }) => {
    expect(plate.sites.length).toBeGreaterThanOrEqual(12);
    const tooClose: string[] = [];
    for (let i = 0; i < plate.sites.length; i++) {
      for (let j = i + 1; j < plate.sites.length; j++) {
        const a = plate.sites[i];
        const b = plate.sites[j];
        // plate.spacing is the room one figure and its panel need on this plate.
        const gap = Math.hypot((a.x - b.x) / plate.spacing.x, (a.y - b.y) / plate.spacing.y);
        if (gap < 0.9) tooClose.push(`${a.id}/${b.id} (${gap.toFixed(2)})`);
      }
    }
    expect(tooClose).toEqual([]);
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: no benches and no seats — an idle agent stays at its building', ({ plate }) => {
    expect(plate.structures.filter((st) => st.sprite === 'bench' || /bench/.test(st.id)).map((st) => st.id)).toEqual([]);
    expect(plate.rest.map((r) => r.id)).toEqual([]);
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: every district has somewhere to work, and every placed thing names a real district', ({ plate }) => {
    const ids = plate.districts.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const thing of [...plate.sites, ...plate.rest, ...plate.structures]) {
      if (thing.district !== undefined) expect(ids, `${thing.id} is in an unknown district`).toContain(thing.district);
    }
    // The four project districts each seat at least two agents and hold at least one building.
    for (const d of ['nw', 'ne', 'sw', 'se']) {
      expect(ids).toContain(d);
      expect(plate.sites.filter((s) => s.district === d).length, `${d} sites`).toBeGreaterThanOrEqual(2);
      expect(plate.structures.filter((s) => s.district === d).length, `${d} buildings`).toBeGreaterThanOrEqual(1);
    }
    expect(plate.structures.filter((s) => s.sprite === 'pad').length, 'one landing pad — this machine (servers are not linked)').toBe(1);
    expect(plate.figureScale).toBeGreaterThan(0.3);
  });
});

