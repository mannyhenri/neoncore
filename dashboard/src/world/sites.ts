/**
 * WHERE THE CREW STANDS — the scene's background plates and the work sites on them.
 *
 * A plate is one painted background. A site is a spot on it where an agent can stand, given
 * as a fraction of the plate (0–1, measured at the avatar's FEET), so the crew stays glued
 * to the artwork at any window size.
 */
import type { WorkPosture } from './anim';
import type { KitName } from './kit';

export interface WorldSite {
  id: string;
  /** Which district of the map this spot is in. */
  district?: string;
  /** The building (a structure id) this spot is beside: where agents of that building's repo work. */
  at?: string;
  label: string;
  x: number;
  y: number;
  /** How work is done here: standing at something, or down on the floor beside it. */
  work: WorkPosture;
  /** Which way the thing being worked on is: 1 = to the right of the spot, -1 = to the left. */
  faces: 1 | -1;
}

/**
 * A piece of scenery placed on the plate: a building, a machine, the shuttle. `x`/`y` are
 * where its BASE sits (centre-bottom, fractions of the plate) and `w` its width as a fraction
 * of the plate's width — so everything scales with the terrain.
 */
export interface WorldStructure {
  id: string;
  district?: string;
  /** A building can stand for one of a project's repos. */
  building?: boolean;
  /** The gate into a district: it opens while the district's project has a feature under way. */
  gate?: boolean;
  /** A landing pad: where its machine's agents walk in from, and go back to when they leave. */
  door?: { x: number; y: number };
  /** A shuttle: the pad (a structure id) it stands on. */
  on?: string;
  sprite: KitName;
  x: number;
  y: number;
  w: number;
  /** Lies on the ground (a landing pad): always drawn under figures and other structures. */
  flat?: boolean;
  /** Only present while this is true. 'in-service' = at least one machine in the fleet is up. */
  when?: 'in-service';
}

export interface WorldPlate {
  id: string;
  /** Served from dashboard/public. */
  src: string;
  width: number;
  height: number;
  /** Where an agent that has just arrived walks in from (fractions of the plate, at the feet). */
  entry: { x: number; y: number };
  /**
   * How big a figure is on this plate, relative to the first outpost plate (1 = that size).
   * The shared map shows about four times the land, so everything on it is about half size.
   */
  figureScale: number;
  /** The room one figure and its panel need, as fractions of the plate — the spacing rule for sites. */
  spacing: { x: number; y: number };
  /** The parts of the map: a district per project, the commons, the landing field. */
  /** `x`,`y`: where the district's name plate goes (below its clearing). */
  districts: { id: string; label: string; x?: number; y?: number }[];
  /** Around the commons table: where the participants of a confer gather. */
  meet: WorldSite[];
  structures: WorldStructure[];
  sites: WorldSite[];
  /** Where idle agents go and sit. They stay there — idle agents do not wander. */
  rest: WorldSite[];
}

/** Positions below are read off the 1344 × 752 map image, in its pixels. */
const MAP_W = 1344;
const MAP_H = 752;
const px = (x: number, y: number) => ({ x: x / MAP_W, y: y / MAP_H });

/**
 * THE SHARED MAP. One base for everything: four districts (one per project) around a central
 * commons, a landing field on the east side, a pond to the south. Bare terrain; every
 * building is a sprite from the kit.
 *
 *   north-west  greenhouse district        north-east  the gated district (cliffs + gate)
 *   south-west  works district             south-east  survey district
 *   commons     the plaza: meeting table, benches — where idle agents sit
 *   field       landing pads and the shuttle
 *
 * (Still called OUTPOST in code: it is the plate the scene opens on.)
 */
export const OUTPOST: WorldPlate = {
  id: 'base',
  src: '/world/terrain.jpg',
  width: MAP_W,
  height: MAP_H,
  // Beside the shuttle on the first landing pad: new agents arrive by ship.
  entry: px(1180, 300),
  figureScale: 0.55,
  spacing: { x: 0.09, y: 0.1 },
  // In the order projects claim them (zones.ts): the two-building districts first.
  districts: [
    { id: 'nw', label: 'Greenhouse district', ...px(300, 296) },
    { id: 'sw', label: 'Works district', ...px(250, 552) },
    { id: 'se', label: 'Survey district', ...px(905, 552) },
    { id: 'ne', label: 'Gated district', ...px(900, 306) },
    { id: 'commons', label: 'Commons' },
    { id: 'field', label: 'Landing field' },
  ],
  structures: [
    { id: 'greenhouse', district: 'nw', sprite: 'greenhouse', building: true, ...px(250, 238), w: 0.12 },
    { id: 'planter', district: 'nw', sprite: 'planter', building: true, ...px(385, 252), w: 0.065 },
    { id: 'habitat', district: 'ne', sprite: 'habitat', building: true, ...px(862, 218), w: 0.1 },
    { id: 'dish', district: 'ne', sprite: 'dish', ...px(955, 200), w: 0.03 },
    // One gate per district, across the path that leads into it.
    { id: 'gate-ne', district: 'ne', gate: true, sprite: 'gate-0', ...px(818, 280), w: 0.075 },
    { id: 'gate-nw', district: 'nw', gate: true, sprite: 'gate-0', ...px(398, 282), w: 0.05 },
    { id: 'gate-sw', district: 'sw', gate: true, sprite: 'gate-0', ...px(428, 428), w: 0.05 },
    { id: 'gate-se', district: 'se', gate: true, sprite: 'gate-0', ...px(742, 420), w: 0.05 },
    { id: 'generator', district: 'sw', sprite: 'generator', building: true, ...px(205, 492), w: 0.072 },
    { id: 'workshop', district: 'sw', sprite: 'workshop', building: true, ...px(318, 468), w: 0.095 },
    { id: 'module', district: 'se', sprite: 'module', building: true, ...px(855, 482), w: 0.085 },
    { id: 'tripod', district: 'se', sprite: 'tripod', building: true, ...px(968, 470), w: 0.05 },
    { id: 'water-station', sprite: 'water-station', ...px(505, 590), w: 0.042 },
    { id: 'holo-table', district: 'commons', sprite: 'holo-table', ...px(602, 366), w: 0.075 },
    { id: 'bench-west', district: 'commons', sprite: 'bench', ...px(452, 330), w: 0.06 },
    { id: 'bench-east', district: 'commons', sprite: 'bench', ...px(770, 342), w: 0.06 },
    { id: 'heater', district: 'commons', sprite: 'heater', ...px(690, 350), w: 0.024 },
    { id: 'banner', district: 'commons', sprite: 'banner', ...px(528, 330), w: 0.024 },
    { id: 'pad-north', district: 'field', sprite: 'pad', ...px(1235, 300), w: 0.115, flat: true, door: px(1180, 300) },
    // One shuttle per pad: it lands to bring a new agent or collect a leaving one, then goes.
    { id: 'shuttle-north', district: 'field', sprite: 'shuttle-0', ...px(1235, 285), w: 0.1, when: 'in-service', on: 'pad-north' },
  ],
  // Fourteen work spots beside the structures, far enough apart that figures and their panels
  // do not overlap (sites.test.ts checks every pair). Listed in the order they fill, so the
  // first agents spread across the districts rather than filling one.
  sites: [
    { id: 'sw-generator', at: 'generator', district: 'sw', label: 'Generator', ...px(262, 508), work: 'repair', faces: -1 },
    { id: 'se-survey', at: 'tripod', district: 'se', label: 'Survey site', ...px(920, 498), work: 'stand', faces: 1 },
    { id: 'nw-planter', at: 'planter', district: 'nw', label: 'Planter', ...px(445, 258), work: 'tend', faces: -1 },
    { id: 'ne-habitat', at: 'habitat', district: 'ne', label: 'Habitat', ...px(935, 240), work: 'stand', faces: -1 },
    { id: 'pond', label: 'Water station', ...px(462, 592), work: 'kneel', faces: 1 },
    { id: 'nw-greenhouse', at: 'greenhouse', district: 'nw', label: 'Greenhouse', ...px(318, 268), work: 'stand', faces: -1 },
    { id: 'sw-workshop', at: 'workshop', district: 'sw', label: 'Workshop', ...px(388, 498), work: 'stand', faces: -1 },
    { id: 'se-module', at: 'module', district: 'se', label: 'Module', ...px(790, 505), work: 'stand', faces: 1 },
    // (No work spot on the landing field: an agent standing there reads as leaving.)
    { id: 'pond-east', label: 'East bank', ...px(748, 598), work: 'kneel', faces: -1 },
    { id: 'ne-yard', at: 'habitat', district: 'ne', label: 'Habitat yard', ...px(775, 238), work: 'kneel', faces: 1 },
    { id: 'sw-yard', at: 'generator', district: 'sw', label: 'Works yard', ...px(140, 512), work: 'kneel', faces: 1 },
    { id: 'se-samples', at: 'tripod', district: 'se', label: 'Sample site', ...px(1030, 505), work: 'kneel', faces: -1 },
    { id: 'nw-yard', at: 'greenhouse', district: 'nw', label: 'Greenhouse yard', ...px(165, 262), work: 'stand', faces: 1 },
    { id: 'road', label: 'East road', ...px(1010, 356), work: 'stand', faces: 1 },
  ],
  // The commons: idle agents come here and stay.
  rest: [
    { id: 'rest-table-west', district: 'commons', label: 'Commons', ...px(505, 376), work: 'stand', faces: 1 },
    { id: 'rest-table-east', district: 'commons', label: 'Commons', ...px(700, 376), work: 'stand', faces: -1 },
    { id: 'rest-table-south', district: 'commons', label: 'Commons', ...px(602, 432), work: 'stand', faces: 1 },
    { id: 'rest-bench-west', district: 'commons', label: 'West bench', ...px(432, 345), work: 'stand', faces: 1 },
    { id: 'rest-bench-east', district: 'commons', label: 'East bench', ...px(790, 356), work: 'stand', faces: -1 },
  ],
  // Confer participants stand around the holo table, facing it.
  meet: [
    { id: 'meet-west', district: 'commons', label: 'Commons table', ...px(550, 358), work: 'stand', faces: 1 },
    { id: 'meet-east', district: 'commons', label: 'Commons table', ...px(654, 358), work: 'stand', faces: -1 },
    { id: 'meet-south-west', district: 'commons', label: 'Commons table', ...px(566, 396), work: 'stand', faces: 1 },
    { id: 'meet-south-east', district: 'commons', label: 'Commons table', ...px(640, 396), work: 'stand', faces: -1 },
  ],
};

/** Every plate the scene can show. Tests iterate this, so a new plate is checked automatically. */
export const PLATES: readonly WorldPlate[] = [OUTPOST];

export interface Placement {
  x: number;
  y: number;
  siteId: string;
}

/** Where the 2nd, 3rd… agent at an already-taken site stands, relative to the site. */
const CROWD_OFFSETS: readonly (readonly [number, number])[] = [
  [0.06, 0.045], [-0.06, 0.045], [0, 0.085], [0.06, -0.05], [-0.06, -0.05], [0.115, 0],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * STICKY SLOTS. A slot is a place in the plate's filling order (slot 0 = first site, slot n =
 * the first spot beside the first site, …). An agent keeps its slot for as long as it is on
 * site; a newcomer takes the lowest slot nobody is using. Without this, one agent arriving
 * would shift everyone after it alphabetically and the whole crew would walk to new sites.
 */
export function assignSlots(prev: ReadonlyMap<string, number>, keys: readonly string[]): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set<number>();
  for (const key of keys) {
    const slot = prev.get(key);
    if (slot !== undefined && !used.has(slot)) { next.set(key, slot); used.add(slot); }
  }
  let free = 0;
  for (const key of keys) {
    if (next.has(key)) continue;
    while (used.has(free)) free++;
    next.set(key, free);
    used.add(free);
  }
  return next;
}

/**
 * Turn slots into spots on the plate. Once every site is taken the next round stands beside
 * the first, so a crew larger than the plate still shows everyone and nobody is drawn exactly
 * on top of anybody else.
 */
export function spotsFor(slots: ReadonlyMap<string, number>, plate: Pick<WorldPlate, 'sites'> & { figureScale?: number }): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const n = plate.sites.length;
  const taken = new Set<string>();
  for (const [key, slot] of [...slots].sort((a, b) => a[1] - b[1])) {
    const site = plate.sites[slot % n];
    const round = Math.floor(slot / n);
    let x = site.x;
    let y = site.y;
    if (round > 0) {
      const [dx, dy] = CROWD_OFFSETS[(round - 1) % CROWD_OFFSETS.length];
      // Doubling-up distance follows the size of a figure on this plate.
      const spread = (1 + Math.floor((round - 1) / CROWD_OFFSETS.length) * 0.6) * (plate.figureScale ?? 1);
      x = clamp(site.x + dx * spread, 0.02, 0.98);
      y = clamp(site.y + dy * spread, 0.15, 0.98);
    }
    // Clamping at the plate's edge can fold two spots together; nudge until the spot is free.
    let spot = `${x.toFixed(4)},${y.toFixed(4)}`;
    for (let step = 1; taken.has(spot); step++) {
      x = clamp(site.x + (step % 2 ? -1 : 1) * 0.011 * step, 0.02, 0.98);
      y = clamp(site.y + 0.008 * step, 0.15, 0.98);
      spot = `${x.toFixed(4)},${y.toFixed(4)}`;
    }
    taken.add(spot);
    out.set(key, { x, y, siteId: site.id });
  }
  return out;
}

/** Place a crew from scratch: keys fill the slots in the order given. */
export function placeCrew(keys: readonly string[], plate: WorldPlate): Map<string, Placement> {
  return spotsFor(assignSlots(new Map(), keys), plate);
}
