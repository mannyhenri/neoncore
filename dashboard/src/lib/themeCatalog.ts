/**
 * EVERY PICTURE AND SOUND OF A THEME, grouped as the theme creator shows them (Settings → Themes).
 * Read from the registries the app draws with, so a new sprite, map or sound is listed here without
 * anyone remembering to add it. Each says how a replacement is fitted to it (fitImage.ts): a sprite
 * sheet cell by cell, a backdrop filling the frame, a sprite inside it.
 */
import type { ThemeId } from '../world/theme';
import { packFor, MAPS_BY_THEME } from '../world/theme';
import { costumesFor, RANKS } from '../world/bridge/rank';
import { ROADMAP_ART } from '../world/roadmap/roadmapArt.generated';
import { AMBIENT_GROUND, AMBIENT_PROPS } from '../world/ambient.generated';
import { SOUND_PACKS } from './sound/sounds.generated';
import type { DeckSheet } from '../world/bridge/bridge.generated';

export const ASSET_GROUPS = ['Captain', 'Bridge crew', 'Bridge decks', 'Crew on the map', 'World map', 'Further maps', 'Map props', 'Ambient motion', 'Roadmap', 'Sounds'] as const;
export type AssetGroup = (typeof ASSET_GROUPS)[number];
export type AssetFit = 'sheet' | 'cover' | 'contain' | 'sound';
export interface ThemeAsset {
  path: string;
  title: string;
  group: AssetGroup;
  kind: 'image' | 'sound';
  note: string;
  fit: AssetFit;
  /** A sprite sheet: its grid, and the name of each row — a SET, the frames of one animation. Frame size when known. */
  grid?: { cols: number; rows: number; frameW?: number; frameH?: number; sets: string[] };
}

const deckGrid = (s: DeckSheet) => {
  const sets = Object.entries(s.rows).sort((a, b) => a[1].row - b[1].row).map(([name]) => name);
  return { cols: Math.max(...Object.values(s.rows).map((r) => r.frames)), rows: sets.length, frameW: s.frameW, frameH: s.frameH, sets };
};
const FIGURE: Record<string, string> = { engineer: 'The engineer — the Flows deck', quartermaster: 'The quartermaster — the Tasks deck', core: 'The power core — the Tokens deck' };
const DECK: Record<string, string> = { projects: 'The bridge — Projects', workflows: 'The engine deck — Flows', tokens: 'The power core — Tokens', tasks: 'The cargo bay — Tasks' };

export function assetsFor(base: ThemeId): ThemeAsset[] {
  const pack = packFor(base);
  const out: ThemeAsset[] = [];
  const seen = new Set<string>();
  const add = (a: ThemeAsset) => { if (!a.path || seen.has(a.path)) return; seen.add(a.path); out.push(a); };

  // The captain: his first uniform, and one per rank.
  const captain = pack.decks.sheets.captain;
  if (captain) add({ path: captain.src, title: 'The captain — his first uniform', group: 'Captain', kind: 'image', fit: 'sheet', grid: deckGrid(captain), note: 'His first uniform. Each row is one SET: the frames of one animation.' });
  const costumes = costumesFor(base);
  for (const r of RANKS.slice(1)) {
    const s = costumes[r.id];
    if (s) add({ path: s.src, title: `The captain — ${r.title}'s uniform`, group: 'Captain', kind: 'image', fit: 'sheet', grid: deckGrid(s), note: 'Worn from this rank on (an epic delivered on time per rank).' });
  }
  for (const [name, s] of Object.entries(pack.decks.sheets)) {
    if (!s || name === 'captain' || name.startsWith('captain-')) continue;
    add({ path: s.src, title: FIGURE[name] ?? name, group: 'Bridge crew', kind: 'image', fit: 'sheet', grid: deckGrid(s), note: 'Each row is one set: the frames of one animation.' });
  }
  for (const [view, src] of Object.entries(pack.decks.backdrops)) {
    if (src) add({ path: src, title: DECK[view] ?? view, group: 'Bridge decks', kind: 'image', fit: 'cover', note: 'The room behind the deck: no interface, no characters.' });
  }
  for (const [name, c] of Object.entries(pack.crew.characters)) {
    add({ path: c.src, title: `${name[0].toUpperCase()}${name.slice(1)}`, group: 'Crew on the map', kind: 'image', fit: 'sheet',
      grid: { cols: pack.crew.frames, rows: pack.crew.rows.length, frameW: pack.crew.cell, frameH: pack.crew.cell, sets: [...pack.crew.rows] }, note: 'An agent on the map. Each row is one set.' });
  }
  MAPS_BY_THEME[base].forEach((m, i) => add({ path: m.plate.src, title: m.name, group: i === 0 ? 'World map' : 'Further maps', kind: 'image', fit: 'cover',
    note: i === 0 ? 'The map the world opens on. Everything on it is placed by fractions of it: keep its proportions.' : 'Opened by what the outfit delivers. Keep its proportions.' }));
  for (const [name, k] of Object.entries(pack.kit)) add({ path: k.src, title: name, group: 'Map props', kind: 'image', fit: 'contain', note: `${k.w} × ${k.h} as drawn.` });
  if (base === 'scifi') {
    for (const [name, a] of [...Object.entries(AMBIENT_GROUND), ...Object.entries(AMBIENT_PROPS)]) {
      add({ path: a.src, title: name, group: 'Ambient motion', kind: 'image', fit: 'sheet', grid: { cols: a.frames, rows: 1, sets: ['loop'] }, note: `${a.frames} frames side by side, played at ${a.fps} a second.` });
    }
  }
  const rm = ROADMAP_ART[base] ?? ROADMAP_ART.scifi;
  if (rm.deck) add({ path: rm.deck, title: 'The roadmap deck', group: 'Roadmap', kind: 'image', fit: 'cover', note: 'Behind the roadmap.' });
  if (rm.destination) add({ path: rm.destination.src, title: 'The destination', group: 'Roadmap', kind: 'image', fit: 'sheet', grid: { cols: rm.destination.frames, rows: 1, frameW: rm.destination.frameW, frameH: rm.destination.frameH, sets: ['turn'] }, note: 'Where the route goes: the vision.' });
  if (rm.today) add({ path: rm.today.src, title: 'Today — the ship', group: 'Roadmap', kind: 'image', fit: 'sheet', grid: { cols: rm.today.frames, rows: 1, frameW: rm.today.frameW, frameH: rm.today.frameH, sets: ['fly'] }, note: 'Where the project is now.' });
  for (const ic of rm.icons) add({ path: ic.src, title: `Epic glyph — ${ic.id}`, group: 'Roadmap', kind: 'image', fit: 'contain', note: 'Offered for an epic.' });
  for (const [state, src] of Object.entries(rm.waypoints ?? {})) add({ path: src, title: `Waypoint — ${state}`, group: 'Roadmap', kind: 'image', fit: 'contain', note: 'A feature on the timeline.' });
  for (const [id, s] of Object.entries(SOUND_PACKS[base] ?? SOUND_PACKS.scifi)) add({ path: s.src, title: id, group: 'Sounds', kind: 'sound', fit: 'sound', note: `${s.seconds.toFixed(2)} s` });
  return out;
}

export function groupsOf(assets: readonly ThemeAsset[]): { group: AssetGroup; assets: ThemeAsset[] }[] {
  return ASSET_GROUPS.map((group) => ({ group, assets: assets.filter((a) => a.group === group) })).filter((g) => g.assets.length > 0);
}
