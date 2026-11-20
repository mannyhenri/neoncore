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
export interface Spot { x: number; y: number }
/** A dropped position. `idle`: it was dropped while the agent was idle, and that idle spell is not over. */
export interface HeldSpot extends Spot { idle?: boolean }

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
      if (s && typeof s.x === 'number' && typeof s.y === 'number') out.set(key, s.idle === true ? { ...clampSpot({ x: s.x, y: s.y }), idle: true } : clampSpot({ x: s.x, y: s.y }));
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
