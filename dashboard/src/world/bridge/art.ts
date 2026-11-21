/**
 * The deck figures and backdrops, as the theme this page was loaded with draws them (../theme.ts).
 * Everything that draws a deck imports from here, never from a generated registry directly.
 */
import { PACK } from '../theme';
import type { DeckSheet } from './bridge.generated';

export type { DeckSheet };
export type CaptainSheet = DeckSheet;
export const DECK_ART = PACK.decks;
/** The Projects bridge's own art, by its first names. */
export const BRIDGE: { captain: DeckSheet | null; deck: string | null } = { captain: DECK_ART.sheets.captain, deck: DECK_ART.backdrops.projects };
