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
  /** The seats of the bench by the pond: where an agent idle for 30 minutes goes and sits (props.ts). */
  rest: WorldSite[];
  /**
   * Three fixed spots in each project district: where its SIGNPOST stands (the foot of the post —
   * the project's name is on its board), and the two things its records earn (props.ts): the
   * statue and the freight. Low in the district, clear of its work spots, panels, buildings and gate.
   */
  props: Record<string, { sign: { x: number; y: number }; statue: { x: number; y: number }; freight: { x: number; y: number } }>;
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
 *   commons     the plaza: the meeting table
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
    { id: 'heater', district: 'commons', sprite: 'heater', ...px(690, 350), w: 0.024 },
    { id: 'banner', district: 'commons', sprite: 'banner', ...px(528, 330), w: 0.024 },
    { id: 'pad-north', district: 'field', sprite: 'pad', ...px(1235, 300), w: 0.115, flat: true, door: px(1180, 300) },
    // One shuttle per pad: it lands to bring a new agent or collect a leaving one, then goes.
    { id: 'shuttle-north', district: 'field', sprite: 'shuttle-0', ...px(1235, 285), w: 0.1, when: 'in-service', on: 'pad-north' },
    // The fountain fills the bottom end of the landing field.
    { id: 'fountain', district: 'field', sprite: 'fountain', ...px(1232, 528), w: 0.062 },
    // ONE bench, on the pond's north bank, facing the water (and you).
    { id: 'bench', sprite: 'bench', ...px(618, 492), w: 0.058 },
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
  // The bench's two seats. Three would put the figures and their panels on top of each other.
  rest: [
    { id: 'bench-west', label: 'Pond bench', ...px(600, 494), work: 'stand', faces: 1 },
    { id: 'bench-east', label: 'Pond bench', ...px(636, 494), work: 'stand', faces: 1 },
  ],
  props: {
    nw: { sign: px(300, 358), statue: px(214, 322), freight: px(388, 330) },
    sw: { sign: px(250, 614), statue: px(160, 566), freight: px(340, 562) },
    se: { sign: px(905, 614), statue: px(812, 566), freight: px(996, 562) },
    ne: { sign: px(888, 342), statue: px(956, 328), freight: px(818, 340) },
  },
  // Confer participants stand around the holo table, facing it.
  meet: [
    { id: 'meet-west', district: 'commons', label: 'Commons table', ...px(550, 358), work: 'stand', faces: 1 },
    { id: 'meet-east', district: 'commons', label: 'Commons table', ...px(654, 358), work: 'stand', faces: -1 },
    { id: 'meet-south-west', district: 'commons', label: 'Commons table', ...px(566, 396), work: 'stand', faces: 1 },
    { id: 'meet-south-east', district: 'commons', label: 'Commons table', ...px(640, 396), work: 'stand', faces: -1 },
  ],
};

/**
 * THE VILLAGE — the fantasy theme's map (theme.ts). The SAME pods, buildings, gates and work spots
 * as the outpost, by id and by role: only where they stand differs, read off the village map
 * (designs/fantasy/terrain.png, 1344 × 752): four walled clearings around a cobbled plaza, a stone
 * landing circle to the east, a pond to the south. Built FROM the outpost so the two cannot drift —
 * a structure or a spot added there needs a position here, and `moved` fails loudly without one.
 */
const VILLAGE_AT: Record<string, [number, number, number?]> = {
  // districts — where each pod's name plate goes (below its clearing)
  'district:nw': [335, 286], 'district:sw': [275, 634], 'district:se': [880, 642], 'district:ne': [835, 282],
  // structures — base (centre-bottom), and a width where the village's sprite needs another
  greenhouse: [288, 192, 0.1], planter: [398, 188, 0.06], habitat: [792, 186, 0.1], dish: [900, 152, 0.032],
  'gate-ne': [748, 274, 0.05], 'gate-nw': [412, 270, 0.05], 'gate-sw': [394, 480, 0.05], 'gate-se': [752, 488, 0.05],
  generator: [205, 512, 0.075], workshop: [345, 506, 0.09], module: [815, 532, 0.062], tripod: [932, 518, 0.045],
  'water-station': [436, 652, 0.042], 'holo-table': [567, 378, 0.085], heater: [648, 348, 0.028], banner: [498, 334, 0.024],
  'pad-north': [1205, 402, 0.14], 'shuttle-north': [1205, 372, 0.1],
  fountain: [1192, 514, 0.062], bench: [612, 590, 0.058], 'bench-west': [594, 592], 'bench-east': [630, 592],
  // the statue and the freight of each clearing
  'statue:nw': [250, 304], 'freight:nw': [424, 316], 'statue:sw': [186, 644], 'freight:sw': [366, 642],
  'statue:se': [792, 652], 'freight:se': [968, 650], 'statue:ne': [772, 322], 'freight:ne': [1002, 296],
  // where each clearing's signpost stands
  'sign:nw': [335, 344], 'sign:sw': [290, 666], 'sign:se': [880, 670], 'sign:ne': [850, 336],
  // work spots — at the feet
  'sw-generator': [255, 548], 'se-survey': [885, 552], 'nw-planter': [448, 200], 'ne-habitat': [865, 205],
  pond: [470, 674], 'nw-greenhouse': [340, 232], 'sw-workshop': [385, 560], 'se-module': [762, 572],
  'pond-east': [660, 676], 'ne-yard': [722, 212], 'sw-yard': [270, 474], 'se-samples': [880, 478],
  'nw-yard': [240, 190], road: [942, 372],
  // around the council table
  'meet-west': [503, 372], 'meet-east': [632, 372], 'meet-south-west': [524, 412], 'meet-south-east': [611, 412],
};
const VILLAGE_LABEL: Record<string, string> = {
  nw: 'Glasshouse clearing', sw: 'Forge clearing', se: 'Tower clearing', ne: 'Cottage clearing', commons: 'Plaza', field: 'Landing circle',
  'sw-generator': 'Forge', 'se-survey': 'Spyglass', 'nw-planter': 'Herb beds', 'ne-habitat': 'Cottage', pond: 'Well',
  'nw-greenhouse': 'Glasshouse', 'sw-workshop': 'Smithy', 'se-module': 'Tower', 'pond-east': 'East bank', 'ne-yard': 'Cottage yard',
  'sw-yard': 'Forge yard', 'se-samples': 'Tower yard', 'nw-yard': 'Glasshouse yard', road: 'East road',
};
function moved<T extends { id: string; x?: number; y?: number; label?: string }>(thing: T, key = thing.id): T {
  const at = VILLAGE_AT[key];
  if (!at) throw new Error(`the village has no position for "${key}" — add it to VILLAGE_AT (sites.ts)`);
  const [x, y, w] = at;
  return { ...thing, ...px(x, y), ...(w !== undefined ? { w } : {}), ...(VILLAGE_LABEL[thing.id] ? { label: VILLAGE_LABEL[thing.id] } : {}) };
}
export const VILLAGE: WorldPlate = {
  ...OUTPOST,
  id: 'village',
  src: '/world/fantasy/terrain.jpg',
  // Beside the airship on the landing circle: new agents arrive by air.
  entry: px(1095, 362),
  districts: OUTPOST.districts.map((d) => (d.x === undefined ? { ...d, label: VILLAGE_LABEL[d.id] ?? d.label } : moved(d, `district:${d.id}`))),
  structures: OUTPOST.structures.map((st) => ({ ...moved(st), ...(st.door ? { door: px(1095, 362) } : {}) })),
  sites: OUTPOST.sites.map((s) => moved(s)),
  meet: OUTPOST.meet.map((s) => moved(s)),
  rest: OUTPOST.rest.map((s) => moved(s)),
  props: Object.fromEntries(Object.keys(OUTPOST.props).map((d) => {
    const at = (kind: string) => { const [x, y] = VILLAGE_AT[`${kind}:${d}`] ?? (() => { throw new Error(`the village has no ${kind} spot for "${d}" — add it to VILLAGE_AT (sites.ts)`); })(); return px(x, y); };
    return [d, { sign: at('sign'), statue: at('statue'), freight: at('freight') }];
  })),
};

/**
 * THE NEW MAPS — two more per theme, opened by what the whole outfit delivers (theme.ts MAPS_BY_THEME,
 * server lib/project-rewards.ts NEW_MAPS). Each is the SAME world — the same pods, buildings, gates and
 * work spots, by id and by role — charted onto another painted terrain, exactly as the village is:
 * a table of positions read off the 1344 × 752 art, and `charted` fails loudly for anything left out.
 *
 *   an INTERIOR  (the orbital station · the great hall)   four bays around a centre
 *   the ISLES    (the sky isles · the lagoon isles)       SIX pods, an island each, joined by bridges
 *
 * A pod is small here (an island top, a bay floor), so its buildings are about half the outpost's size.
 */
type At = Record<string, readonly [number, number, number?]>;
interface Chart { id: string; src: string; entry: readonly [number, number]; figureScale: number; at: At; labels: Record<string, string> }

function charted(base: WorldPlate, c: Chart): WorldPlate {
  const spot = (key: string) => {
    const at = c.at[key];
    if (!at) throw new Error(`the ${c.id} map has no position for "${key}" — add it to its table (sites.ts)`);
    return at;
  };
  const move = <T extends { id: string; label?: string }>(thing: T, key = thing.id): T => {
    const [x, y, w] = spot(key);
    return { ...thing, ...px(x, y), ...(w !== undefined ? { w } : {}), ...(c.labels[thing.id] ? { label: c.labels[thing.id] } : {}) };
  };
  const door = px(c.entry[0], c.entry[1]);
  return {
    ...base,
    id: c.id,
    src: c.src,
    entry: door,
    figureScale: c.figureScale,
    districts: base.districts.map((d) => (d.x === undefined ? { ...d, label: c.labels[d.id] ?? d.label } : move(d, `district:${d.id}`))),
    structures: base.structures.map((st) => ({ ...move(st), ...(st.door ? { door } : {}) })),
    sites: base.sites.map((s) => move(s)),
    meet: base.meet.map((s) => move(s)),
    rest: base.rest.map((s) => move(s)),
    props: Object.fromEntries(Object.keys(base.props).map((d) => {
      const at = (kind: string) => { const [x, y] = spot(`${kind}:${d}`); return px(x, y); };
      return [d, { sign: at('sign'), statue: at('statue'), freight: at('freight') }];
    })),
  };
}

/**
 * SIX PODS. The isles have an island for six projects, not four: two more districts (p5, p6), each
 * with a building, a gate, two work spots and its three prop spots. Claimed after the first four
 * (zones.ts takes districts in this order), so a sector of the isles holds six projects — or four
 * with room for two crowded ones to spread onto a neighbouring island.
 */
function withSixPods(base: WorldPlate): WorldPlate {
  const at = { x: 0, y: 0 };
  const first = base.districts.findIndex((d) => d.x === undefined);
  return {
    ...base,
    districts: [...base.districts.slice(0, first), { id: 'p5', label: 'Fifth pod', ...at }, { id: 'p6', label: 'Sixth pod', ...at }, ...base.districts.slice(first)],
    structures: [...base.structures,
      { id: 'hut', district: 'p5', sprite: 'hut', building: true, ...at, w: 0.05 },
      { id: 'tunnel', district: 'p6', sprite: 'tunnel', building: true, ...at, w: 0.05 },
      { id: 'gate-p5', district: 'p5', gate: true, sprite: 'gate-0', ...at, w: 0.04 },
      { id: 'gate-p6', district: 'p6', gate: true, sprite: 'gate-0', ...at, w: 0.04 },
    ],
    sites: [...base.sites,
      { id: 'p5-hut', at: 'hut', district: 'p5', label: 'Hut', ...at, work: 'stand', faces: -1 },
      { id: 'p6-tunnel', at: 'tunnel', district: 'p6', label: 'Tunnel', ...at, work: 'stand', faces: -1 },
      { id: 'p5-yard', at: 'hut', district: 'p5', label: 'Hut yard', ...at, work: 'kneel', faces: 1 },
      { id: 'p6-yard', at: 'tunnel', district: 'p6', label: 'Tunnel yard', ...at, work: 'kneel', faces: 1 },
    ],
    props: { ...base.props, p5: { sign: at, statue: at, freight: at }, p6: { sign: at, statue: at, freight: at } },
  };
}

const STATION_AT: At = {
  'district:nw': [345, 312], greenhouse: [289, 250, 0.05], planter: [399, 248, 0.034], 'nw-yard': [253, 298], 'nw-greenhouse': [345, 260],
  'nw-planter': [437, 298], 'statue:nw': [283, 338], 'freight:nw': [407, 338], 'sign:nw': [345, 344], 'district:sw': [268, 544],
  generator: [212, 482, 0.042], workshop: [322, 480, 0.05], 'sw-yard': [176, 530], 'sw-generator': [268, 492], 'sw-workshop': [360, 530],
  'statue:sw': [206, 570], 'freight:sw': [330, 570], 'sign:sw': [268, 576], 'district:se': [962, 550], module: [906, 488, 0.045],
  tripod: [1016, 486, 0.03], 'se-module': [870, 536], 'se-survey': [962, 498], 'se-samples': [1054, 536], 'statue:se': [900, 576],
  'freight:se': [1024, 576], 'sign:se': [962, 582], 'district:ne': [858, 314], habitat: [858, 262, 0.052], 'ne-yard': [796, 296],
  'ne-habitat': [920, 296], 'statue:ne': [796, 336], 'freight:ne': [920, 336], 'sign:ne': [858, 342], dish: [902, 258, 0.022],
  'gate-nw': [452, 334, 0.04], 'gate-ne': [752, 330, 0.04], 'gate-sw': [436, 444, 0.04], 'gate-se': [792, 442, 0.04],
  'water-station': [505, 672, 0.032], 'holo-table': [612, 430, 0.046], heater: [700, 374, 0.022], banner: [525, 374, 0.022],
  'pad-north': [1188, 290, 0.095], 'shuttle-north': [1188, 278, 0.085], fountain: [1218, 442, 0.048], bench: [612, 480, 0.05],
  'bench-west': [596, 482], 'bench-east': [628, 482], pond: [452, 668], 'pond-east': [778, 668], road: [1122, 394], 'meet-west': [540, 404],
  'meet-east': [684, 404], 'meet-south-west': [564, 436], 'meet-south-east': [660, 436],
};
const SKY_AT: At = {
  'district:nw': [385, 210], greenhouse: [329, 148, 0.05], planter: [439, 146, 0.034], 'nw-yard': [293, 196], 'nw-greenhouse': [385, 158],
  'nw-planter': [477, 196], 'statue:nw': [323, 236], 'freight:nw': [447, 236], 'sign:nw': [385, 242], 'district:sw': [272, 494],
  generator: [216, 428, 0.042], workshop: [326, 426, 0.05], 'sw-yard': [184, 480], 'sw-generator': [272, 438], 'sw-workshop': [360, 480],
  'statue:sw': [210, 520], 'freight:sw': [334, 520], 'sign:sw': [272, 526], 'district:se': [995, 504], module: [939, 442, 0.045],
  tripod: [1049, 440, 0.03], 'se-module': [903, 490], 'se-survey': [995, 452], 'se-samples': [1087, 490], 'statue:se': [933, 530],
  'freight:se': [1057, 530], 'sign:se': [995, 536], 'district:ne': [835, 214], habitat: [779, 152, 0.05], dish: [889, 150, 0.022],
  'ne-yard': [743, 200], 'ne-habitat': [927, 200], 'statue:ne': [773, 240], 'freight:ne': [897, 240], 'sign:ne': [835, 246],
  'district:p5': [165, 286], hut: [165, 246, 0.052], 'p5-yard': [105, 268], 'p5-hut': [222, 292], 'statue:p5': [275, 280], 'freight:p5': [54, 288],
  'sign:p5': [165, 308], 'district:p6': [522, 580], tunnel: [522, 528, 0.052], 'p6-yard': [460, 562], 'p6-tunnel': [584, 562],
  'statue:p6': [460, 602], 'freight:p6': [584, 602], 'sign:p6': [522, 608], 'gate-nw': [490, 238, 0.038], 'gate-ne': [728, 234, 0.038],
  'gate-sw': [392, 430, 0.038], 'gate-se': [836, 434, 0.038], 'gate-p5': [332, 306, 0.038], 'gate-p6': [585, 494, 0.038],
  'water-station': [758, 548, 0.028], 'holo-table': [620, 320, 0.058], heater: [702, 286, 0.022], banner: [540, 286, 0.022],
  'pad-north': [1048, 296, 0.1], 'shuttle-north': [1048, 284, 0.085], fountain: [1255, 308, 0.044], bench: [545, 384, 0.045],
  'bench-west': [531, 386], 'bench-east': [559, 386], pond: [702, 576], 'pond-east': [816, 576], road: [785, 414], 'meet-west': [552, 314],
  'meet-east': [690, 314], 'meet-south-west': [576, 342], 'meet-south-east': [666, 342],
};
const HALL_AT: At = {
  'district:nw': [268, 360], greenhouse: [212, 298, 0.05], planter: [322, 296, 0.034], 'nw-yard': [176, 346], 'nw-greenhouse': [268, 308],
  'nw-planter': [360, 346], 'statue:nw': [206, 386], 'freight:nw': [330, 386], 'sign:nw': [268, 392], 'district:sw': [225, 574],
  generator: [169, 506, 0.042], workshop: [279, 504, 0.05], 'sw-yard': [139, 560], 'sw-generator': [225, 516], 'sw-workshop': [311, 560],
  'statue:sw': [163, 600], 'freight:sw': [287, 600], 'sign:sw': [225, 606], 'district:se': [858, 574], module: [802, 512, 0.045],
  tripod: [912, 510, 0.03], 'se-module': [766, 560], 'se-survey': [858, 522], 'se-samples': [950, 560], 'statue:se': [796, 600],
  'freight:se': [920, 600], 'sign:se': [858, 606], 'district:ne': [838, 374], habitat: [838, 322, 0.052], 'ne-yard': [776, 356],
  'ne-habitat': [900, 356], 'statue:ne': [776, 396], 'freight:ne': [900, 396], 'sign:ne': [838, 402], dish: [882, 318, 0.022],
  'gate-nw': [396, 370, 0.04], 'gate-ne': [722, 382, 0.04], 'gate-sw': [388, 530, 0.04], 'gate-se': [712, 522, 0.04],
  'water-station': [500, 668, 0.03], 'holo-table': [555, 420, 0.058], heater: [640, 374, 0.022], banner: [470, 374, 0.022],
  'pad-north': [1210, 388, 0.09], 'shuttle-north': [1210, 376, 0.085], fountain: [1158, 480, 0.048], bench: [555, 494, 0.05],
  'bench-west': [539, 496], 'bench-east': [571, 496], pond: [440, 656], 'pond-east': [672, 656], road: [1075, 470], 'meet-west': [488, 410],
  'meet-east': [622, 410], 'meet-south-west': [512, 438], 'meet-south-east': [600, 438],
};
const LAGOON_AT: At = {
  'district:nw': [300, 214], greenhouse: [244, 146, 0.05], planter: [354, 144, 0.034], 'nw-yard': [214, 200], 'nw-greenhouse': [300, 156],
  'nw-planter': [386, 200], 'statue:nw': [282, 238], 'freight:nw': [408, 242], 'sign:nw': [345, 246], 'district:sw': [240, 570],
  generator: [184, 508, 0.042], workshop: [294, 506, 0.05], 'sw-yard': [148, 556], 'sw-generator': [240, 518], 'sw-workshop': [332, 556],
  'statue:sw': [178, 596], 'freight:sw': [302, 596], 'sign:sw': [240, 602], 'district:se': [925, 502], module: [869, 432, 0.045],
  tripod: [979, 430, 0.03], 'se-module': [843, 488], 'se-survey': [925, 442], 'se-samples': [1007, 488], 'statue:se': [863, 528],
  'freight:se': [987, 528], 'sign:se': [925, 534], 'district:ne': [985, 250], habitat: [985, 198, 0.052], 'ne-yard': [923, 232],
  'ne-habitat': [1047, 232], 'statue:ne': [900, 284], 'freight:ne': [1098, 236], 'sign:ne': [962, 292], dish: [1029, 194, 0.022],
  'district:p5': [178, 324], hut: [178, 272, 0.052], 'p5-yard': [125, 290], 'p5-hut': [228, 325], 'statue:p5': [105, 348], 'freight:p5': [288, 300],
  'sign:p5': [170, 354], 'district:p6': [712, 175], tunnel: [712, 123, 0.052], 'p6-yard': [654, 157], 'p6-tunnel': [770, 157],
  'statue:p6': [650, 197], 'freight:p6': [774, 197], 'sign:p6': [712, 203], 'gate-nw': [455, 250, 0.038], 'gate-ne': [835, 294, 0.038],
  'gate-sw': [368, 514, 0.038], 'gate-se': [832, 452, 0.038], 'gate-p5': [314, 352, 0.038], 'gate-p6': [640, 250, 0.038],
  'water-station': [625, 592, 0.028], 'holo-table': [600, 360, 0.055], heater: [672, 320, 0.022], banner: [530, 320, 0.022],
  'pad-north': [1215, 304, 0.085], 'shuttle-north': [1215, 292, 0.08], fountain: [1278, 458, 0.046], bench: [657, 414, 0.045],
  'bench-west': [643, 416], 'bench-east': [671, 416], pond: [545, 626], 'pond-east': [706, 626], road: [1195, 400], 'meet-west': [535, 354],
  'meet-east': [665, 354], 'meet-south-west': [560, 382], 'meet-south-east': [642, 382],
};

/** Sci-fi, interior: a biodome on an orbital station — four sunken bays round the reactor, a docking deck to the east. */
export const STATION: WorldPlate = charted(OUTPOST, {
  id: 'station', src: '/world/terrain-station.jpg', entry: [1122, 300], figureScale: 0.5, at: STATION_AT,
  labels: { nw: 'Garden bay', sw: 'Forge bay', se: 'Crystal bay', ne: 'Server bay', commons: 'Reactor plaza', field: 'Docking deck', pond: 'Coolant pool', 'pond-east': 'Pool rail', road: 'Deck ramp' },
});
/** Sci-fi, the isles: six floating islands joined to a hub by light bridges, a landing mesa to the east. */
export const SKY_ISLES: WorldPlate = charted(withSixPods(OUTPOST), {
  id: 'sky', src: '/world/terrain-sky.jpg', entry: [978, 292], figureScale: 0.5, at: SKY_AT,
  labels: { nw: 'Canopy isle', sw: 'Spore isle', se: 'Ruin isle', ne: 'Crystal isle', p5: 'Falls isle', p6: 'Moss isle', commons: 'Hub isle', field: 'Landing mesa', pond: 'Pond islet', 'pond-east': 'Islet rim', road: 'East bridge' },
});
/** Fantasy, interior: a great hall inside the mountain — four chambers round the rune dais, the gate court to the east. */
export const GREAT_HALL: WorldPlate = charted(VILLAGE, {
  id: 'hall', src: '/world/fantasy/terrain-hall.jpg', entry: [1140, 374], figureScale: 0.5, at: HALL_AT,
  labels: { nw: 'Library', sw: 'Winter garden', se: 'Crystal grotto', ne: 'Forge hall', commons: 'Rune dais', field: 'Gate court', pond: 'Spring', 'pond-east': 'Spring steps', road: 'Court steps' },
});
/** Fantasy, the isles: six islands in a lagoon joined to the plaza by bridges, the harbour quay to the east. */
export const LAGOON: WorldPlate = charted(withSixPods(VILLAGE), {
  id: 'lagoon', src: '/world/fantasy/terrain-lagoon.jpg', entry: [1160, 302], figureScale: 0.5, at: LAGOON_AT,
  labels: { nw: 'Blossom isle', sw: 'Stone-ring isle', se: 'Mushroom isle', ne: 'Palm isle', p5: 'Falls isle', p6: 'Pine isle', commons: 'Plaza isle', field: 'Harbour quay', pond: 'Lily pond', 'pond-east': 'Pond rim', road: 'Quay', 'p5-hut': 'Hut', 'p6-tunnel': 'Cellar', 'p5-yard': 'Hut yard', 'p6-yard': 'Cellar yard' },
});

/** Every plate the scene can show. Tests iterate this, so a new plate is checked automatically. */
export const PLATES: readonly WorldPlate[] = [OUTPOST, VILLAGE, STATION, SKY_ISLES, GREAT_HALL, LAGOON];

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
