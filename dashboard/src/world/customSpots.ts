/**
 * WHERE YOU PUT THEM. An agent can be dragged anywhere on the plate. The spot is remembered
 * in this browser, per plate, and is where that agent WORKS from then on — until it is sent
 * back (double-click) or the positions are reset. Purely a view preference.
 *
 * It does not stop an idle agent going to its bench: when the agent goes idle it walks to a
 * bench, and when it has work again it walks back to the spot you gave it. The one exception
 * is an agent you drag WHILE it is idle: it stays where you dropped it for as long as that
 * idle spell lasts. That is what `idle: true` on a stored spot records.
 */
import type { WorldPlate } from './sites';

export interface Spot { x: number; y: number }
/**
 * A dropped position. `idle`: it was dropped while the agent was idle, and that idle spell is not
 * over. `pod`: the district the agent was PLANNED for when it was dropped (spotHolds).
 */
export interface HeldSpot extends Spot { idle?: boolean; pod?: string }

/** How far from a district's centre, in map pixels, a spot still counts as in that district. */
export const DISTRICT_REACH_PX = 220;

/** The district a spot lies in: the nearest one within DISTRICT_REACH_PX, or undefined on open ground. */
export function spotDistrict(spot: Spot, plate: Pick<WorldPlate, 'districts' | 'width' | 'height'>): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const d of plate.districts) {
    if (d.x === undefined || d.y === undefined) continue;
    const dist = Math.hypot((spot.x - d.x) * plate.width, (spot.y - d.y) * plate.height);
    if (dist <= DISTRICT_REACH_PX && (!best || dist < best.d)) best = { id: d.id, d: dist };
  }
  return best?.id;
}

/**
 * Does a dragged spot still apply, now that the agent is planned for `plannedPod`? Only while the
 * plan it was dragged in holds. A pod holds four (zones.ts): once a project grows past that, some
 * of its agents are planned into a second district, and a spot dragged before then must not pin
 * them in the first — that piled Gridlight's eight cartridges into one district after every
 * restart while the second stood empty. A spot dropped before `pod` was recorded counts as dragged
 * in the district it lies in; one on open ground, or an agent with no district, always holds.
 * Never deleted: if the plan goes back, the spot applies again.
 */
export function spotHolds(held: HeldSpot, plannedPod: string | undefined, plate: Pick<WorldPlate, 'districts' | 'width' | 'height'>): boolean {
  if (!plannedPod) return true;
  const pod = held.pod ?? spotDistrict(held, plate);
  return pod === undefined || pod === plannedPod;
}

/**
 * STRANDED: a spot on open ground with no `pod` recorded, held by an agent whose PROJECT now has
 * a district. It was dropped while the project had none (a project past the map's districts,
 * before sectors gave every project one); the agent now has a place in its own project, and the
 * old spot must not keep it out on the road. A spot dropped on open ground while the project has
 * its district records that district (`pod`) and is not stranded; an agent of no project never is.
 */
export function spotStranded(held: HeldSpot, projectHasDistrict: boolean, plate: Pick<WorldPlate, 'districts' | 'width' | 'height'>): boolean {
  return projectHasDistrict && held.pod === undefined && spotDistrict(held, plate) === undefined;
}

const KEY = (plateId: string) => `neoncore.world.spots.${plateId}`;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2);

/** Keep a dropped position on the plate (fractions of the plate, at the figure's feet). */
export function clampSpot(spot: Spot): Spot {
  return { x: clamp(spot.x, 0.02, 0.98), y: clamp(spot.y, 0.12, 0.98) };
}

export function loadCustomSpots(plateId: string): Map<string, HeldSpot> {
  const out = new Map<string, HeldSpot>();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(plateId)) ?? '{}') as Record<string, Partial<HeldSpot>>;
    for (const [key, s] of Object.entries(raw)) {
      if (s && typeof s.x === 'number' && typeof s.y === 'number') {
        out.set(key, {
          ...clampSpot({ x: s.x, y: s.y }),
          ...(s.idle === true ? { idle: true } : {}),
          ...(typeof s.pod === 'string' && s.pod ? { pod: s.pod } : {}),
        });
      }
    }
  } catch {
    /* unreadable or blocked storage: nobody has been moved */
  }
  return out;
}

export function saveCustomSpots(plateId: string, spots: ReadonlyMap<string, HeldSpot>): void {
  try {
    if (spots.size === 0) localStorage.removeItem(KEY(plateId));
    else localStorage.setItem(KEY(plateId), JSON.stringify(Object.fromEntries(spots)));
  } catch {
    /* the positions just won't persist */
  }
}
