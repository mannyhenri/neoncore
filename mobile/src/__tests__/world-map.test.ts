import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildMap, emptyMemory, walkMs, PLATE, FIGURE_SHARE, type MapProject } from '../world/mapLogic';
import type { Agent, PermissionRequest } from '../types';

/**
 * THE AGENTS MAP ON THE PHONE shows what the dashboard's map shows: every live agent, at its
 * project's pod, in the one look its state has — and only art that is actually in the bundle.
 */
const ROOT = path.join(import.meta.dirname, '..', '..');
const GEN = fs.readFileSync(path.join(ROOT, 'src/world/art.generated.ts'), 'utf8');
const NOW = Date.now();
const STATUSES = ['working', 'waiting', 'idle'] as const;

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, machine: 'm1', repoPath: `/code/${id}`, repoName: id, branch: 'main', currentTask: '', status: 'idle',
  agentType: 'claude', lastSeen: new Date(NOW).toISOString(), sessionId: 's', lastMessage: '', pendingQuestion: '', dismissedAt: '',
  ...over,
} as unknown as Agent);
const project = (id: string, repos: string[], over: Partial<MapProject> = {}): MapProject => ({
  id, name: id, color: '', primaryRepo: repos[0], cartridges: repos, createdAt: `2026-01-0${id.length}`, featureCount: 3, featuresDone: 1, featuresActive: 0, ...over,
} as MapProject);
const build = (agents: Agent[], projects: MapProject[] = [], permissions: PermissionRequest[] = [], memory = emptyMemory()) =>
  buildMap({ agents, permissions, projects, now: NOW }, memory);
const districtOf = (siteId: string) => PLATE.sites.find((s) => s.id === siteId)?.district;

describe('the agents map', () => {
  it.each(STATUSES)('a %s agent of a project stands in its project\'s pod, at its repo\'s building; one of no project keeps off claimed land', (status) => {
    const scene = build(
      [agent('gl-dev', { status }), agent('gl-mgr', { status }), agent('loner', { status })],
      [project('gridlight', ['/code/gl-dev', '/code/gl-mgr'])],
    );
    expect(scene.figures.map((f) => f.key).sort()).toEqual(['m1:gl-dev', 'm1:gl-mgr', 'm1:loner']);
    const pod = PLATE.districts.find((d) => PLATE.structures.some((s) => s.building && s.district === d.id))!.id;
    const at = (key: string) => scene.figures.find((f) => f.key === key)!;
    expect(districtOf(at('m1:gl-dev').siteId)).toBe(pod);
    expect(districtOf(at('m1:gl-mgr').siteId)).toBe(pod);
    expect(districtOf(at('m1:loner').siteId)).not.toBe(pod);
    // Nobody shares a spot, and everybody is on the map.
    expect(new Set(scene.figures.map((f) => `${f.x},${f.y}`)).size).toBe(3);
    for (const f of scene.figures) { expect(f.x).toBeGreaterThan(0); expect(f.x).toBeLessThan(1); expect(f.y).toBeGreaterThan(0); expect(f.y).toBeLessThan(1); }
  });

  it('ONE LOOK PER STATE: working is on the floor with a tool, idle stands still, waiting or needing you waves — and the tone says the same', () => {
    const ask = { id: 'p1', agentId: 'asks', toolName: 'Bash', toolInput: '', description: 'rm -rf build', status: 'pending', createdAt: '', decidedAt: null, response: '' } as unknown as PermissionRequest;
    const scene = build(
      [agent('works', { status: 'working' }), agent('rests'), agent('waits', { status: 'waiting' }), agent('asks'), agent('wonders', { pendingQuestion: 'which branch?' })],
      [], [ask],
    );
    const look = Object.fromEntries(scene.figures.map((f) => [f.name, [f.anim, f.tone]]));
    expect(['kneel', 'repair', 'tend']).toContain(look.works[0]);
    expect(look.works[1]).toBe('live');
    expect(look.rests).toEqual(['idle', 'quiet']);
    expect(look.waits).toEqual(['alert', 'ember']);
    expect(look.asks).toEqual(['alert', 'ember']);
    expect(look.wonders).toEqual(['alert', 'ember']);
    expect(scene.figures.find((f) => f.name === 'asks')!.attention).toMatch(/rm -rf build/);
    // No two states share a look.
    expect(new Set([look.works[0], look.rests[0], look.waits[0]]).size).toBe(3);
  });

  it('offline and put-away agents are not on the map', () => {
    const scene = build([agent('here'), agent('gone', { status: 'offline' }), agent('hidden', { dismissedAt: '2026-11-20T00:00:00Z' })]);
    expect(scene.figures.map((f) => f.name)).toEqual(['here']);
  });

  it('nobody moves or changes character because someone else arrived or left', () => {
    const projects = [project('gridlight', ['/code/a', '/code/b', '/code/c'])];
    const first = build([agent('a'), agent('b')], projects);
    const second = build([agent('a'), agent('b'), agent('c'), agent('d')], projects, [], first.memory);
    const third = build([agent('b'), agent('d')], projects, [], second.memory);
    const where = (s: typeof first, key: string) => { const f = s.figures.find((x) => x.key === key)!; return `${f.x},${f.y},${f.character}`; };
    expect(where(second, 'm1:a')).toBe(where(first, 'm1:a'));
    expect(where(second, 'm1:b')).toBe(where(first, 'm1:b'));
    expect(where(third, 'm1:b')).toBe(where(first, 'm1:b'));
    expect(where(third, 'm1:d')).toBe(where(second, 'm1:d'));
    // Different faces while the pool lasts.
    expect(new Set(second.figures.slice(0, 3).map((f) => f.character)).size).toBe(3);
  });

  it('every pod has ONE project; its banner says what is under way and its gate opens for it', () => {
    const scene = build([], [
      project('a', ['/code/a'], { featuresActive: 2, featureCount: 6, featuresDone: 1 }),
      project('bb', ['/code/b']),
    ]);
    expect(scene.banners.map((b) => [b.name, b.detail, b.active])).toEqual([
      ['a', '1/6 features · 2 under way', true],
      ['bb', '1/3 features', false],
    ]);
    const gates = scene.structures.filter((s) => s.sprite.startsWith('gate-'));
    expect(gates.length).toBe(PLATE.structures.filter((s) => s.gate).length);
    expect(gates.filter((g) => g.sprite === 'gate-3')).toHaveLength(1);
    expect(gates.filter((g) => g.sprite === 'gate-0')).toHaveLength(gates.length - 1);
    // The shuttle is not parked on the map.
    expect(scene.structures.some((s) => s.sprite.startsWith('shuttle'))).toBe(false);
  });

  it('everything the map can draw is in the bundle: the terrain, every structure sprite, every character and every look', () => {
    const bundled = (rel: string) => fs.existsSync(path.join(ROOT, rel));
    expect(GEN).toMatch(/TERRAIN: SpriteArt = \{ source: require\('\.\.\/\.\.\/assets\/world\/terrain\.jpg'\)/);
    expect(bundled('assets/world/terrain.jpg')).toBe(true);

    const projects = [project('a', ['/code/a'], { featuresActive: 1 }), project('bb', ['/code/b'])];
    const scene = build(STATUSES.map((status, i) => agent(`x${i}`, { status })), projects);
    for (const sprite of new Set(scene.structures.map((s) => s.sprite))) {
      expect(GEN.includes(`'${sprite}': { source: require('../../assets/world/kit/${sprite}.png')`), `kit sprite "${sprite}" is not in art.generated.ts`).toBe(true);
      expect(bundled(`assets/world/kit/${sprite}.png`), sprite).toBe(true);
    }
    const LOOKS = ['idle', 'walk', 'kneel', 'repair', 'tend', 'alert', 'call'];
    for (const character of new Set(scene.figures.map((f) => f.character))) {
      const entry = GEN.match(new RegExp(`\\n  ${character}: \\{ source: require\\('\\.\\./\\.\\./assets/world/crew/${character}\\.png'\\).*?rows: \\{ (.*?\\}) \\}, tops`));
      expect(entry, `character "${character}" is not in art.generated.ts`).not.toBeNull();
      expect(bundled(`assets/world/crew/${character}.png`)).toBe(true);
      for (const look of LOOKS) expect(entry![1], `${character} has no "${look}" row`).toMatch(new RegExp(`\\b${look}: \\{ row: \\d+, frames: \\d+ \\}`));
    }
    expect(scene.figures.every((f) => LOOKS.includes(f.anim))).toBe(true);
  });

  it('a walk is paced by its distance, and standing still is no walk at all', () => {
    expect(walkMs({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toBe(0);
    expect(walkMs({ x: 0.5, y: 0.5 }, { x: 0.5005, y: 0.5 })).toBe(0);
    const short = walkMs({ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5 });
    const long = walkMs({ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.8 });
    expect(short).toBeGreaterThanOrEqual(600);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(9000);
    expect(FIGURE_SHARE).toBeGreaterThan(0.05);
    expect(FIGURE_SHARE).toBeLessThan(0.2);
  });

  it('the Agents screen opens on the map, with the list one tap away', () => {
    const screen = fs.readFileSync(path.join(ROOT, 'src/screens/CartridgeListScreen.tsx'), 'utf8');
    expect(screen).toMatch(/<WorldMap\b/);
    expect(screen).toMatch(/label="Map"/);
    expect(screen).toMatch(/label="List"/);
  });
});
