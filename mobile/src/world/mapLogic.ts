/**
 * THE AGENTS MAP ON THE PHONE — what is on it and where, as plain data.
 *
 * Everything that decides the scene is the dashboard's own code, imported: who is on site
 * (crew.ts), which pod a project holds and which building stands for a repo (zones.ts), the
 * sticky spots (sites.ts), which character an agent wears (sheets.ts) and which look a state
 * gets (anim.ts — ONE LOOK PER STATE). So the same agent stands at the same building, in the
 * same pose, on the dashboard and on the phone. This file only turns that into a list of things
 * to draw; WorldMap.tsx draws them. Pure, so it is tested without a renderer.
 *
 * Not on the phone (dashboard only, for now): the launch shuttle, the delivery flare, deadline
 * gauges, step badges, the confer gathering, dragging, and the ambient water/hologram motion.
 */
import { buildCrew, type CrewMember } from '../../../dashboard/src/world/crew';
import { OUTPOST, type WorldPlate } from '../../../dashboard/src/world/sites';
import { planZones, zoneFor, placeByZone, OPEN_POOL, type PoolSlots, type ZoneProject } from '../../../dashboard/src/world/zones';
import { animationFor, type AnimationName } from '../../../dashboard/src/world/anim';
import { assignCharacters, CHARACTERS } from '../../../dashboard/src/world/sheets';
import type { Agent, PermissionRequest } from '../types';

export const PLATE: WorldPlate = OUTPOST;
/** A figure's height as a share of the map's height — the dashboard's AVATAR_SCALE × figureScale. */
export const FIGURE_SHARE = 0.2 * PLATE.figureScale;

export type MapProject = ZoneProject;
/** What survives from one build to the next, so nobody moves or changes face because someone else arrived. */
export interface MapMemory { slots: PoolSlots; cast: Map<string, string> }
export const emptyMemory = (): MapMemory => ({ slots: new Map(), cast: new Map() });

export interface MapFigure {
  key: string;
  /** The agent a tap opens: the primary one of the cartridge. */
  agentId: string;
  name: string;
  /** Feet position, as fractions of the map. */
  x: number;
  y: number;
  siteId: string;
  anim: AnimationName;
  facing: 1 | -1;
  character: string;
  engine: string;
  /** neon while working, ember when it needs you, quiet when idle. */
  tone: 'live' | 'ember' | 'quiet';
  /** What it needs, in words; '' when nothing. */
  attention: string;
}
export interface MapStructure { id: string; sprite: string; x: number; y: number; w: number; flat: boolean }
export interface MapBanner { id: string; x: number; y: number; name: string; detail: string; active: boolean }
export interface MapScene { figures: MapFigure[]; structures: MapStructure[]; banners: MapBanner[]; memory: MapMemory }

type CrewInput = Parameters<typeof buildCrew>[0];

export function buildMap(
  input: { agents: readonly Agent[]; permissions: readonly PermissionRequest[]; projects: readonly MapProject[]; now: number },
  memory: MapMemory,
): MapScene {
  const crew: CrewMember[] = buildCrew({
    agents: input.agents as unknown as CrewInput['agents'],
    activitiesByAgent: {},
    pendingPermissions: input.permissions as unknown as CrewInput['pendingPermissions'],
    stuckAlerts: [],
    now: input.now,
  });
  const zones = planZones(input.projects, PLATE);
  const repoOf = new Map(input.agents.map((a) => [a.id, a.repoPath]));

  // An agent works at its repo's building; one whose repo no project owns uses unclaimed land.
  const wants = crew.map((m) => {
    const home = m.agentIds.map((id) => zoneFor(zones, repoOf.get(id) ?? '')).find((z) => z !== null);
    return { key: m.key, pool: home?.building ?? OPEN_POOL };
  });
  const placed = placeByZone(memory.slots, wants, PLATE, new Set(zones.flatMap((z) => z.districts)));
  const cast = assignCharacters(memory.cast, crew.map((m) => m.key), CHARACTERS);

  const figures: MapFigure[] = [];
  for (const m of crew) {
    const spot = placed.spots.get(m.key);
    if (!spot) continue;
    const site = PLATE.sites.find((s) => s.id === spot.siteId);
    figures.push({
      key: m.key, agentId: m.agent.id, name: m.name, x: spot.x, y: spot.y, siteId: spot.siteId,
      anim: animationFor(m, false, site?.work ?? 'stand'),
      facing: site?.faces ?? 1,
      character: cast.get(m.key) ?? CHARACTERS[0],
      engine: m.engine,
      tone: m.attention || m.status === 'waiting' ? 'ember' : m.status === 'working' ? 'live' : 'quiet',
      attention: m.attentionText,
    });
  }

  // A pod's gate stands open while its project has a feature under way.
  const activeDistricts = new Set(zones.filter((z) => z.features.active > 0).flatMap((z) => z.districts));
  const structures: MapStructure[] = PLATE.structures
    .filter((st) => !st.when)      // the shuttle is only there while it is flying someone in
    .map((st) => ({
      id: st.id, x: st.x, y: st.y, w: st.w, flat: Boolean(st.flat),
      sprite: st.gate ? (st.district && activeDistricts.has(st.district) ? 'gate-3' : 'gate-0') : st.sprite,
    }));

  const banners: MapBanner[] = zones.flatMap((z) => {
    const d = PLATE.districts.find((x) => x.id === z.districts[0]);
    if (!d || d.x === undefined || d.y === undefined) return [];
    return [{
      id: z.projectId, x: d.x, y: d.y, name: z.name, active: z.features.active > 0,
      detail: `${z.features.done}/${z.features.total} features${z.features.active > 0 ? ` · ${z.features.active} under way` : ''}`,
    }];
  });

  return { figures, structures, banners, memory: { slots: placed.slots, cast } };
}

/** How long a walk between two spots takes, in ms: a steady pace, never an instant hop or a crawl. */
export function walkMs(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const d = Math.hypot((to.x - from.x) * (PLATE.width / PLATE.height), to.y - from.y);
  return d < 0.004 ? 0 : Math.round(Math.min(9000, Math.max(600, d * 9000)));
}
