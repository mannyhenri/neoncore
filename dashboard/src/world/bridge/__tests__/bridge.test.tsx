import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const data = vi.hoisted(() => ({ projects: [] as Record<string, unknown>[], goals: [] as Record<string, unknown>[] }));
vi.mock('../../../lib/api', () => ({ api: { getGoalProjects: () => Promise.resolve(data.projects), getGoals: () => Promise.resolve(data.goals) } }));

import { captainAnim, CAPTAIN_ANIMS, BRIEF_MS, CELEBRATE_MS, gaugesFor } from '../captainState';
import { BridgeCaptain, BridgeGauges } from '../Bridge';
import { BRIDGE } from '../bridge.generated';

const HERE = dirname(fileURLToPath(import.meta.url));
const project = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Project ${id}`, color: '#7CC4FF', primaryRepo: `/c/${id}`, cartridges: [`/c/${id}`, `/c/${id}-b`],
  createdAt: '2026-01-01T00:00:00Z', featureCount: 3, featuresDone: 1, featuresActive: 0, featuresNeedYou: 0, costUsd: 1200, ...over,
});
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

afterEach(() => { cleanup(); data.projects = []; data.goals = []; window.location.hash = ''; });

/**
 * THE PROJECTS BRIDGE. The Projects screen dressed as a ship's operations deck: a drawn
 * captain over the project list, the workspace in a console frame, gauges along the bottom.
 * The captain is a drawn sprite sheet with ONE LOOK PER STATE, like the crew on the map.
 */
describe('the captain', () => {
  it('has one look per state — for every mix of needs-you, just-delivered, just-selected, deadline and work under way', () => {
    expect([...CAPTAIN_ANIMS]).toEqual(['idle', 'brief', 'call', 'log', 'celebrate', 'worry']);
    const used = new Set<string>();
    for (const needsYou of [false, true]) for (const justDelivered of [false, true]) for (const justSelected of [false, true])
      for (const deadline of [null, 'ok', 'tight', 'overdue'] as const) for (const underWay of [false, true]) {
        const anim = captainAnim({ needsYou, justDelivered, justSelected, deadline, underWay });
        // Most urgent first: you are needed; a delivery just landed; a project was just picked;
        // a date is close or past; work is under way (he keeps the log); nothing to say.
        const want = needsYou ? 'call' : justDelivered ? 'celebrate' : justSelected ? 'brief'
          : deadline === 'tight' || deadline === 'overdue' ? 'worry' : underWay ? 'log' : 'idle';
        expect(anim, JSON.stringify({ needsYou, justDelivered, justSelected, deadline, underWay })).toBe(want);
        used.add(anim);
      }
    expect([...used].sort(), 'every drawn cycle is reachable').toEqual([...CAPTAIN_ANIMS].sort());
  });

  it('is a drawn sheet or nothing — never a figure made in code', async () => {
    data.projects = [project('a')];
    const { container } = render(<BridgeCaptain />);
    await flush();
    expect(container.querySelectorAll('svg, canvas')).toHaveLength(0);
    const fig = container.querySelector<HTMLElement>('[data-bridge-captain]');
    if (BRIDGE.captain === null) expect(fig, 'no art yet: no figure').toBeNull();
    else {
      expect(fig!.querySelector<HTMLElement>('div')!.style.backgroundImage).toContain(BRIDGE.captain.src);
      for (const a of CAPTAIN_ANIMS) expect(BRIDGE.captain.rows[a].frames, a).toBeGreaterThanOrEqual(2);
    }
  });

  it('calls for you while the selected project needs you, briefs a newly selected project for a moment, and otherwise waits', async () => {
    vi.useFakeTimers();
    try {
      data.projects = [project('a'), project('b', { featuresNeedYou: 2 })];
      window.location.hash = '#project/a';
      const { container } = render(<BridgeCaptain />);
      await flush();
      const state = () => container.querySelector<HTMLElement>('[data-captain-state]')!.dataset.captainState;
      expect(state(), 'what is already selected on opening is not news').toBe('idle');
      window.location.hash = '#project/b';
      act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(state()).toBe('call');
      window.location.hash = '#project/a';
      act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(state()).toBe('brief');
      act(() => { vi.advanceTimersByTime(BRIEF_MS + 50); });
      expect(state()).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the gauges', () => {
  const all = [project('a', { costUsd: 17500, featureCount: 0, featuresDone: 0 }), project('b', { cartridges: ['/x', '/y', '/z', '/w'], costUsd: 17000, featureCount: 80, featuresDone: 20 })];

  it('read the selected project — and the whole fleet of projects when none is selected', () => {
    expect(gaugesFor(all, 'a')).toEqual({ scope: 'Project a', repos: 2, spentUsd: 17500, features: 0, done: 0 });
    expect(gaugesFor(all, 'b')).toEqual({ scope: 'Project b', repos: 4, spentUsd: 17000, features: 80, done: 20 });
    for (const none of [null, 'gone']) expect(gaugesFor(all, none)).toEqual({ scope: 'All projects', repos: 6, spentUsd: 34500, features: 80, done: 20 });
    expect(gaugesFor([], null)).toEqual({ scope: 'All projects', repos: 0, spentUsd: 0, features: 0, done: 0 });
  });

  it('show the three readings for the project on screen: the one the address names, else the first', async () => {
    data.projects = all;
    for (const [hash, want] of [['#project/a', ['2', '$17.5K', '0']], ['#project/b', ['4', '$17.0K', '20/80']], ['', ['2', '$17.5K', '0']], ['#project/gone', ['2', '$17.5K', '0']]] as const) {
      window.location.hash = hash;
      const view = render(<BridgeGauges />);
      await flush();
      const read = [...view.container.querySelectorAll<HTMLElement>('[data-gauge]')].map((e) => `${e.dataset.gauge}=${e.querySelector('[data-gauge-value]')!.textContent}`);
      expect(read, hash || 'no selection').toEqual([`repos=${want[0]}`, `spent=${want[1]}`, `features=${want[2]}`]);
      view.unmount();
    }
  });
});

describe('the console look', () => {
  it('is scoped to the bridge: every rule that restyles a control starts from .bridge', () => {
    const css = readFileSync(resolve(HERE, '../../../index.css'), 'utf8');
    const start = css.indexOf('/* ── The Projects bridge');
    expect(start, 'the bridge section is missing from index.css').toBeGreaterThan(-1);
    const section = css.slice(start).split('/* ── end of the Projects bridge')[0];
    const selectors = [...section.matchAll(/(^|\})\s*([^{}@/][^{}]*)\{/g)].map((m) => m[2].trim()).filter((s) => !/^(from|to|\d+%)/.test(s));
    expect(selectors.length).toBeGreaterThan(6);
    for (const sel of selectors) for (const part of sel.split(',')) expect(part.trim(), `"${part.trim()}" would restyle the rest of the app`).toMatch(/^\.bridge/);
  });
});

describe('the captain and the records', () => {
  const state = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-captain-state]')!.dataset.captainState;
  const DAY = 24 * 60 * 60 * 1000;

  it('keeps the log while a feature is under way, and worries when the nearest date is tight or past', async () => {
    window.location.hash = '#project/a';
    data.projects = [project('a', { featuresActive: 1 })];
    const working = render(<BridgeCaptain />);
    await flush();
    expect(state(working.container)).toBe('log');
    working.unmount();

    for (const [left, want] of [[60, 'log'], [5, 'worry'], [-3, 'worry']] as const) {
      data.goals = [{ projectId: 'a', status: 'active', origin: '', createdAt: new Date(Date.now() - (100 - left) * DAY).toISOString(), targetDate: new Date(Date.now() + left * DAY + 60_000).toISOString() }];
      const view = render(<BridgeCaptain />);
      await flush();
      expect(state(view.container), `${left} days left`).toBe(want);
      view.unmount();
    }
  });

  it('celebrates for a moment when the selected project has one more feature delivered — not on opening, not when the count falls', async () => {
    vi.useFakeTimers();
    try {
      window.location.hash = '#project/a';
      data.projects = [project('a', { featuresDone: 1 })];
      const view = render(<BridgeCaptain />);
      await flush();
      expect(state(view.container), 'old news on opening').toBe('idle');
      const poll = async (done: number) => { data.projects = [project('a', { featuresDone: done })]; await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); await Promise.resolve(); }); };
      await poll(2);
      expect(state(view.container)).toBe('celebrate');
      act(() => { vi.advanceTimersByTime(CELEBRATE_MS + 50); });
      expect(state(view.container)).toBe('idle');
      await poll(1);
      expect(state(view.container)).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});

