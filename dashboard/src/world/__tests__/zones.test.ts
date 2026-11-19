import { describe, it, expect } from 'vitest';
import { PLATES, OUTPOST } from '../sites';
import { planZones, zoneFor, placeByZone, normRepo, OPEN_POOL } from '../zones';
import { padsFor, hostKey } from '../fleet';
import { meetingKeys } from '../meeting';

/**
 * THE CONNECTIONS. What the records say decides where things are on the map:
 *   project  → one or more districts (its zone); each of its repos → a building there
 *   agent    → a work spot AT its repo's building; agents of no project use the unclaimed land
 *   machine  → a landing pad (the shuttle is on it while the machine is online)
 *   confer   → its participants gather at the commons table
 * Every rule is checked for the whole set — all plates, all buildings, 0 to 6 projects.
 */
const project = (i: number, repos: string[], over: Record<string, unknown> = {}) => ({
  id: `p${i}`, name: `Project ${i}`, color: '#7CC4FF', primaryRepo: repos[0] ?? '', cartridges: repos,
  createdAt: `2026-01-0${i + 1}T00:00:00Z`, featureCount: 0, featuresDone: 0, featuresActive: 0, ...over,
});

describe('zones', () => {
  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: every building has a work spot, every gate guards a district, and there is a place to meet', ({ plate }) => {
    const buildings = plate.structures.filter((s) => s.building);
    expect(buildings.length).toBeGreaterThanOrEqual(4);
    for (const b of buildings) {
      expect(b.district, `${b.id} must be in a district`).toBeTruthy();
      expect(plate.sites.filter((s) => s.at === b.id).length, `${b.id} needs a work spot`).toBeGreaterThanOrEqual(1);
    }
    for (const s of plate.sites) if (s.at) expect(buildings.map((b) => b.id), `${s.id} is at an unknown building`).toContain(s.at);
    const withBuildings = [...new Set(buildings.map((b) => b.district))];
    const gated = plate.structures.filter((s) => s.gate).map((s) => s.district);
    expect(gated.sort(), 'one gate per district that can hold a project').toEqual([...withBuildings].sort());
    expect(plate.sites.some((s) => !s.at), 'land for agents of no project').toBe(true);
    expect(plate.meet.length).toBeGreaterThanOrEqual(4);
    const pads = plate.structures.filter((s) => s.sprite === 'pad');
    for (const pad of pads) {
      expect(pad.door, `${pad.id} needs a door spot`).toBeTruthy();
      expect(plate.structures.filter((s) => s.when === 'in-service' && s.on === pad.id), `${pad.id} needs its shuttle`).toHaveLength(1);
    }
  });

  it.each(PLATES.map((p) => ({ name: p.id, plate: p })))('$name: nobody works or rests on the landing field — it is for arriving and leaving only', ({ plate }) => {
    const pads = plate.structures.filter((s) => s.sprite === 'pad');
    for (const spot of [...plate.sites, ...plate.rest, ...plate.meet]) {
      expect(spot.district, `${spot.id} is on the landing field`).not.toBe('field');
      for (const pad of pads) {
        const near = Math.hypot((spot.x - pad.door!.x) / plate.spacing.x, (spot.y - pad.door!.y) / plate.spacing.y);
        expect(near, `${spot.id} stands at ${pad.id}'s door`).toBeGreaterThan(1.2);
      }
    }
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('%i projects: each gets a zone while districts last, no district is claimed twice', (n) => {
    const projects = Array.from({ length: n }, (_, i) => project(i, [`/code/r${i}a`, `/code/r${i}b`]));
    const zones = planZones(projects, OUTPOST);
    const capacity = new Set(OUTPOST.structures.filter((s) => s.building).map((s) => s.district)).size;
    expect(zones).toHaveLength(Math.min(n, capacity));
    const claimed = zones.flatMap((z) => z.districts);
    expect(new Set(claimed).size).toBe(claimed.length);
    for (const z of zones) {
      expect(z.districts.length).toBeGreaterThanOrEqual(1);
      // Every repo of a project that has a zone has a building, inside that zone.
      const p = projects.find((x) => x.id === z.projectId)!;
      for (const repo of p.cartridges) {
        const b = OUTPOST.structures.find((s) => s.id === z.buildings.get(normRepo(repo)));
        expect(b, `${repo} has no building`).toBeTruthy();
        expect(z.districts).toContain(b!.district);
      }
    }
    // Oldest project first: adding a project never moves the ones already on the map.
    if (n > 1) expect(planZones(projects.slice(0, n - 1), OUTPOST)[0].districts[0]).toBe(zones[0].districts[0]);
  });

  it.each([1, 2, 3, 4, 5, 7])('a project with %i repos stays in ONE district — its agents are never split across the map', (n) => {
    const repos = Array.from({ length: n }, (_, i) => `/c/repo${i}`);
    // Alone on the map (spare districts all around it) and with a neighbour: the same answer.
    for (const projects of [[project(0, repos)], [project(0, repos), project(1, ['/z'])]]) {
      const z = planZones(projects, OUTPOST)[0];
      expect(z.districts, `${n} repos, ${projects.length} project(s)`).toHaveLength(1);
      const mine = OUTPOST.structures.filter((s) => s.building && s.district === z.districts[0]).map((s) => s.id);
      // Every repo has a building, in that district; repos share buildings only once there are more repos than buildings.
      for (const r of repos) expect(mine).toContain(z.buildings.get(normRepo(r)));
      expect(new Set(z.buildings.values()).size).toBe(Math.min(n, mine.length));
      // …and every agent of the project is placed inside that district.
      const wants = repos.map((r, i) => ({ key: `m:${i}`, pool: zoneFor([z], r)!.building }));
      const placed = placeByZone(new Map(), wants, OUTPOST, new Set(z.districts));
      for (const w of wants) expect(OUTPOST.sites.find((s) => s.id === placed.spots.get(w.key)!.siteId)!.district, w.key).toBe(z.districts[0]);
    }
    // Adding a project never moves an existing one.
    expect(planZones([project(0, repos), project(1, ['/z'])], OUTPOST)[0].districts).toEqual(planZones([project(0, repos)], OUTPOST)[0].districts);
  });

  it('finds an agent\'s building from its repo path, however the path is written', () => {
    const zones = planZones([project(0, ['/Users/me/code/App/'])], OUTPOST);
    for (const path of ['/Users/me/code/App', '/users/me/code/app/', '\\Users\\me\\code\\App']) {
      expect(zoneFor(zones, path)?.building, path).toBe(zones[0].buildings.get(normRepo('/Users/me/code/App')));
    }
    expect(zoneFor(zones, '/Users/me/code/other')).toBeNull();
    expect(zoneFor(zones, '/tmp/scratch/App')).toBeNull();
  });

  it('agents stand at their own repo\'s building; the rest keep off claimed land; nobody moves when someone else arrives', () => {
    const zones = planZones([project(0, ['/c/a', '/c/b'])], OUTPOST);
    const claimed = new Set(zones.flatMap((z) => z.districts));
    const wants = [
      { key: 'm:a', pool: zoneFor(zones, '/c/a')!.building },
      { key: 'm:a2', pool: zoneFor(zones, '/c/a')!.building },
      { key: 'm:b', pool: zoneFor(zones, '/c/b')!.building },
      ...Array.from({ length: 9 }, (_, i) => ({ key: `m:free${i}`, pool: OPEN_POOL })),
    ];
    const first = placeByZone(new Map(), wants, OUTPOST, claimed);
    const siteOf = (key: string) => OUTPOST.sites.find((s) => s.id === first.spots.get(key)!.siteId)!;
    expect(siteOf('m:a').at).toBe(wants[0].pool);
    expect(siteOf('m:a2').at).toBe(wants[0].pool);
    expect(siteOf('m:b').at).toBe(wants[2].pool);
    for (let i = 0; i < 9; i++) expect(claimed.has(siteOf(`m:free${i}`).district ?? ''), `free${i} is on claimed land`).toBe(false);
    // Nobody shares an exact spot.
    const spots = [...first.spots.values()].map((s) => `${s.x.toFixed(4)},${s.y.toFixed(4)}`);
    expect(new Set(spots).size).toBe(spots.length);
    // Sticky: a newcomer and a leaver move nobody else.
    const later = placeByZone(first.slots, [...wants.slice(1), { key: 'm:new', pool: OPEN_POOL }], OUTPOST, claimed);
    for (const w of wants.slice(1)) expect(later.spots.get(w.key)).toEqual(first.spots.get(w.key));
    // With no projects at all, the whole map is open — the same order as before.
    const open = placeByZone(new Map(), [{ key: 'x', pool: OPEN_POOL }], OUTPOST, new Set());
    expect(open.spots.get('x')!.siteId).toBe(OUTPOST.sites[0].id);
  });
});

describe('fleet', () => {
  const pads = OUTPOST.structures.filter((s) => s.sprite === 'pad').map((s) => s.id);
  it('gives each online machine a pad, matches agents to runner machines by host name, and keeps pads sticky', () => {
    expect(hostKey('Mannys-Mac-Pro.local')).toBe(hostKey('mannys-mac-pro'));
    const machines = [{ hostname: 'DESKTOP', status: 'offline' as const }, { hostname: 'Laptop.local', status: 'offline' as const }, { hostname: 'Mac-Pro', status: 'online' as const }];
    const a = padsFor(new Map(), machines, ['Mac-Pro.local'], pads);
    expect(a.pads).toHaveLength(pads.length);
    // The online machine is on the first pad; an offline one is named on the other, with no shuttle.
    expect(a.pads[0]).toMatchObject({ pad: pads[0], host: 'Mac-Pro', online: true });
    expect(a.pads[1].online).toBe(false);
    expect(a.pads[1].host).toBeTruthy();
    // A machine known only from its agents counts as online.
    const b = padsFor(a.slots, machines, ['Mac-Pro.local', 'cloud-box'], pads);
    expect(b.pads[0]).toMatchObject({ host: 'Mac-Pro', online: true });
    expect(b.pads[1]).toMatchObject({ host: 'cloud-box', online: true });
    // The first machine going offline does not move the second one's shuttle.
    const c = padsFor(b.slots, [{ hostname: 'Mac-Pro', status: 'offline' }], ['cloud-box'], pads);
    expect(c.pads[1]).toMatchObject({ host: 'cloud-box', online: true });
    expect(c.pads[0].online).toBe(false);
    // Nothing known: empty pads.
    expect(padsFor(new Map(), [], [], pads).pads.every((p) => p.host === null && !p.online)).toBe(true);
  });
});

describe('meeting', () => {
  it('only RUNNING confers gather their participants, for every confer status', () => {
    const crew = [{ key: 'm:a', agentIds: ['a1', 'a2'] }, { key: 'm:b', agentIds: ['b1'] }, { key: 'm:c', agentIds: ['c1'] }];
    for (const status of ['running', 'completed', 'failed', 'cancelled'] as const) {
      const keys = meetingKeys([{ status, participantIds: ['a2', 'b1'] }], crew);
      expect(keys, status).toEqual(status === 'running' ? ['m:a', 'm:b'] : []);
    }
    // A confer of one is not a gathering.
    expect(meetingKeys([{ status: 'running', participantIds: ['c1'] }], crew)).toEqual([]);
  });
});
