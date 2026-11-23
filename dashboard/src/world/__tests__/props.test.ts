/**
 * THE PROPS — each one is a fact from the records, for every value that fact can take.
 */
import { describe, it, expect } from 'vitest';
import {
  STATUE_AFTER_MS, settledDeliveries, FREIGHT, freightFor, freightTitle, featuresToDo,
  BENCH_AFTER_MS, benchSeats, pipelineSignal, WORK_CYCLES, WORK_SWITCH_MS, workCycleAt, nextWorkSwitch,
} from '../props';
import { ANIMATION_NAMES } from '../anim';
import { KIT } from '../kit';
import { packFor } from '../theme';
import { THEMES } from '../theme';
import { planZones, planCamps, planAnnexes, buildingFor, placeByZone, zoneFor, CAMP_PREFIX, OPEN_POOL, POD_CAPACITY, normRepo } from '../zones';
import { PLATES } from '../sites';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('the statue', () => {
  it('counts only features of THIS project, delivered, planned here, for a day or more', () => {
    const f = (over: object) => ({ projectId: 'p', status: 'achieved', origin: 'planned', doneAt: ago(STATUE_AFTER_MS), ...over }) as never;
    const cases: [object, number][] = [
      [{}, 1],
      [{ doneAt: ago(STATUE_AFTER_MS - 1000) }, 0],        // not a day yet
      [{ doneAt: ago(STATUE_AFTER_MS * 30) }, 1],
      [{ status: 'active' }, 0],                            // not delivered
      [{ origin: 'imported' }, 0],                          // documented, never built here
      [{ projectId: 'other' }, 0],
      [{ doneAt: null }, 0], [{ doneAt: '' }, 0], [{ doneAt: 'not a date' }, 0],
    ];
    for (const [over, want] of cases) expect(settledDeliveries([f(over)], 'p', NOW), JSON.stringify(over)).toBe(want);
    expect(settledDeliveries(cases.map(([o]) => f(o)), 'p', NOW)).toBe(2);
    expect(settledDeliveries([], 'p', NOW)).toBe(0);
  });
});

describe('the freight', () => {
  it('one look for every count of features left, 0 to 50', () => {
    for (let n = 0; n <= 50; n++) {
      expect(freightFor(n), String(n)).toBe(n === 0 ? 'crate-open' : n === 1 ? 'crate-glow' : n <= 3 ? 'cart-1' : 'cart-3');
    }
    expect(freightFor(-2)).toBe('crate-open');
    expect(new Set(Array.from({ length: 51 }, (_, n) => freightFor(n)))).toEqual(new Set(FREIGHT));
  });
  it('what is left is planned minus delivered, never below nothing; and the hover says which', () => {
    expect(featuresToDo({ total: 5, done: 2 })).toBe(3);
    expect(featuresToDo({ total: 2, done: 2 })).toBe(0);
    expect(featuresToDo({ total: 0, done: 0 })).toBe(0);
    expect(featuresToDo({ total: 1, done: 3 })).toBe(0);
    expect(freightTitle(0, 0)).toBe('No features planned');
    expect(freightTitle(0, 4)).toBe('All 4 features delivered');
    expect(freightTitle(1, 4)).toBe('1 feature to deliver');
    expect(freightTitle(3, 4)).toBe('3 features to deliver');
  });
  it.each(THEMES)('%s: every prop the map places is drawn art in that pack', (theme) => {
    const kit = packFor(theme).kit;
    for (const name of [...FREIGHT, 'statue', 'fountain', 'bench'] as const) {
      expect(kit[name], `${theme}/${name}`).toBeTruthy();
      expect(kit[name].src).toMatch(/\.png$/);
    }
    expect(KIT.statue).toBeTruthy();
  });
});

describe('the bench', () => {
  const idle = (key: string, minutes: number) => ({ key, since: NOW - minutes * 60_000 });
  it('nobody sits before 30 minutes idle; at 30 they do', () => {
    for (let m = 0; m <= 60; m++) {
      expect([...benchSeats(new Map(), [idle('a', m)], NOW, 2).keys()], `${m} min`).toEqual(m * 60_000 >= BENCH_AFTER_MS ? ['a'] : []);
    }
  });
  it('two seats: the longest idle take them, the third stays standing, and nobody is shuffled along', () => {
    const three = [idle('a', 40), idle('b', 90), idle('c', 60)];
    const first = benchSeats(new Map(), three, NOW, 2);
    expect(first).toEqual(new Map([['b', 0], ['c', 1]]));
    // b goes back to work: c keeps its seat, a takes the free one.
    const second = benchSeats(first, [idle('a', 41), idle('c', 61)], NOW, 2);
    expect(second).toEqual(new Map([['c', 1], ['a', 0]]));
    // Every count of seats, every size of crowd: never more sitters than seats, never two on a seat.
    for (let seats = 0; seats <= 4; seats++) for (let n = 0; n <= 6; n++) {
      const got = benchSeats(new Map(), Array.from({ length: n }, (_, i) => idle(`k${i}`, 31 + i)), NOW, seats);
      expect(got.size, `${n} idle, ${seats} seats`).toBe(Math.min(n, seats));
      expect(new Set(got.values()).size).toBe(got.size);
      for (const seat of got.values()) expect(seat).toBeLessThan(seats);
    }
  });
});

describe('the work cycles', () => {
  it('are four drawn rows of every sheet', () => {
    expect([...WORK_CYCLES]).toEqual(['kneel', 'repair', 'tend', 'work']);
    for (const c of WORK_CYCLES) expect(ANIMATION_NAMES).toContain(c);
  });
  it('each agent changes every 40–90 seconds, always to a different cycle, and plays all four', () => {
    for (const key of ['mac:api', 'mac:web', 'studio:neoncore', 'a', 'zz:long-name-of-a-repo', 'mac:backend-interlag']) {
      const changes: number[] = [];
      const seen = new Set<string>();
      let last = workCycleAt(key, NOW);
      let since = NOW;
      for (let t = NOW; t < NOW + 30 * 60_000; t += 500) {
        const c = workCycleAt(key, t);
        seen.add(c);
        if (c !== last) { changes.push(t - since); since = t; last = c; }
      }
      expect(changes.length, key).toBeGreaterThan(15);
      // The first stretch started before NOW, so it may be short; every full one is 40–90 s.
      for (const gap of changes.slice(1)) {
        expect(gap, key).toBeGreaterThanOrEqual(WORK_SWITCH_MS.min - 500);
        expect(gap, key).toBeLessThanOrEqual(WORK_SWITCH_MS.max + 500);
      }
      expect([...seen].sort(), key).toEqual([...WORK_CYCLES].sort());
      // The timer the figure sets lands on the change.
      const wait = nextWorkSwitch(key, NOW);
      expect(wait).toBeGreaterThan(0);
      expect(workCycleAt(key, NOW + wait - 1)).toBe(workCycleAt(key, NOW));
      expect(workCycleAt(key, NOW + wait)).not.toBe(workCycleAt(key, NOW));
    }
  });
  it('the crew does not change all at once', () => {
    const waits = new Set(['mac:a', 'mac:b', 'mac:c', 'mac:d', 'mac:e', 'mac:f'].map((k) => nextWorkSwitch(k, NOW)));
    expect(waits.size).toBeGreaterThan(3);
  });
});

describe('a project past the map\'s districts', () => {
  const project = (i: number) => ({ id: `p${i}`, name: `P${i}`, color: '', primaryRepo: `/r/p${i}-a`, cartridges: [`/r/p${i}-a`, `/r/p${i}-b`], createdAt: `2026-01-0${i + 1}`, featureCount: 0, featuresDone: 0, featuresActive: 0 });
  it.each(PLATES.map((plate) => ({ name: plate.id, plate })))('$name: its agents stand together at one spot, each such project at its own, nobody in a pod that is not theirs', ({ plate }) => {
    // Three projects more than the map has pods (four, or six on the isles): three camps.
    const size = plate.districts.filter((d) => d.x !== undefined).length;
    const projects = Array.from({ length: size + 3 }, (_, i) => project(i));
    const zones = planZones(projects, plate);
    const camps = planCamps(projects, zones);
    const pods = zones.length;
    expect(pods).toBe(size);
    // Every repo of every project is somewhere: in a pod, or in a camp — never both, never neither.
    for (const p of projects) for (const repo of p.cartridges) {
      const zoned = zoneFor(zones, repo) !== null;
      expect(zoned !== camps.has(normRepo(repo)), repo).toBe(true);
    }
    expect(new Set(camps.values())).toEqual(new Set([`${CAMP_PREFIX}0`, `${CAMP_PREFIX}1`, `${CAMP_PREFIX}2`]));
    const wants = [
      ...projects.flatMap((p) => p.cartridges.map((repo, n) => ({ key: `m:${p.id}-${n}`, pool: zoneFor(zones, repo)?.building ?? camps.get(normRepo(repo))! }))),
      { key: 'm:stray', pool: OPEN_POOL },
    ];
    const claimed = new Set(zones.flatMap((z) => z.districts));
    const { spots } = placeByZone(new Map(), wants, plate, claimed);
    const campSite = new Map<string, string>();
    for (const p of projects.slice(pods)) {
      const mine = p.cartridges.map((_, n) => spots.get(`m:${p.id}-${n}`)!);
      // Together: the same spot's surroundings, a short walk apart.
      expect(new Set(mine.map((s) => s.siteId)).size, p.id).toBe(1);
      expect(Math.hypot((mine[0].x - mine[1].x) * plate.width, (mine[0].y - mine[1].y) * plate.height), p.id).toBeLessThan(90);
      expect(Math.hypot(mine[0].x - mine[1].x, mine[0].y - mine[1].y), `${p.id} share a spot`).toBeGreaterThan(0.01);
      const site = plate.sites.find((s) => s.id === mine[0].siteId)!;
      expect(site.district === undefined || !claimed.has(site.district), `${p.id} camps on claimed land`).toBe(true);
      campSite.set(p.id, site.id);
    }
    // A camp each, in the order they are meant to fill.
    expect([...campSite.values()]).toEqual(['road', 'pond-east', 'pond']);
  });
});

describe('the marker under a signpost', () => {
  const pilot = (phase: string, over: object = {}) => ({ phase, stagesDone: 1, stagesTotal: 4, awaitingReview: false, awaitingReply: false, ...over });
  const f = (id: string, over: object) => ({ id, name: `F ${id}`, projectId: 'p', status: 'active', origin: 'planned', health: null, pilot: null, ...over }) as never;
  // Every place a feature can be, and what the feature list says about it (lib/featureStatus.ts).
  const CASES: [string, object][] = [
    ['backlog', {}],
    ['done', { status: 'achieved', pilot: pilot('completed') }],
    ['cancelled', { pilot: pilot('cancelled') }],
    ['scoping', { pilot: pilot('scoping') }],
    ['planning', { pilot: pilot('planning') }],
    ['clarifying', { pilot: pilot('clarifying') }],
    ['proposed', { pilot: pilot('proposed') }],
    ['staffing', { pilot: pilot('staffing') }],
    ['running', { pilot: pilot('running') }],
    ['review', { pilot: pilot('running', { awaitingReview: true }) }],
    ['paused', { pilot: pilot('paused') }],
    ['completed', { pilot: pilot('completed') }],
  ];
  it('agrees with the feature list for every place a feature can be: none outside a pipeline, yellow when it waits on you, green otherwise', async () => {
    const { featureStatus } = await import('../../lib/featureStatus');
    const tones = new Set<string>();
    for (const [name, over] of CASES) {
      const feature = f(name, over);
      const st = featureStatus(feature);
      const signal = pipelineSignal([feature], 'p');
      const outside = ['backlog', 'cancelled', 'done'].includes(st.key);
      expect(signal === null, name).toBe(outside);
      if (signal) {
        expect(signal.tone, name).toBe(st.needsYou ? 'yellow' : 'green');
        expect(signal.features).toEqual([{ id: name, name: `F ${name}`, label: st.label, needsYou: st.needsYou }]);
        tones.add(signal.tone);
      }
    }
    expect(tones).toEqual(new Set(['yellow', 'green']));
  });
  it('one feature waiting on you turns the whole pod yellow, and is listed first; other projects and imported features do not count', () => {
    const all = [f('run', { pilot: pilot('running') }), f('plan', { pilot: pilot('proposed') }), f('other', { projectId: 'q', pilot: pilot('paused') }), f('old', { origin: 'imported', pilot: pilot('paused') })];
    const s = pipelineSignal(all, 'p')!;
    expect(s.tone).toBe('yellow');
    expect(s.features.map((x) => x.id)).toEqual(['plan', 'run']);
    expect(pipelineSignal([all[0]], 'p')!.tone).toBe('green');
    expect(pipelineSignal(all, 'nobody')).toBeNull();
    expect(pipelineSignal([], 'p')).toBeNull();
  });
});

describe('a pod holds four', () => {
  const project = (i: number, repos = 4) => ({ id: `p${i}`, name: `P${i}`, color: '', primaryRepo: `/r/p${i}-0`, cartridges: Array.from({ length: repos }, (_, n) => `/r/p${i}-${n}`), createdAt: `2026-01-0${i + 1}`, featureCount: 0, featuresDone: 0, featuresActive: 0 });
  it.each(PLATES.map((plate) => ({ name: plate.id, plate })))('$name: a project takes one more pod for every four agents past the first four — for every crowd from 0 to 20, while districts last', ({ plate }) => {
    const zones = planZones([project(0), project(1)], plate);
    const size = plate.districts.filter((d) => d.x !== undefined).length;
    const spare = size - 2;
    for (let n = 0; n <= 20; n++) {
      const annexes = planAnnexes(zones, plate, new Map([['p0', n]]));
      const want = Math.min(spare, Math.max(0, Math.ceil(n / POD_CAPACITY) - 1));       // every district but the two held
      expect((annexes.get('p0') ?? []).length, `${n} agents`).toBe(want);
      // Never a district another project holds, never the same one twice.
      const taken = annexes.get('p0') ?? [];
      expect(new Set(taken).size).toBe(taken.length);
      for (const d of taken) expect(zones.some((z) => z.districts.includes(d)), d).toBe(false);
    }
    // The spare pods go to the oldest project first, whoever is busiest.
    const both = planAnnexes(zones, plate, new Map([['p0', 5], ['p1', 20]]));
    expect(both.get('p0')).toHaveLength(1);
    // …and the next project takes what is left of what it needs (four more pods for twenty agents).
    expect(both.get('p1')).toHaveLength(Math.min(4, spare - 1));
    // No free district: nobody gets one.
    const full = planZones(Array.from({ length: size }, (_, i) => project(i)), plate);
    expect(planAnnexes(full, plate, new Map([['p0', 12]])).size).toBe(0);
  });

  it.each(PLATES.map((plate) => ({ name: plate.id, plate })))('$name: places 0–3 work in the home pod at their own repo, 4–7 in the second pod — no pod ever holds more than four while there is room', ({ plate }) => {
    const zones = planZones([project(0)], plate);
    const zone = zones[0];
    const annexes = planAnnexes(zones, plate, new Map([['p0', 8]])).get('p0')!;
    expect(annexes).toHaveLength(1);
    const perPod = new Map<string, number>();
    for (let place = 0; place < 8; place++) {
      const repo = normRepo(`/r/p0-${place % 4}`);
      const home = zone.buildings.get(repo)!;
      const at = buildingFor(plate, zone, home, place, annexes);
      expect(at.district, `place ${place}`).toBe(place < POD_CAPACITY ? zone.districts[0] : annexes[0]);
      if (place < POD_CAPACITY) expect(at.building).toBe(home);
      // The building is really in that pod.
      expect(plate.structures.find((s) => s.id === at.building)!.district).toBe(at.district);
      perPod.set(at.district, (perPod.get(at.district) ?? 0) + 1);
    }
    expect([...perPod.values()]).toEqual([4, 4]);
    // No second pod to be had: everyone stays home, at their own building.
    for (let place = 0; place < 8; place++) expect(buildingFor(plate, zone, 'x', place, []).district).toBe(zone.districts[0]);
    // Twelve agents and one annex: the third four share the two pods rather than pile into one.
    expect(buildingFor(plate, zone, zone.buildings.get(normRepo('/r/p0-0'))!, 8, annexes).district).toBe(zone.districts[0]);
  });
});
