/**
 * THE CREW'S ARTWORK — drawn sprite sheets, one per CHARACTER.
 *
 * "We should always be using different characters": a character belongs to an agent, not to
 * an engine. Five Claude agents are five different people; the engine is the coloured dot on
 * the overhead panel. `assignCharacters` hands them out so that nobody shares a character
 * while unused ones remain, and so an agent keeps its character for as long as it is on site.
 *
 * A sheet is one image in `dashboard/public/world/crew/`: a grid of equal cells, one ROW per
 * animation and one COLUMN per frame, the character facing RIGHT, transparent background.
 * The atlases and `crewAtlas.generated.ts` are written by `scripts/world/build_crew_sheets.py`
 * from the artwork in `designs/`.
 *
 * There is no fallback figure: an unknown character draws nothing.
 */
import { ANIMATION_NAMES } from './anim';
import type { AnimationName } from './anim';
import { CREW_ATLAS } from './crewAtlas.generated';

export interface CrewSheet {
  /** Served from dashboard/public, e.g. '/world/crew/mechanic.png'. */
  src: string;
  /** Size of one cell in the image, in pixels. */
  frameW: number;
  frameH: number;
  /** `top` = how far down its cell (0–1) the figure starts in that cycle. */
  rows: Partial<Record<AnimationName, { row: number; frames: number; top: number }>> & Record<'idle', { row: number; frames: number; top: number }>;
}

export type CharacterId = keyof typeof CREW_ATLAS.characters;

/** Every drawn character, in the order they are handed out. */
export const CHARACTERS = Object.keys(CREW_ATLAS.characters) as CharacterId[];

export const CREW_SHEETS: Record<string, CrewSheet> = Object.fromEntries(
  CHARACTERS.map((id) => {
    const { src, tops } = CREW_ATLAS.characters[id];
    const rows = Object.fromEntries(
      // Only the cycles this atlas actually has: a missing one (anim.ts OPTIONAL_ANIMATIONS) has no row.
      ANIMATION_NAMES.filter((name) => (CREW_ATLAS.rows as readonly string[]).includes(name))
        .map((name) => [name, { row: (CREW_ATLAS.rows as readonly string[]).indexOf(name), frames: CREW_ATLAS.frames, top: (tops as Record<string, number>)[name] }]),
    ) as CrewSheet['rows'];
    return [id, { src, frameW: CREW_ATLAS.cell, frameH: CREW_ATLAS.cell, rows }];
  }),
);

export function sheetFor(character: string): CrewSheet | null {
  return CREW_SHEETS[character] ?? null;
}

/**
 * Who looks like whom. Agents already on site keep their character; each newcomer takes the
 * character the fewest agents are using (first in pool order on a tie). So a crew no larger
 * than the pool is all different, and a larger one repeats characters as evenly as possible.
 */
export function assignCharacters(
  prev: ReadonlyMap<string, string>,
  keys: readonly string[],
  pool: readonly string[],
): Map<string, string> {
  const next = new Map<string, string>();
  const uses = new Map<string, number>(pool.map((c) => [c, 0]));
  for (const key of keys) {
    const had = prev.get(key);
    if (had !== undefined && uses.has(had)) { next.set(key, had); uses.set(had, uses.get(had)! + 1); }
  }
  if (pool.length === 0) return next;
  for (const key of keys) {
    if (next.has(key)) continue;
    let pick = pool[0];
    for (const c of pool) if (uses.get(c)! < uses.get(pick)!) pick = c;
    next.set(key, pick);
    uses.set(pick, uses.get(pick)! + 1);
  }
  return next;
}
