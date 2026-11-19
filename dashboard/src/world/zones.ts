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

/** The zone and building an agent's repo belongs to; null when no project owns the repo. */
export function zoneFor(zones: readonly Zone[], repoPath: string): { zone: Zone; building: string } | null {
  const repo = normRepo(repoPath);
  for (const zone of zones) {
    const building = zone.buildings.get(repo);
    if (building) return { zone, building };
  }
  return null;
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
  const sitesOf = (pool: string) => {
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
