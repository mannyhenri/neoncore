/**
 * WHERE YOU PUT THEM. An agent can be dragged anywhere on the plate; the spot is remembered
 * in this browser, per plate, until the agent is sent back to its site (double-click) or the
 * positions are reset. Purely a view preference — nothing about the agent changes.
 */
export interface Spot { x: number; y: number }

const KEY = (plateId: string) => `neoncore.world.spots.${plateId}`;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2);

/** Keep a dropped position on the plate (fractions of the plate, at the figure's feet). */
export function clampSpot(spot: Spot): Spot {
  return { x: clamp(spot.x, 0.02, 0.98), y: clamp(spot.y, 0.12, 0.98) };
}

export function loadCustomSpots(plateId: string): Map<string, Spot> {
  const out = new Map<string, Spot>();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(plateId)) ?? '{}') as Record<string, Partial<Spot>>;
    for (const [key, s] of Object.entries(raw)) {
      if (s && typeof s.x === 'number' && typeof s.y === 'number') out.set(key, clampSpot({ x: s.x, y: s.y }));
    }
  } catch {
    /* unreadable or blocked storage: nobody has been moved */
  }
  return out;
}

export function saveCustomSpots(plateId: string, spots: ReadonlyMap<string, Spot>): void {
  try {
    if (spots.size === 0) localStorage.removeItem(KEY(plateId));
    else localStorage.setItem(KEY(plateId), JSON.stringify(Object.fromEntries(spots)));
  } catch {
    /* the positions just won't persist */
  }
}
