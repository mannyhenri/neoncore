import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PilotCandidateRepo, RoadmapEpic, SpecFeature } from '@neoncore/client';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { NEEDS, stepsEarned, BADGES, columnsOf, waitsOnEpicQa, epicDate, pickPlanner, defaultStaffing, captainArt, badgeUrl } = await import('../work');

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * THE PHONE'S WORK RULES — the same ones the dashboard and the server use, restated where the
 * phone cannot import them at runtime, and pinned here so they cannot drift.
 */
describe('needs you', () => {
  const union = (() => {
    const src = read('packages/client/src/types.ts');
    const at = src.indexOf('export type NeedsYouKind');
    return [...src.slice(at, src.indexOf(';', at)).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  })();

  it('names every kind the server can send (client NeedsYouKind)', () => {
    expect(union.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(NEEDS).sort()).toEqual([...union].sort());
  });

  it('acts on every kind it offers an action for, on the home screen and the feature', () => {
    const home = read('mobile/src/screens/NeedsYouScreen.tsx');
    const feature = read('mobile/src/screens/FeatureScreen.tsx');
    for (const [kind, meta] of Object.entries(NEEDS)) {
      if (!meta.action) continue;
      expect(home, `Needs you does nothing for '${kind}'`).toContain(`'${kind}'`);
      if (kind !== 'questions' && kind !== 'start') expect(feature, `the feature does nothing for '${kind}'`).toContain(`case '${kind}'`);
    }
  });

  it('calls only routes the server has', () => {
    const work = read('mobile/src/work.ts');
    const pilots = read('server/src/routes/goal-pilots.ts');
    const suffixes = [...work.matchAll(/goal-pilots\/\$\{pilotId\}\/([a-z/-]+)`/g)].map((m) => m[1]);
    expect(suffixes.length).toBeGreaterThanOrEqual(6);
    for (const s of suffixes) expect(pilots, `no route /:id/${s}`).toContain(`'/:id/${s}'`);
    for (const s of ['/meta', '/candidates', '/active']) expect(pilots).toContain(`'${s}'`);
    expect(read('server/src/routes/roadmap.ts')).toContain("'/epics/:epicId'");
    expect(read('server/src/index.ts')).toContain("'/api/needs-you'");
  });
});

describe('badges', () => {
  it('earns them as the pipeline passes each step, all seven when done', () => {
    expect(BADGES).toHaveLength(7);
    expect(stepsEarned('scoping')).toBe(0);
    expect(stepsEarned('proposed')).toBe(3);
    expect(stepsEarned('running')).toBe(5);
    expect(stepsEarned('paused')).toBe(5);
    expect(stepsEarned('completed')).toBe(6);
    expect(stepsEarned('completed', true)).toBe(7);
    expect(stepsEarned('anything-new')).toBe(0);
  });

  it('draws them and the captain from the server', () => {
    expect(badgeUrl('http://mac:4040', BADGES[0].sprite)).toMatch(/^http:\/\/mac:4040\/world\/kit\/.+\.png$/);
    expect(captainArt('http://mac:4040', 'commander')?.source).toEqual({ uri: 'http://mac:4040/world/bridge/captain-commander.png' });
    expect(captainArt('http://mac:4040', 'no-such-rank')?.source).toEqual({ uri: 'http://mac:4040/world/bridge/captain.png' });
  });
});

const feat = (over: Partial<SpecFeature>): SpecFeature => ({ id: 'f', name: 'F', status: 'planned', column: 'todo', completedAt: null, ...over } as SpecFeature);

describe('the Board', () => {
  it('places features as the server says: To do · In Progress · QA · Done', () => {
    const cols = columnsOf([
      feat({ id: 'a', column: 'todo' }), feat({ id: 'b', column: 'progress' }), feat({ id: 'c', column: 'qa' }),
      feat({ id: 'd', column: 'done', completedAt: '2026-11-01' }), feat({ id: 'e', column: 'done', completedAt: '2026-11-20' }),
      feat({ id: 'x', column: null }),
    ]);
    expect(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.map((f) => f.id)]))).toEqual({ todo: ['a'], progress: ['b'], qa: ['c'], done: ['e', 'd'] });
  });

  it('reads an older server\'s columns', () => {
    const cols = columnsOf([feat({ id: 'n', column: 'now' as never }), feat({ id: 'l', column: 'later' as never })]);
    expect(cols.progress.map((f) => f.id)).toEqual(['n']);
    expect(cols.todo.map((f) => f.id)).toEqual(['l']);
  });

  it('keeps a done feature in QA until its epic passes QA', () => {
    expect(waitsOnEpicQa(feat({ status: 'done', epicQa: 'waiting' }))).toBe(true);
    expect(waitsOnEpicQa(feat({ status: 'done', epicQa: 'open' }))).toBe(true);
    expect(waitsOnEpicQa(feat({ status: 'done', epicQa: 'passed' }))).toBe(false);
    expect(waitsOnEpicQa(feat({ status: 'delivered', epicQa: 'waiting' }))).toBe(false);
  });
});

describe('the Route', () => {
  const epic = (over: Partial<RoadmapEpic>): RoadmapEpic => ({ id: 'e', name: 'E', targetDate: '2026-12-01', deliveredAt: null, ...over } as RoadmapEpic);
  it('says when an epic is due, late, delivered, or delivered on time', () => {
    expect(epicDate(epic({}), '2026-11-23')).toEqual({ text: 'Due Dec 1', tone: 'due' });
    expect(epicDate(epic({ late: true }), '2026-12-05')).toEqual({ text: 'Late · was due Dec 1', tone: 'late' });
    expect(epicDate(epic({ targetDate: '2026-11-01' }), '2026-11-23')?.tone).toBe('late');
    expect(epicDate(epic({ deliveredAt: '2026-11-30T10:00:00Z', onTime: true }), '2026-12-05')).toEqual({ text: 'On time · due Dec 1', tone: 'commend' });
    expect(epicDate(epic({ deliveredAt: '2026-12-03T10:00:00Z', onTime: false }), '2026-12-05')).toEqual({ text: 'Delivered Dec 3', tone: 'done' });
    expect(epicDate(epic({ targetDate: '' }), '2026-11-23')).toBeNull();
  });
});

describe('starting work from the phone', () => {
  const agent = (id: string, over: Record<string, string> = {}) => ({ id, status: 'idle', agentType: 'claude', repoPath: '/r/other', mode: 'auto', lastSeen: '2026-11-01', ...over });

  it('picks a live planner in the project\'s own repos, Claude first', () => {
    const agents = [
      agent('far'), agent('off', { repoPath: '/r/app', status: 'offline' }),
      agent('codex', { repoPath: '/r/app', agentType: 'codex' }), agent('mine', { repoPath: '/R/app/' }),
    ];
    expect(pickPlanner(agents, ['/r/app'])?.id).toBe('mine');
    expect(pickPlanner([agent('off', { status: 'offline' })], ['/r/app'])).toBeNull();
  });

  it('staffs the feature\'s repos (else the project\'s), each with a live engine, Claude first', () => {
    const c = (repoPath: string, owned: boolean, engines: [string, string][]): PilotCandidateRepo =>
      ({ repoPath, repoName: repoPath, machine: 'm', owned, engines: engines.map(([agentType, status]) => ({ agentType, status, agentId: agentType, name: agentType })) });
    const cands = [c('/r/app', true, [['codex', 'idle'], ['claude', 'offline']]), c('/r/api', true, [['claude', 'idle']]), c('/r/x', false, [['claude', 'idle']])];
    expect(defaultStaffing(cands)).toEqual([{ repoPath: '/r/app', agentType: 'codex' }, { repoPath: '/r/api', agentType: 'claude' }]);
    expect(defaultStaffing(cands, ['/r/api'])).toEqual([{ repoPath: '/r/api', agentType: 'claude' }]);
  });
});
