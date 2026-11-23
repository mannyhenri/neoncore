/**
 * TRAVELLING BETWEEN MAPS. The scene opens on the theme's home map. A map still to earn is not
 * shown at all; once unlocked it appears in the map switch, is travelled to and remembered.
 * Whatever map is on screen, the same crew is on it, and the isles hold six projects in one sector.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Agent } from '../../types';

vi.mock('../../components/CartridgeGrid', () => ({ CartridgeGrid: () => <div data-testid="card" /> }));
const live = vi.hoisted(() => ({ confers: [] as unknown[], runs: [] as unknown[] }));
vi.mock('../../hooks/useLiveWork', () => ({ useLiveWork: () => live }));
const extras = vi.hoisted(() => ({ queue: { items: [], lanes: [] } as { items: unknown[]; lanes: unknown[] }, burn: new Map<string, number>(), machines: [] as unknown[], projects: [] as Record<string, unknown>[], goals: [] as Record<string, unknown>[], ready: true }));
vi.mock('../useCrewExtras', () => ({ useCrewExtras: () => extras }));
const earned = vi.hoisted(() => ({ maps: [] as unknown[] }));
vi.mock('../../lib/api', async (orig) => ({ api: { ...((await orig()) as { api: object }).api, getRewards: () => Promise.resolve({ projects: [] }), getWorldProgress: () => Promise.resolve({ totals: {}, maps: earned.maps }) } }));

import { WorldScene } from '../WorldScene';
import { MAPS_BY_THEME, MAP_KEY } from '../theme';
import { AMBIENT_GROUND } from '../ambient.generated';

const MAPS = MAPS_BY_THEME.scifi;            // no stored theme in a test: the base theme
const HOME = MAPS[0];
const EXTRA = MAPS.slice(1);
const iso = () => new Date().toISOString();
function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    name: over.id, machine: 'm1', repoPath: `/r/${over.id}`, repoName: over.id, branch: 'main', currentTask: '', status: 'idle', trustMode: false, plansIncluded: false, mode: 'manual',
    agentType: 'claude', lastSeen: iso(), sessionId: `s-${over.id}`, lastMessage: '', pendingQuestion: '', recoveryStatus: '', interruptedAt: '', activeObjective: '', ...over,
  } as Agent;
}
const noop = () => {};
const handlers = { onDecidePermission: noop, onSetMode: noop, onSendCommand: noop, onDelete: noop, onDismiss: noop, onRestore: noop, onDismissStuck: noop };
const project = (i: number) => ({ id: `p${i}`, name: `Project ${i}`, color: '#7CC4FF', primaryRepo: `/code/repo-${i}`, cartridges: [`/code/repo-${i}`], createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, featureCount: 0, featuresDone: 0, featuresActive: 0 });
const crewFor = (n: number) => Array.from({ length: n }, (_, i) => agent({ id: `a${i}`, repoPath: `/code/repo-${i}`, status: 'working' }));
const scene = (n: number) => <WorldScene agents={crewFor(n)} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />;
const onMap = () => screen.queryAllByRole('button', { name: /^Crew member / }).filter((b) => b.closest('.world-member')).map((b) => /^Crew member (\S+)/.exec(b.getAttribute('aria-label') ?? b.textContent ?? '')![1]).sort();
const terrain = () => document.querySelector<HTMLImageElement>('[data-world-stage] > img')!.getAttribute('src');
const tab = (id: string) => document.querySelector<HTMLElement>(`[data-map="${id}"]`)!;
const signs = () => [...document.querySelectorAll<HTMLElement>('[data-zone-label]')].map((s) => s.textContent ?? '').filter((t) => /Project \d/.test(t));
/** The moving water drawn over the terrain (not a structure's own animation, which goes wherever the structure does). */
const water = () => Object.keys(AMBIENT_GROUND).filter((id) => document.querySelector(`[data-ambient="${id}"]`) !== null);
const unlockedMap = { id: 'frontier', name: 'The new frontier', requirements: [], met: 6, total: 6, unlocked: true, unlockedAt: '2026-11-22T12:00:00Z' };

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); extras.projects = []; earned.maps = []; });

describe('travelling between maps', () => {
  it('locked: opens on the home map with NO map switch — the maps still to earn are not shown, only the progress chip towards them', async () => {
    extras.projects = [project(0), project(1)];
    earned.maps = [{ ...unlockedMap, met: 4, unlocked: false, unlockedAt: null }];
    render(scene(2));
    expect(terrain()).toBe(HOME.plate.src);
    await waitFor(() => expect(document.querySelector('[data-new-map="frontier"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-map]')).toHaveLength(0);
    for (const m of EXTRA) expect(document.body.textContent, m.id).not.toContain(m.name);
    // The water moves on the home map only: its frames are cut from that map's own art.
    expect(Object.keys(AMBIENT_GROUND).length).toBeGreaterThan(0);
    expect(water()).toEqual(Object.keys(AMBIENT_GROUND));
  });

  it.each(EXTRA.map((m) => ({ name: m.id, map: m })))('$name, LOCKED: not on screen at all, and a remembered visit there opens the home map instead', ({ map }) => {
    extras.projects = [project(0), project(1)];
    window.localStorage.setItem(MAP_KEY, map.id);
    render(scene(2));
    expect(terrain()).toBe(HOME.plate.src);
    expect(document.querySelector(`[data-map="${map.id}"]`)).toBeNull();
    expect(document.body.textContent).not.toContain(map.name);
    expect(onMap()).toEqual(['a0', 'a1']);
  });

  it.each(EXTRA.map((m) => ({ name: m.id, map: m })))('$name, UNLOCKED: travelling there moves the crew for good — no preview, remembered, and the world opens there next time', async ({ map }) => {
    extras.projects = Array.from({ length: 6 }, (_, i) => project(i));
    earned.maps = [unlockedMap];
    render(scene(6));
    await waitFor(() => expect(tab(map.id)).not.toBeNull());
    expect([...document.querySelectorAll('[data-map]')].map((b) => b.getAttribute('data-map'))).toEqual(MAPS.map((m) => m.id));
    fireEvent.click(tab(map.id));
    expect(terrain()).toBe(map.plate.src);
    expect(tab(map.id).querySelector('[data-map-says]')!.textContent).toBe('You are here');
    expect(window.localStorage.getItem(MAP_KEY)).toBe(map.id);
    // Six projects: the isles hold them all in one sector; the interior has four pods, so a second sector.
    const sectorTabs = document.querySelectorAll('[data-sector]').length;
    if (map.kind === 'isles') {
      expect(sectorTabs).toBe(0);
      expect(signs()).toHaveLength(6);
      expect(onMap()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    } else {
      expect(sectorTabs).toBe(2);
      expect(signs()).toHaveLength(4);
    }
    cleanup();
    render(scene(6));
    await waitFor(() => expect(terrain()).toBe(map.plate.src));
    // And home again is one click, remembered too.
    fireEvent.click(tab(HOME.id));
    expect(terrain()).toBe(HOME.plate.src);
    expect(window.localStorage.getItem(MAP_KEY)).toBe(HOME.id);
  });
});
