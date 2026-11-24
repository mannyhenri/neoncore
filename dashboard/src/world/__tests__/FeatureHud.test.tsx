/**
 * THE FEATURES HUD — the feature banners (name · stage · needs you · its seven badges), for every
 * feature being built in every sector, along the bottom of the map instead of on it. Those that
 * need you first. Click one to open it. Hide it and bring it back; it stays as you left it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { ActiveFeature, Goal } from '../../types';
import { FeatureHud, HUD_KEY } from '../FeatureHud';
import { FEATURE_BADGES, badgesFor } from '../milestones';

const feat = (id: string, projectId: string, over: Partial<ActiveFeature> = {}): ActiveFeature => ({
  pilotId: `pi-${id}`, goalId: `g-${id}`, projectId, name: `Feature ${id}`, phase: 'running', stage: { position: 2, total: 8, title: 'Build it' },
  needsYou: '', agentIds: [], worktrees: [], branch: '', ...over,
});
const PROJECTS = [{ id: 'p1', name: 'Atlas', color: '#2EE6D6' }, { id: 'p2', name: 'Beam', color: '#5AAEFF' }, { id: 'p9', name: 'Far', color: '#F5C542' }];
const FEATURES = [
  feat('a', 'p1'),
  feat('b', 'p2', { stage: { position: 7, total: 8, title: 'Check it' } }),
  feat('c', 'p9', { phase: 'paused', needsYou: 'The pipeline stopped and needs you' }),
  feat('d', 'p1', { phase: 'clarifying', stage: null }),
];
const GOALS = [
  { id: 'g-a', projectId: 'p1', status: 'active', origin: '', pilot: { phase: 'running' } },
  { id: 'g-b', projectId: 'p2', status: 'active', origin: '', pilot: { phase: 'running' } },
  { id: 'g-c', projectId: 'p9', status: 'active', origin: '', pilot: { phase: 'paused' } },
  { id: 'g-d', projectId: 'p1', status: 'active', origin: '', pilot: { phase: 'clarifying' } },
] as unknown as Goal[];
const mount = (features = FEATURES) => render(<FeatureHud features={features} projects={PROJECTS} goals={GOALS} />);
const toggle = () => document.querySelector<HTMLButtonElement>('[data-feature-hud-toggle]')!;
const banners = () => [...document.querySelectorAll<HTMLElement>('[data-hud-feature]')];
beforeEach(() => { window.localStorage.clear(); window.location.hash = ''; });
afterEach(() => { cleanup(); window.localStorage.clear(); window.location.hash = ''; });

describe('the features HUD', () => {
  it('one banner per feature in progress, in every sector — name, stage, needs you, and its seven badges; those that need you first', () => {
    mount();
    expect(toggle().textContent).toContain('Features in progress');
    expect(toggle().textContent).toContain('4');
    expect(toggle().textContent).toContain('1 needs you');
    expect(banners().map((r) => r.dataset.hudFeature)).toEqual(['g-c', 'g-b', 'g-a', 'g-d']);
    for (const f of FEATURES) {
      const b = document.querySelector<HTMLElement>(`[data-hud-feature="${f.goalId}"]`)!;
      expect(b.textContent).toContain(f.name);
      if (f.stage) expect(b.textContent).toContain(`· ${f.stage.position}/${f.stage.total}`);
      expect(/needs you/i.test(b.textContent!)).toBe(!!f.needsYou);
      const badges = [...b.querySelectorAll('[data-badge]')];
      expect(badges.map((x) => x.getAttribute('data-badge'))).toEqual(FEATURE_BADGES.map((x) => x.step));
      const earned = badgesFor(GOALS.filter((g) => g.id === f.goalId), f.projectId);
      expect(badges.map((x) => x.getAttribute('data-earned'))).toEqual(FEATURE_BADGES.map((_, i) => String(i < earned)));
      // Its project, by colour (and named when pointed at).
      expect(b.title).toContain(PROJECTS.find((p) => p.id === f.projectId)!.name);
    }
    // Nothing else: no cards, no sector or phase labels.
    expect(document.querySelector('[data-feature-hud]')!.textContent).not.toMatch(/Sector|Building|Questions to answer/);
  });

  it('a click opens the feature', () => {
    mount();
    fireEvent.click(document.querySelector('[data-hud-feature="g-b"]')!);
    expect(window.location.hash).toBe('#project/p2/feature/g-b');
  });

  it('hides and comes back, and stays as you left it', () => {
    const view = mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(banners()).toHaveLength(0);
    expect(window.localStorage.getItem(HUD_KEY)).toBe('closed');
    view.unmount();
    mount();
    expect(banners()).toHaveLength(0);
    expect(toggle().textContent, 'still says how many, closed').toContain('4');
    fireEvent.click(toggle());
    expect(banners()).toHaveLength(4);
    expect(window.localStorage.getItem(HUD_KEY)).toBe('open');
  });

  it('opens to the size of all its features — no height cap, no scroll', () => {
    const many = Array.from({ length: 14 }, (_, i) => feat(`m${i}`, PROJECTS[i % 3].id));
    mount(many);
    expect(banners()).toHaveLength(14);
    const panel = document.querySelector<HTMLElement>('[data-feature-hud-panel]')!;
    expect(panel.className).not.toMatch(/max-h-|overflow-(y-)?(auto|scroll|hidden)/);
  });

  it('with nothing being built it says so', () => {
    mount([]);
    expect(toggle().textContent).toContain('0');
    expect(document.querySelector('[data-feature-hud-empty]')!.textContent).toBe('Nothing is being built right now.');
  });
});
