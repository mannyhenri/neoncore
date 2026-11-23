/**
 * PROJECT → ZONE, REPO → BUILDING, AGENT → ITS BUILDING.
 *
 * A project claims ONE district of the map (its zone). Each repo the project owns gets a
 * building in that district (repos share buildings once there are more repos than buildings), and an agent works at a spot beside its own repo's building.
 * Agents whose repo belongs to no project use the land nobody has claimed.
 *
 * Pure: the same projects always give the same map, oldest project first, so adding a project
 * never moves the ones already there.
 */
import type { Project } from '../types';
import type { WorldPlate } from './sites';
import { assignSlots, spotsFor } from './sites';
import type { Placement } from './sites';

export type ZoneProject = Pick<Project, 'id' | 'name' | 'color' | 'primaryRepo' | 'cartridges' | 'createdAt' | 'featureCount' | 'featuresDone' | 'featuresActive'>;

export interface Zone {
  projectId: string;
  name: string;
  color: string;
  /** The district this project holds (a list of exactly one). */
  districts: string[];
  /** Normalised repo path → the building (structure id) that stands for it. */
  buildings: Map<string, string>;
  features: { total: number; done: number; active: number };
}

/** The pool for agents of no project. */
export const OPEN_POOL = 'open';
/**
 * A CAMP: the map has a district for the first projects only. A project past that has no pod,
 * but its agents still stand TOGETHER — around one spot of open land, a camp each, oldest
 * project first — instead of being scattered over the open spots one by one.
 */
export const CAMP_PREFIX = 'camp:';
/** Where camps go, in order: the east road, then the pond's banks, then any other open spot. */
export const CAMP_SITES = ['road', 'pond-east', 'pond'] as const;

/** Normalised repo path → its camp's pool, for every repo of a project that has no district. */
export function planCamps(projects: readonly ZoneProject[], zones: readonly Zone[]): Map<string, string> {
  const zoned = new Set(zones.map((z) => z.projectId));
  const ordered = [...projects].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  const out = new Map<string, string>();
  ordered.filter((p) => !zoned.has(p.id)).forEach((p, i) => {
    for (const repo of reposOf(p)) if (!out.has(repo)) out.set(repo, `${CAMP_PREFIX}${i}`);
  });
  return out;
}

/** Repo paths as the server compares them (lib/resolve-agent.ts normalizeRepoPath). */
export const normRepo = (p: string): string =>
  (p || '').replace(/\\/g, '/').replace(/^([a-zA-Z]):\//, '/$1/').replace(/\/+$/, '').toLowerCase();

const reposOf = (p: ZoneProject): string[] => {
  const all = [...(p.cartridges ?? []), p.primaryRepo].map(normRepo).filter(Boolean);
  return [...new Set(all)];
};

export function planZones(projects: readonly ZoneProject[], plate: Pick<WorldPlate, 'districts' | 'structures'>): Zone[] {
  const buildingsIn = (d: string) => plate.structures.filter((s) => s.building && s.district === d).map((s) => s.id);
  const free = plate.districts.map((d) => d.id).filter((d) => buildingsIn(d).length > 0);
  const ordered = [...projects].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));

  // ONE district per project, always: a project's agents are never split across the map,
  // and adding a project never moves one that is already there.
  const zones: (Zone & { repos: string[] })[] = [];
  for (const p of ordered) {
    const d = free.shift();
    if (!d) break;
    zones.push({
      projectId: p.id, name: p.name, color: p.color, districts: [d], buildings: new Map(), repos: reposOf(p),
      features: { total: p.featureCount ?? 0, done: p.featuresDone ?? 0, active: p.featuresActive ?? 0 },
    });
  }
  // A building per repo; a project with more repos than buildings doubles them up in order.
  return zones.map(({ repos, ...z }) => {
    const mine = z.districts.flatMap(buildingsIn);
    repos.forEach((r, i) => z.buildings.set(r, mine[i % mine.length]));
    return z;
  });
}

/**
 * SECTORS: the world has room for a handful of projects (one district each). Past that, the
 * projects are spread over SECTORS — the same world again, a full set of districts each — so every
 * project has a district of its own, however many there are. Oldest project first, filled sector
 * by sector: adding a project never moves one that is already there, it starts or fills the last
 * sector. One sector is on the map at a time.
 */
export interface Sector { index: number; projects: ZoneProject[] }
/** How many projects one sector holds: the districts that have a building. */
export const sectorSize = (plate: Pick<WorldPlate, 'districts' | 'structures'>): number =>
  Math.max(1, plate.districts.filter((d) => plate.structures.some((s) => s.building && s.district === d.id)).length);
/**
 * ROOM TO WORK. A pod holds four agents, and a project runs one agent per repo — two per repo
 * while a feature is being built in a branch of each. So a project with more than two repos needs
 * a SECOND district, or its team stands eight deep in one. A sector keeps that room: it is planned
 * by the districts its projects need, not by counting projects, and the spare district is the one
 * planAnnexes hands to the crowded project.
 */
export function districtsNeeded(p: ZoneProject, size: number): number {
  return Math.min(size, Math.max(1, Math.ceil((reposOf(p).length * 2) / POD_CAPACITY)));
}
export function planSectors(projects: readonly ZoneProject[], plate: Pick<WorldPlate, 'districts' | 'structures'>): Sector[] {
  const size = sectorSize(plate);
  const ordered = [...projects].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  const out: Sector[] = [];
  let room = 0;
  // In order, never reshuffled: a project that does not fit what is left starts the next sector.
  for (const p of ordered) {
    const need = districtsNeeded(p, size);
    if (out.length === 0 || need > room) { out.push({ index: out.length, projects: [] }); room = size; }
    out[out.length - 1].projects.push(p);
    room -= need;
  }
  return out.length ? out : [{ index: 0, projects: [] }];
}
/** Normalised repo path → the sector its project is in. A repo two projects name belongs to the older one, as for buildings. */
export function sectorByRepo(sectors: readonly Sector[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sectors) for (const p of s.projects) for (const repo of reposOf(p)) if (!out.has(repo)) out.set(repo, s.index);
  return out;
}

/** The zone and building an agent's repo belongs to; null when no project owns the repo. */
export function zoneFor(zones: readonly Zone[], repoPath: string): { zone: Zone; building: string } | null {
  const repo = normRepo(repoPath);
  for (const zone of zones) {
    const building = zone.buildings.get(repo);
    if (building) return { zone, building };
  }
  return null;
}

/**
 * A POD HOLDS FOUR. A project with more agents on the map than that takes a SECOND pod for the
 * rest (and a third past eight…): the next district no project holds. Its agents fill pod by pod
 * in the order of their places (sticky, so nobody changes pod because someone else arrived), and
 * a feature's team arrives together — so two features of one project work in two pods.
 *
 * With no free district left, the extra agents share the pods the project has, evenly.
 */
export const POD_CAPACITY = 4;
/** The pool of a whole district: `pod:<district>`. */
export const POD_PREFIX = 'pod:';

/** projectId → the extra districts it works in, for every project with more than POD_CAPACITY agents on the map. */
export function planAnnexes(zones: readonly Zone[], plate: Pick<WorldPlate, 'districts' | 'structures'>, crowd: ReadonlyMap<string, number>): Map<string, string[]> {
  const held = new Set(zones.flatMap((z) => z.districts));
  const free = plate.districts.map((d) => d.id).filter((d) => !held.has(d) && plate.structures.some((s) => s.building && s.district === d));
  const out = new Map<string, string[]>();
  // Oldest project first, like the districts themselves: who gets the spare pod never depends on who is busiest.
  for (const z of zones) {
    const extra = Math.ceil((crowd.get(z.projectId) ?? 0) / POD_CAPACITY) - 1;
    const mine: string[] = [];
    while (mine.length < extra && free.length > 0) mine.push(free.shift()!);
    if (mine.length > 0) out.set(z.projectId, mine);
  }
  return out;
}

/**
 * The building an agent works at, given its place in its project (0 = first to arrive): its own
 * repo's building in the home pod, or the building in the same position of the annex it falls in.
 */
export function buildingFor(plate: Pick<WorldPlate, 'structures'>, zone: Zone, homeBuilding: string, place: number, annexes: readonly string[]): { building: string; district: string } {
  const pods = [zone.districts[0], ...annexes];
  const district = pods[Math.floor(place / POD_CAPACITY) % pods.length];
  if (district === zone.districts[0]) return { building: homeBuilding, district };
  const inPod = (d: string) => plate.structures.filter((s) => s.building && s.district === d).map((s) => s.id);
  const there = inPod(district);
  const at = Math.max(0, inPod(zone.districts[0]).indexOf(homeBuilding));
  return { building: there[at % there.length], district };
}

/** Sticky slots, per pool: `pool` is a building id, or OPEN_POOL. */
export type PoolSlots = Map<string, Map<string, number>>;

/**
 * Place the crew. Each agent names its pool; within a pool the slots are sticky (sites.ts
 * assignSlots), so nobody moves because someone else arrived, left, or changed pool.
 * `claimed` is every district a project holds: the open pool keeps off it.
 */
export function placeByZone(
  prev: ReadonlyMap<string, ReadonlyMap<string, number>>,
  wants: readonly { key: string; pool: string }[],
  plate: Pick<WorldPlate, 'sites' | 'figureScale'>,
  claimed: ReadonlySet<string>,
): { slots: PoolSlots; spots: Map<string, Placement> } {
  const open = plate.sites.filter((s) => !s.district || !claimed.has(s.district));
  // Camps take the preferred spots first, then whatever else is open.
  const campSites = [...CAMP_SITES.map((id) => open.find((s) => s.id === id)).filter((s): s is (typeof open)[number] => s !== undefined), ...open.filter((s) => !(CAMP_SITES as readonly string[]).includes(s.id))];
  const sitesOf = (pool: string) => {
    if (pool.startsWith(CAMP_PREFIX)) {
      const n = Number(pool.slice(CAMP_PREFIX.length)) || 0;
      // ONE spot per camp: everyone of that project gathers round it.
      return campSites.length > 0 ? [campSites[n % campSites.length]] : plate.sites.slice(0, 1);
    }
    // A project's second pod: its four spread over every spot of that district, not one building's.
    if (pool.startsWith(POD_PREFIX)) {
      const there = plate.sites.filter((s) => s.district === pool.slice(POD_PREFIX.length));
      if (there.length > 0) return there;
    }
    const at = pool === OPEN_POOL ? [] : plate.sites.filter((s) => s.at === pool);
    // A building with no spot of its own, or a map with no open land: fall back to everything.
    return at.length > 0 ? at : open.length > 0 ? open : plate.sites;
  };
  const byPool = new Map<string, string[]>();
  for (const w of wants) byPool.set(w.pool, [...(byPool.get(w.pool) ?? []), w.key]);
  const slots: PoolSlots = new Map();
  const spots = new Map<string, Placement>();
  for (const [pool, keys] of byPool) {
    const mine = assignSlots(prev.get(pool) ?? new Map(), keys);
    slots.set(pool, mine);
    for (const [key, spot] of spotsFor(mine, { sites: sitesOf(pool), figureScale: plate.figureScale })) spots.set(key, spot);
  }
  return { slots, spots };
}
