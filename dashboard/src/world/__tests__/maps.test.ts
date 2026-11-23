import { describe, it, expect } from 'vitest';
import { PLATES } from '../sites';
import { MAPS_BY_THEME, PLATE_BY_THEME, THEMES, resolveMap } from '../theme';
import { planSectors, sectorSize } from '../zones';

/**
 * THE NEW MAPS. Set-based over every theme and every map of it: each theme has its home map and
 * two more (an interior, and the isles with six pods); every one is a real plate the other plate
 * tests check; the extra ones are locked behind the outfit's unlock.
 */
const ALL = THEMES.flatMap((theme) => MAPS_BY_THEME[theme].map((map) => ({ name: `${theme}/${map.id}`, theme, map })));
const pods = (plate: (typeof PLATES)[number]) => plate.districts.filter((d) => d.x !== undefined).map((d) => d.id);

describe('the maps of each theme', () => {
  it('every theme has three maps: its home, an interior, and the isles', () => {
    expect(ALL).toHaveLength(6);
    for (const theme of THEMES) {
      const maps = MAPS_BY_THEME[theme];
      expect(maps.map((m) => m.kind), theme).toEqual(['home', 'interior', 'isles']);
      expect(maps[0].plate, theme).toBe(PLATE_BY_THEME[theme]);
      expect(maps[0].requires, `${theme}: the home map is always open`).toBeUndefined();
      for (const m of maps.slice(1)) expect(m.requires, `${theme}/${m.id}`).toBe('frontier');
    }
    expect(new Set(ALL.map((a) => a.map.id)).size, 'map ids are unique').toBe(6);
    expect(new Set(ALL.map((a) => a.map.plate.src)).size, 'every map has its own terrain').toBe(6);
    expect([...ALL.map((a) => a.map.plate.id)].sort()).toEqual([...PLATES.map((p) => p.id)].sort());
  });

  it.each(ALL)('$name: the right number of pods, each with a building, a gate, two spots and its props', ({ map }) => {
    const mine = pods(map.plate);
    expect(mine).toHaveLength(map.kind === 'isles' ? 6 : 4);
    expect(sectorSize(map.plate)).toBe(mine.length);
    for (const d of mine) {
      expect(map.plate.structures.filter((s) => s.building && s.district === d).length, `${d} buildings`).toBeGreaterThanOrEqual(1);
      expect(map.plate.structures.filter((s) => s.gate && s.district === d).length, `${d} gate`).toBe(1);
      expect(map.plate.sites.filter((s) => s.district === d).length, `${d} spots`).toBeGreaterThanOrEqual(2);
      expect(map.plate.props[d], `${d} props`).toBeDefined();
      // Every spot of a pod is beside one of that pod's buildings.
      for (const s of map.plate.sites.filter((x) => x.district === d)) {
        expect(map.plate.structures.find((st) => st.id === s.at)?.district, `${s.id} is at a building of ${d}`).toBe(d);
      }
    }
    // Nothing is left at the placeholder position.
    for (const thing of [...map.plate.structures, ...map.plate.sites, ...map.plate.meet, ...map.plate.rest]) {
      expect(thing.x + thing.y, `${thing.id} has no position`).toBeGreaterThan(0.1);
    }
  });

  it('six projects fit one sector of the isles; the other maps start a second sector at five', () => {
    const projects = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: '#fff', primaryRepo: `/r/${i}`, cartridges: [], createdAt: `2026-01-0${i + 1}` }));
    for (const { map, name } of ALL) {
      expect(planSectors(projects, map.plate).length, name).toBe(map.kind === 'isles' ? 1 : 2);
    }
  });
});

describe('which map is on screen (resolveMap)', () => {
  const maps = MAPS_BY_THEME.scifi;
  const open = new Set(['frontier']);
  const none = new Set<string>();
  const cases = [
    { name: 'nothing stored → home', pick: null, unlocked: none, want: 'base' },
    { name: 'an unknown id → home', pick: 'nowhere', unlocked: open, want: 'base' },
    { name: 'a stored map that is unlocked → that map', pick: 'sky', unlocked: open, want: 'sky' },
    { name: 'the other unlocked map → that map', pick: 'station', unlocked: open, want: 'station' },
    { name: 'a stored map that is locked → home: a locked map is never shown', pick: 'sky', unlocked: none, want: 'base' },
    { name: 'a stored locked interior → home', pick: 'station', unlocked: none, want: 'base' },
    { name: 'home stored → home', pick: 'base', unlocked: open, want: 'base' },
  ];
  it.each(cases)('$name', ({ pick, unlocked, want }) => {
    expect(resolveMap(maps, pick, unlocked).id).toBe(want);
  });
});
