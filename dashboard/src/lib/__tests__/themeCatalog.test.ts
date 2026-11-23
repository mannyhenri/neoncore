import { describe, it, expect } from 'vitest';
import { assetsFor, groupsOf, ASSET_GROUPS } from '../themeCatalog';
import { packFor, MAPS_BY_THEME, THEMES } from '../../world/theme';
import { SOUND_PACKS } from '../sound/sounds.generated';
import { costumesFor } from '../../world/bridge/rank';

describe('the pictures and sounds of a theme', () => {
  it.each(THEMES.map((t) => ({ t })))('$t: every asset once, a real path, the right kind, a fit; sheets name each of their sets', ({ t }) => {
    const all = assetsFor(t);
    expect(new Set(all.map((a) => a.path)).size).toBe(all.length);
    for (const a of all) {
      expect(a.path.startsWith('/'), a.path).toBe(true);
      expect(ASSET_GROUPS).toContain(a.group);
      if (a.kind === 'image') { expect(a.path, a.path).toMatch(/\.(png|jpe?g|gif|webp)$/); expect(a.fit).not.toBe('sound'); }
      else { expect(a.path).toMatch(/\.(mp3|wav|ogg)$/); expect(a.fit).toBe('sound'); }
      if (a.fit === 'sheet') { expect(a.grid, a.path).toBeDefined(); expect(a.grid!.sets).toHaveLength(a.grid!.rows); expect(a.grid!.cols).toBeGreaterThan(0); }
    }
  });

  it.each(THEMES.map((t) => ({ t })))('$t: nothing drawn is missing — every sprite, map, crew member and sound the app uses is listed', ({ t }) => {
    const paths = new Set(assetsFor(t).map((a) => a.path));
    const pack = packFor(t);
    for (const k of Object.values(pack.kit)) expect(paths.has(k.src), k.src).toBe(true);
    for (const c of Object.values(pack.crew.characters)) expect(paths.has(c.src), c.src).toBe(true);
    // The rank costumes are the theme's OWN (rank.tsx costumesFor): a theme pack's fallback to sci-fi sprites never lends them.
    for (const [name, s] of Object.entries(pack.decks.sheets)) if (s && !name.startsWith('captain-')) expect(paths.has(s.src), s.src).toBe(true);
    for (const s of Object.values(costumesFor(t))) if (s) expect(paths.has(s.src), s.src).toBe(true);
    for (const b of Object.values(pack.decks.backdrops)) if (b) expect(paths.has(b), b).toBe(true);
    for (const m of MAPS_BY_THEME[t]) expect(paths.has(m.plate.src), m.plate.src).toBe(true);
    for (const s of Object.values(SOUND_PACKS[t])) expect(paths.has(s.src), s.src).toBe(true);
  });

  it('the groups, in order: the captain first (with a uniform per rank in sci-fi), ambient motion only where it is drawn', () => {
    const sci = groupsOf(assetsFor('scifi'));
    const fan = groupsOf(assetsFor('fantasy'));
    expect(sci.map((g) => g.group)).toEqual([...ASSET_GROUPS]);
    expect(fan.map((g) => g.group)).toEqual(ASSET_GROUPS.filter((g) => g !== 'Ambient motion'));
    expect(sci[0].assets.map((a) => a.title)).toEqual(['The captain — his first uniform', "The captain — General's uniform", "The captain — Commander's uniform", "The captain — Admiral's uniform", "The captain — President's uniform"]);
    expect(fan[0].assets).toHaveLength(1);
    expect(sci.find((g) => g.group === 'World map')!.assets).toHaveLength(1);
    expect(sci.find((g) => g.group === 'Further maps')!.assets).toHaveLength(2);
  });
});
