import { describe, it, expect } from 'vitest';
import { PLATES, OUTPOST } from '../sites';
import { planZones, zoneFor, placeByZone, normRepo, OPEN_POOL, planSectors, sectorByRepo, sectorSize, districtsNeeded, planAnnexes } from '../zones';
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
  // The assignment logic over any number of pads (the map has one — oneDock.test.ts).
  const pads = ['pad-a', 'pad-b'];
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
    // Participants who all work in the SAME pod are already together: they stay in it.
    const pods = [{ key: 'm:a', agentIds: ['a1'], pod: 'nw' }, { key: 'm:b', agentIds: ['b1'], pod: 'nw' }, { key: 'm:c', agentIds: ['c1'], pod: 'sw' }, { key: 'm:d', agentIds: ['d1'] }];
    expect(meetingKeys([{ status: 'running', participantIds: ['a1', 'b1'] }], pods), 'one pod').toEqual([]);
    // Across two pods, or with an agent of no project, they meet at the table — all of them.
    expect(meetingKeys([{ status: 'running', participantIds: ['a1', 'b1', 'c1'] }], pods)).toEqual(['m:a', 'm:b', 'm:c']);
    expect(meetingKeys([{ status: 'running', participantIds: ['a1', 'd1'] }], pods)).toEqual(['m:a', 'm:d']);
    // Two confers at once, one in a pod and one across pods: only the second gathers.
    expect(meetingKeys([{ status: 'running', participantIds: ['a1', 'b1'] }, { status: 'running', participantIds: ['c1', 'd1'] }], pods)).toEqual(['m:c', 'm:d']);
    // A confer of one is not a gathering.
    expect(meetingKeys([{ status: 'running', participantIds: ['c1'] }], crew)).toEqual([]);
  });
});

describe('sectors — the world again for every further handful of projects', () => {
  it.each(Object.values(PLATES).map((plate) => ({ name: plate.id, plate })))('$name: every project has a district of its own, for 0 to 13 projects', ({ plate }) => {
    const size = sectorSize(plate);
    // One sector holds a project per pod: four, or six on the isles.
    expect(size).toBe(plate.districts.filter((d) => d.x !== undefined).length);
    for (let count = 0; count <= 13; count++) {
      const projects = Array.from({ length: count }, (_, i) => project(i, [`/code/repo-${i}`], { createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
      const sectors = planSectors(projects, plate);
      expect(sectors.length, `${count} projects`).toBe(Math.max(1, Math.ceil(count / size)));
      expect(sectors.map((s) => s.index)).toEqual(sectors.map((_, i) => i));
      // Every project is in exactly one sector, oldest first, and no sector is over-full.
      expect(sectors.flatMap((s) => s.projects.map((p) => p.id))).toEqual(projects.map((p) => p.id));
      for (const s of sectors) {
        expect(s.projects.length).toBeLessThanOrEqual(size);
        // In its sector EVERY project gets a zone — none is left without a district.
        const zones = planZones(s.projects, plate);
        expect(zones.map((z) => z.projectId), `sector ${s.index} of ${count}`).toEqual(s.projects.map((p) => p.id));
        expect(new Set(zones.map((z) => z.districts[0])).size).toBe(zones.length);
      }
    }
  });

  it('adding a project never moves one that is already there: it fills the last sector or starts the next', () => {
    const five = Array.from({ length: 5 }, (_, i) => project(i, [`/code/repo-${i}`]));
    const before = planSectors(five, OUTPOST);
    const after = planSectors([project(5, ['/code/repo-5']), ...five], OUTPOST);   // given in another order
    expect(after.slice(0, 1)).toEqual(before.slice(0, 1));
    expect(after[1].projects.map((p) => p.id)).toEqual([...before[1].projects.map((p) => p.id), project(5, []).id]);
    for (const s of before) for (const p of s.projects) {
      const now = after.find((x) => x.projects.some((q) => q.id === p.id))!;
      expect(now.index).toBe(s.index);
      expect(planZones(now.projects, OUTPOST).find((z) => z.projectId === p.id)!.districts).toEqual(planZones(s.projects, OUTPOST).find((z) => z.projectId === p.id)!.districts);
    }
  });

  it('a repo is in its project\'s sector — every repo of the project, however the path is written; an unowned repo is in none', () => {
    const projects = Array.from({ length: 6 }, (_, i) => project(i, [`/code/repo-${i}`, `/code/extra-${i}`]));
    const by = sectorByRepo(planSectors(projects, OUTPOST));
    projects.forEach((_, i) => {
      expect(by.get(normRepo(`/code/repo-${i}`))).toBe(Math.floor(i / 4));
      expect(by.get(normRepo(`/Code/Extra-${i}/`))).toBe(Math.floor(i / 4));
    });
    expect(by.get(normRepo('/code/nobody'))).toBeUndefined();
    // A repo two projects name belongs to the older one.
    const shared = sectorByRepo(planSectors([...projects.slice(0, 4), project(4, ['/code/repo-0', '/code/repo-4'])], OUTPOST));
    expect([shared.get('/code/repo-0'), shared.get('/code/repo-4')]).toEqual([0, 1]);
  });
});

describe('sectors keep room for a project with many repos', () => {
  const withRepos = (i: number, n: number) => project(i, Array.from({ length: n }, (_, k) => `/code/p${i}-r${k}`), { createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` });

  it('a project needs a district per two repos (two agents a repo while a feature is built), never more than the sector has', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => districtsNeeded(withRepos(0, n), 4))).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  });

  it.each([
    { repos: [4, 2, 1, 0, 1], sectors: [['p0', 'p1', 'p2'], ['p3', 'p4']] },       // the reported case: four repos, eight agents
    { repos: [1, 1, 1, 1, 1], sectors: [['p0', 'p1', 'p2', 'p3'], ['p4']] },
    { repos: [3, 3, 1], sectors: [['p0', 'p1'], ['p2']] },
    { repos: [1, 1, 1, 4], sectors: [['p0', 'p1', 'p2'], ['p3']] },                // it does not fit what is left: next sector, order kept
    { repos: [8, 1], sectors: [['p0'], ['p1']] },
    { repos: [], sectors: [[]] },
  ])('repos $repos → $sectors', ({ repos, sectors }) => {
    const projects = repos.map((n, i) => withRepos(i, n));
    const planned = planSectors(projects, OUTPOST);
    expect(planned.map((s) => s.projects.map((p) => p.id))).toEqual(sectors);
    for (const s of planned) {
      // The sector never promises more districts than the world has…
      const need = s.projects.reduce((n, p) => n + districtsNeeded(p, 4), 0);
      expect(need).toBeLessThanOrEqual(4);
      // …so a project that fills both its pods gets its second district in the SAME sector.
      const zones = planZones(s.projects, OUTPOST);
      const crowd = new Map(s.projects.map((p) => [p.id, [...new Set([...(p.cartridges as string[])])].length * 2]));
      const annexes = planAnnexes(zones, OUTPOST, crowd);
      for (const p of s.projects) expect(1 + (annexes.get(p.id)?.length ?? 0), `${p.id} in sector ${s.index}`).toBeGreaterThanOrEqual(Math.ceil((crowd.get(p.id) ?? 0) / 4) || 1);
    }
  });
});
