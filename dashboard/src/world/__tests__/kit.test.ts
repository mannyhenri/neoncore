import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { KIT } from '../kit.generated';
import { PLATES } from '../sites';
import { crateSpriteFor, CRATE_STEPS, cellSpriteFor } from '../kit';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '../../../public');

/**
 * THE SCENERY IS A KIT. The plate is bare terrain and every structure is a placed sprite, so
 * a building can stand for a repo, the shuttle can come and go with its machine, and crates
 * can stack up with the queue. Set-based over every sprite in the kit and every structure on
 * every plate: nothing placed that does not exist, nothing placed off the plate.
 */
describe('the scenery kit', () => {
  const names = Object.keys(KIT) as (keyof typeof KIT)[];

  it('has the pieces the scene is built from', () => {
    // Animation frames come in fours: a shuttle taking off, its dust, a gate opening.
    for (const set of ['shuttle', 'dust', 'flame', 'gate']) {
      for (let i = 0; i < 4; i++) expect(names, `${set}-${i}`).toContain(`${set}-${i}`);
      const sizes = new Set([0, 1, 2, 3].map((i) => `${KIT[`${set}-${i}` as keyof typeof KIT].w}x${KIT[`${set}-${i}` as keyof typeof KIT].h}`));
      expect(sizes.size, `${set} frames must share one box or the animation jitters`).toBe(1);
    }
    for (const needed of ['holo-table', 'bench', 'heater', 'banner', 'signpost', 'fog-pylon', 'greenhouse', 'habitat', 'generator', 'gate', 'shuttle', 'pad', 'planter', 'tripod', 'water-station', 'crate-1', 'crate-2', 'crate-3', 'crate-pile', 'marker-red', 'cell-full', 'cell-half', 'cell-low']) {
      expect(names, needed).toContain(needed);
    }
  });

  it.each(names.map((name) => ({ name })))('$name: the image exists, is transparent, and is the size the registry says', ({ name }) => {
    const sprite = KIT[name];
    const file = resolve(PUBLIC, sprite.src.replace(/^\//, ''));
    expect(existsSync(file), `${sprite.src} is missing`).toBe(true);
    const png = readFileSync(file);
    expect(png.readUInt32BE(16)).toBe(sprite.w);
    expect(png.readUInt32BE(20)).toBe(sprite.h);
    expect(png[25], 'needs an alpha channel').toBe(6);
  });

  it('every image in the kit folder is registered — no stray art', () => {
    const files = readdirSync(resolve(PUBLIC, 'world/kit')).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')).sort();
    expect(files).toEqual([...names].sort());
  });

  it.each(PLATES.flatMap((p) => p.structures.map((s) => ({ name: `${p.id}/${s.id}`, s }))))('$name is a kit sprite placed on the plate', ({ s }) => {
    expect(names).toContain(s.sprite);
    expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(1);
    expect(s.y).toBeGreaterThan(0.1); expect(s.y).toBeLessThanOrEqual(1);
    expect(s.w).toBeGreaterThan(0.02); expect(s.w).toBeLessThan(0.4);
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: structure ids are unique, and the shuttle stands on a pad and comes and goes', ({ plate }) => {
    expect(new Set(plate.structures.map((s) => s.id)).size).toBe(plate.structures.length);
    const shuttles = plate.structures.filter((s) => s.sprite.startsWith('shuttle'));
    expect(shuttles.length).toBeGreaterThanOrEqual(1);
    for (const sh of shuttles) expect(sh.when, 'a shuttle that never leaves is scenery').toBe('in-service');
    expect(plate.structures.some((s) => s.sprite === 'pad' && s.flat)).toBe(true);
  });
});

describe('queue crates and energy cells', () => {
  it('nothing queued draws nothing; every count from 1 up draws the right stack', () => {
    expect(crateSpriteFor(0)).toBeNull();
    expect(crateSpriteFor(-2)).toBeNull();
    const seen = new Set<string>();
    for (let n = 1; n <= 12; n++) {
      const sprite = crateSpriteFor(n)!;
      expect(Object.keys(KIT), `${n} queued`).toContain(sprite);
      seen.add(sprite);
    }
    expect(crateSpriteFor(1)).toBe('crate-1');
    expect(crateSpriteFor(2)).toBe('crate-2');
    expect(crateSpriteFor(3)).toBe('crate-3');
    expect(crateSpriteFor(4)).toBe('crate-pile');
    expect(crateSpriteFor(40)).toBe('crate-pile');
    expect([...seen].sort()).toEqual([...CRATE_STEPS].sort());
  });

  it('the energy cell matches the burn share across the whole range', () => {
    expect(cellSpriteFor(1)).toBe('cell-full');
    expect(cellSpriteFor(0.7)).toBe('cell-full');
    expect(cellSpriteFor(0.5)).toBe('cell-half');
    expect(cellSpriteFor(0.2)).toBe('cell-low');
    expect(cellSpriteFor(0)).toBe('cell-low');
    for (let s = 0; s <= 1.0001; s += 0.05) expect(Object.keys(KIT)).toContain(cellSpriteFor(s));
  });
});
