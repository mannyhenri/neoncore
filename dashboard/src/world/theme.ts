/**
 * THEMES — the same data and the same screens, drawn and named for another setting.
 *
 * A theme is a PACK: a map, a scenery kit, the crew's sprite atlases, the deck figures and
 * backdrops, the roadmap's art, and a word list. Application code refers only to core concepts
 * (a building, a gate, a character id, a deck figure's look), never to "ship" or "castle"; a pack
 * supplies what those look like and what they are called. Switching themes changes nothing in
 * the data.
 *
 *   scifi    the base: an outpost, a ship's decks, a star chart
 *   fantasy  a village, a guild's rooms, a quest map — built by scripts/world/build_theme_pack.py
 *            from designs/fantasy/, on the same grids and under the same sprite names
 *
 * THE THEME IS READ ONCE, WHEN THE PAGE LOADS. Every registry below is then a plain constant, so
 * nothing in the scene has to re-render for a theme it was not built with; choosing another theme
 * stores the choice and reloads the page (chooseTheme). It is kept per browser, not in the data.
 * A sprite a pack does not draw falls back to the base, so a pack can never leave a hole.
 */
import { KIT as KIT_SCIFI } from './kit.generated';
import { KIT_FANTASY } from './kit.fantasy.generated';
import { CREW_ATLAS as CREW_SCIFI } from './crewAtlas.generated';
import { CREW_ATLAS_FANTASY } from './crewAtlas.fantasy.generated';
import { DECK_ART as DECKS_SCIFI } from './bridge/bridge.generated';
import type { DeckSheet } from './bridge/bridge.generated';
import { DECK_ART_FANTASY } from './bridge/bridge.fantasy.generated';
import { OUTPOST, VILLAGE, type WorldPlate } from './sites';

export const THEMES = ['scifi', 'fantasy'] as const;
export type ThemeId = (typeof THEMES)[number];
export const THEME_KEY = 'neoncore.theme';
export const THEME_LABEL: Record<ThemeId, string> = { scifi: 'Sci-fi — outpost and ship', fantasy: 'Fantasy — village and guild' };

/** What a stored value means. Anything that is not a known theme is the base. */
export function themeFrom(stored: unknown): ThemeId {
  return stored === 'fantasy' ? 'fantasy' : 'scifi';
}

function readTheme(): ThemeId {
  // No storage (the phone, a test, a locked-down browser) is simply the base theme.
  try { return themeFrom(globalThis.localStorage?.getItem(THEME_KEY)); } catch { return 'scifi'; }
}

/** The theme this page was loaded with. */
export const THEME: ThemeId = readTheme();

/** Store the choice and reload, so every screen is built with it. */
export function chooseTheme(theme: ThemeId): void {
  try { globalThis.localStorage?.setItem(THEME_KEY, theme); } catch { /* nothing to store it in */ }
  if (theme !== THEME) globalThis.location?.reload();
}

/** Every sprite name the base has, with where its picture is and how big: the same names in every theme. */
type Kit = Record<keyof typeof KIT_SCIFI, { readonly src: string; readonly w: number; readonly h: number }>;
type Crew = { cell: number; frames: number; rows: readonly string[]; characters: Record<string, { src: string; tops: Record<string, number> }> };
type Decks = { sheets: Record<string, DeckSheet | null>; backdrops: Record<string, string | null> };
export interface ThemePack { kit: Kit; crew: Crew; decks: Decks }

/** A theme's art. The base's sprites stand in for anything a pack has not drawn. */
export function packFor(theme: ThemeId): ThemePack {
  if (theme === 'fantasy') {
    return {
      kit: { ...KIT_SCIFI, ...KIT_FANTASY } as Kit,
      crew: CREW_ATLAS_FANTASY,
      decks: {
        sheets: { ...DECKS_SCIFI.sheets, ...Object.fromEntries(Object.entries(DECK_ART_FANTASY.sheets).filter(([, s]) => s !== null)) },
        backdrops: { ...Object.fromEntries(Object.keys(DECKS_SCIFI.backdrops).map((k) => [k, null])), ...DECK_ART_FANTASY.backdrops },
      },
    };
  }
  return { kit: KIT_SCIFI, crew: CREW_SCIFI, decks: DECKS_SCIFI };
}

/** The map each theme opens on: the same pods, buildings and work spots, in another place. */
export const PLATE_BY_THEME: Record<ThemeId, WorldPlate> = { scifi: OUTPOST, fantasy: VILLAGE };

export const PACK: ThemePack = packFor(THEME);
export const PLATE: WorldPlate = PLATE_BY_THEME[THEME];

/**
 * THE WORD LIST. Each game word, per theme. Core words (project, feature, epic, task) are the
 * product's and stay; these are the names the setting gives things.
 */
export const VOCAB_KEYS = ['bridge', 'engineDeck', 'cargoBay', 'powerCore', 'roadmap', 'destination', 'leg', 'waypoint', 'today', 'crewMember', 'dock'] as const;
export type VocabKey = (typeof VOCAB_KEYS)[number];
export const VOCAB: Record<ThemeId, Record<VocabKey, string>> = {
  scifi: {
    bridge: 'Bridge', engineDeck: 'Engine deck', cargoBay: 'Cargo bay', powerCore: 'Power core',
    roadmap: 'Star chart', destination: 'Destination', leg: 'Leg', waypoint: 'Waypoint', today: 'The ship today',
    crewMember: 'Crew member', dock: 'Landing pad',
  },
  fantasy: {
    bridge: 'Guild hall', engineDeck: 'Workshop', cargoBay: 'Storehouse', powerCore: 'Great crystal',
    roadmap: 'Quest map', destination: 'Journey’s end', leg: 'Quest line', waypoint: 'Milestone', today: 'The party today',
    crewMember: 'Party member', dock: 'Landing circle',
  },
};
/** A game word in the theme this page was loaded with. */
export const word = (key: VocabKey): string => VOCAB[THEME][key];
