/**
 * A THEME IS A PACK OF ART AND WORDS OVER THE SAME DATA — switching it changes nothing else.
 *
 * The design document's rule: the application refers only to core concepts, a workspace picks one
 * theme, and "the fantasy theme is the test that the pack format is complete". So this checks the
 * pack against the base, as sets: every sprite, every character and cycle, every deck figure and
 * look, every word. A pack that is missing one is a screen with a hole in it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, themeFrom, VOCAB, VOCAB_KEYS, packFor, PLATE_BY_THEME } from '../theme';
import { KIT as BASE_KIT } from '../kit.generated';
import { CREW_ATLAS as BASE_CREW } from '../crewAtlas.generated';
import { DECK_ART as BASE_DECKS } from '../bridge/bridge.generated';
import { ROADMAP_ART } from '../roadmap/roadmapArt.generated';
import { PLATES } from '../sites';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public');
const onDisk = (src: string) => existsSync(resolve(PUBLIC, src.replace(/^\//, '')));

describe('themes', () => {
  it('there are two themes, sci-fi is the default, and anything unreadable is sci-fi', () => {
    expect([...THEMES]).toEqual(['scifi', 'fantasy']);
    for (const v of [null, undefined, '', 'SCIFI', 'steampunk', '{}', 'scifi']) expect(themeFrom(v), String(v)).toBe('scifi');
    expect(themeFrom('fantasy')).toBe('fantasy');
  });

  it.each(THEMES)('%s: draws every scenery sprite the base draws, from its own files', (theme) => {
    const { kit } = packFor(theme);
    expect(Object.keys(BASE_KIT).filter((name) => !(name in kit)), 'sprites this theme cannot draw').toEqual([]);
    const missing = Object.entries(kit).filter(([, s]) => !onDisk(s.src)).map(([name]) => name);
    expect(missing).toEqual([]);
    for (const [name, s] of Object.entries(kit)) { expect(s.w, name).toBeGreaterThan(0); expect(s.h, name).toBeGreaterThan(0); }
    // A pack's sprites are its OWN: everything it has a sheet for comes from its folder.
    if (theme !== 'scifi') {
      const own = Object.values(kit).filter((s) => s.src.startsWith(`/world/${theme}/`)).length;
      expect(own, 'sprites drawn for this theme').toBeGreaterThanOrEqual(60);
    }
  });

  it.each(THEMES)('%s: has the same characters as the base, each with every cycle', (theme) => {
    const { crew } = packFor(theme);
    expect(Object.keys(crew.characters).sort()).toEqual(Object.keys(BASE_CREW.characters).sort());
    expect([...crew.rows]).toEqual([...BASE_CREW.rows]);
    expect(crew.cell).toBe(BASE_CREW.cell);
    for (const [id, c] of Object.entries(crew.characters)) {
      expect(onDisk(c.src), `${theme}/${id}`).toBe(true);
      expect(Object.keys(c.tops).sort(), `${theme}/${id} cycles`).toEqual([...BASE_CREW.rows].sort());
      if (theme !== 'scifi') expect(c.src.startsWith(`/world/${theme}/`), `${id} is not drawn for ${theme}`).toBe(true);
    }
  });

  it.each(THEMES)('%s: every deck figure has every look the base has', (theme) => {
    const { decks } = packFor(theme);
    expect(Object.keys(decks.sheets).sort()).toEqual(Object.keys(BASE_DECKS.sheets).sort());
    for (const [name, base] of Object.entries(BASE_DECKS.sheets)) {
      const mine = decks.sheets[name];
      expect(mine, `${theme}/${name}`).not.toBeNull();
      expect(onDisk(mine!.src)).toBe(true);
      expect(Object.keys(mine!.rows).sort(), `${theme}/${name} looks`).toEqual(Object.keys(base!.rows).sort());
    }
    // A backdrop may be missing (the deck then shows its panels on the page colour) but never points at a file that is not there.
    expect(Object.keys(decks.backdrops).sort()).toEqual(Object.keys(BASE_DECKS.backdrops).sort());
    for (const [view, src] of Object.entries(decks.backdrops)) if (src) expect(onDisk(src), `${theme}/${view} backdrop`).toBe(true);
  });

  it.each(THEMES)('%s: has its own map, with every structure sprite in its kit, and the roadmap art', (theme) => {
    const plate = PLATE_BY_THEME[theme];
    expect(PLATES).toContain(plate);
    expect(onDisk(plate.src)).toBe(true);
    const { kit } = packFor(theme);
    expect(plate.structures.map((s) => s.sprite).filter((sprite) => !(sprite in kit))).toEqual([]);
    const art = ROADMAP_ART[theme];
    expect(art, `${theme} has no roadmap art`).toBeDefined();
    for (const src of [art.deck, art.destination?.src, art.today?.src, ...art.icons.map((i) => i.src), ...Object.values(art.waypoints ?? {})]) {
      expect(src, `${theme} roadmap art`).toBeTruthy();
      expect(onDisk(src as string), src as string).toBe(true);
    }
    expect(art.icons.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(art.waypoints ?? {}).sort()).toEqual(['delivered', 'late', 'planned', 'under-way']);
  });

  it('the two maps are different places, and each has the same pods, the same buildings and the same work spots by name', () => {
    const [base, other] = [PLATE_BY_THEME.scifi, PLATE_BY_THEME.fantasy];
    expect(base.id).not.toBe(other.id);
    expect(base.src).not.toBe(other.src);
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
    expect(ids(other.districts)).toEqual(ids(base.districts));
    expect(ids(other.structures)).toEqual(ids(base.structures));
    expect(ids(other.sites)).toEqual(ids(base.sites));
    expect(ids(other.meet)).toEqual(ids(base.meet));
    // Same roles: a building is a building, a gate a gate, the pad the pad — only where they stand differs.
    const role = (s: (typeof base.structures)[number]) => `${s.id}|${s.district}|${Boolean(s.building)}|${Boolean(s.gate)}|${Boolean(s.flat)}|${s.when ?? ''}|${s.on ?? ''}|${s.sprite}`;
    expect(other.structures.map(role).sort()).toEqual(base.structures.map(role).sort());
    const work = (s: (typeof base.sites)[number]) => `${s.id}|${s.at ?? ''}|${s.district ?? ''}|${s.work}|${s.faces}`;
    expect(other.sites.map(work).sort()).toEqual(base.sites.map(work).sort());
  });

  it('every word has a name in every theme — and the themes do not share the game words', () => {
    for (const theme of THEMES) {
      expect(Object.keys(VOCAB[theme]).sort(), theme).toEqual([...VOCAB_KEYS].sort());
      for (const key of VOCAB_KEYS) expect(VOCAB[theme][key].trim(), `${theme}.${key}`).not.toBe('');
    }
    const same = VOCAB_KEYS.filter((k) => VOCAB.scifi[k] === VOCAB.fantasy[k]);
    expect(same, 'words that are the same in both themes').toEqual([]);
  });
});
