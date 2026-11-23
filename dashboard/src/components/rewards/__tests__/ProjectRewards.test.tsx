/**
 * REWARDS ON SCREEN — a medal per tier in its metal with the project's name, the highest medal of
 * each family on the project's page, the whole board on request, and the next medal's distance.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ProjectRewards as Rewards, RewardFamily, RewardFamilyId } from '../../../types';

const srv = vi.hoisted(() => ({ rewards: null as unknown, fail: false, calls: [] as string[] }));
vi.mock('../../../lib/api', () => ({ api: {
  getProjectRewards: (id: string) => { srv.calls.push(id); return srv.fail ? Promise.reject(new Error('Not Found')) : Promise.resolve(srv.rewards); },
} }));

import { ProjectRewards, topTier } from '../ProjectRewards';
import { RewardMedal, TIER_METALS, REWARD_ICONS, metalOf } from '../RewardMedal';

const FAMILIES: { id: RewardFamilyId; label: string; tiers: number[] }[] = [
  { id: 'features', label: 'Features delivered', tiers: [1, 5, 10, 25, 50, 75, 100] },
  { id: 'epics', label: 'Epics delivered', tiers: [1, 5, 10, 25] },
  { id: 'releases', label: 'Releases shipped', tiers: [1, 5, 10, 25] },
  { id: 'bugs', label: 'Bugs fixed', tiers: [1, 5, 10, 25, 50, 100] },
  { id: 'qa', label: 'QA runs', tiers: [5, 25, 50, 100] },
  { id: 'clean', label: 'Clean deliveries', tiers: [1, 5, 10, 25] },
  { id: 'streak', label: 'Clean streak', tiers: [3, 5, 10] },
  { id: 'ontime', label: 'On time', tiers: [5, 10, 25] },
  { id: 'fastfix', label: 'Fast fixes', tiers: [1, 5, 10] },
  { id: 'commend', label: 'Commendations', tiers: [1, 2, 3, 4] },
];
const rewardsFor = (counts: Partial<Record<RewardFamilyId, number>>): Rewards => {
  const families: RewardFamily[] = FAMILIES.map((f) => {
    const count = counts[f.id] ?? 0;
    return { id: f.id, label: f.label, count, tiers: f.tiers.map((t) => ({ threshold: t, earned: count >= t, label: `Atlas — ${t} ${f.label.toLowerCase()}` })), next: f.tiers.find((t) => count < t) ?? null };
  });
  return { projectId: 'p1', name: 'Atlas', color: '#4af', families, earned: families.reduce((n, f) => n + f.tiers.filter((t) => t.earned).length, 0), total: families.reduce((n, f) => n + f.tiers.length, 0) };
};
const project = { id: 'p1', name: 'Atlas' };
const q = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const shown = () => waitFor(() => expect(q('[data-project-rewards]')).not.toBeNull());

beforeEach(() => { srv.rewards = rewardsFor({}); srv.fail = false; srv.calls = []; });
afterEach(() => cleanup());

describe('a reward medal', () => {
  it('every family has an emblem, and every tier its own metal — seven of them, in order', () => {
    expect(Object.keys(REWARD_ICONS).sort()).toEqual(FAMILIES.map((f) => f.id).sort());
    for (const d of Object.values(REWARD_ICONS)) expect(d.startsWith('M')).toBe(true);
    expect(TIER_METALS.map((m) => m.name)).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Legend', 'Mythic']);
    expect(new Set(TIER_METALS.map((m) => m.ring)).size).toBe(TIER_METALS.length);
    expect(Math.max(...FAMILIES.map((f) => f.tiers.length))).toBeLessThanOrEqual(TIER_METALS.length);
    expect([metalOf(-1).name, metalOf(99).name]).toEqual(['Bronze', 'Mythic']);
  });

  it('says the project and what it is for; earned is lit, not-yet is the same medal dimmed and says so', () => {
    for (const f of FAMILIES) {
      f.tiers.forEach((threshold, tier) => {
        for (const earned of [true, false]) {
          const { container } = render(<RewardMedal family={f.id} tier={tier} threshold={threshold} earned={earned} label={`Atlas — ${threshold} ${f.label}`} />);
          const m = q('[data-reward-medal]', container)!;
          expect([m.getAttribute('data-family'), m.getAttribute('data-threshold'), m.getAttribute('data-earned'), m.getAttribute('data-metal')]).toEqual([f.id, String(threshold), String(earned), TIER_METALS[tier].name]);
          expect(m.getAttribute('aria-label')).toBe(`Atlas — ${threshold} ${f.label}${earned ? '' : ' — not earned yet'}`);
          expect(m.getAttribute('title')).toContain('Atlas');
          expect(m.textContent).toBe(String(threshold));            // the plate
          expect(m.style.opacity).toBe(earned ? '1' : '0.28');
          // The emblem: the art slot for this family, and the line icon standing in until the art exists.
          expect(m.querySelector('img')!.getAttribute('src')).toBe(`/rewards/${f.id}.png`);
          expect(m.querySelector('svg path')!.getAttribute('d')).toBe(REWARD_ICONS[f.id]);
          cleanup();
        }
      });
    }
  });

  it('when the art for a family exists it takes the icon\'s place', () => {
    const { container } = render(<RewardMedal family="bugs" tier={1} threshold={5} earned label="Atlas — 5 bugs fixed" />);
    const img = q<HTMLImageElement>('img', container)!;
    expect(img.style.display).toBe('none');
    fireEvent.load(img);
    expect(img.style.display).toBe('block');
    expect(q('svg', container)).toBeNull();
  });
});

describe('a project\'s rewards on its page', () => {
  it('nothing earned: it says so, with the count; nothing is shown while a server has no rewards', async () => {
    render(<ProjectRewards project={project} />); await shown();
    expect(q('[data-rewards-count]')!.textContent).toBe('0 / 42');
    expect(q('[data-rewards-top]')!.textContent).toMatch(/None yet — the first comes with the first feature Atlas delivers/);
    expect(all('[data-rewards-top] [data-reward-medal]')).toHaveLength(0);
    cleanup();
    srv.fail = true;
    const { container } = render(<ProjectRewards project={project} />);
    await waitFor(() => expect(srv.calls.length).toBe(2));
    expect(container.innerHTML).toBe('');
  });

  it('closed: the HIGHEST medal earned in each family, in its metal, named for the project', async () => {
    srv.rewards = rewardsFor({ features: 27, epics: 1, bugs: 4, qa: 60, streak: 2 });
    render(<ProjectRewards project={project} />); await shown();
    const top = all('[data-rewards-top] [data-reward-medal]');
    expect(top.map((m) => [m.getAttribute('data-family'), m.getAttribute('data-threshold'), m.getAttribute('data-metal')])).toEqual([
      ['features', '25', 'Platinum'], ['epics', '1', 'Bronze'], ['bugs', '1', 'Bronze'], ['qa', '50', 'Gold'],
    ]);
    for (const m of top) { expect(m.getAttribute('data-earned')).toBe('true'); expect(m.getAttribute('aria-label')).toMatch(/^Atlas — /); }
    expect(q('[data-rewards-count]')!.textContent).toBe('9 / 42');
    expect(q('[data-rewards-board]')).toBeNull();
    expect(topTier(rewardsFor({ features: 27 }).families[0])).toBe(3);
    expect(topTier(rewardsFor({}).families[0])).toBe(-1);
  });

  it('open: every family with every tier, earned or not, the count, and how far the next medal is', async () => {
    srv.rewards = rewardsFor({ features: 7, bugs: 100, ontime: 4 });
    render(<ProjectRewards project={project} />); await shown();
    fireEvent.click(q('button[aria-expanded]')!);
    const rows = all('[data-reward-family]');
    expect(rows.map((r) => r.getAttribute('data-reward-family'))).toEqual(FAMILIES.map((f) => f.id));
    rows.forEach((row, i) => {
      const medals = all('[data-reward-medal]', row);
      expect(medals.map((m) => Number(m.getAttribute('data-threshold')))).toEqual(FAMILIES[i].tiers);
      expect(medals.map((m) => m.getAttribute('data-metal'))).toEqual(FAMILIES[i].tiers.map((_, t) => TIER_METALS[t].name));
    });
    const row = (id: string) => q(`[data-reward-family="${id}"]`)!;
    // 7 features: 1 and 5 earned; 3 more to 10; the bar is 2/5 of the way from 5 to 10.
    expect(all('[data-reward-medal]', row('features')).map((m) => m.getAttribute('data-earned'))).toEqual(['true', 'true', 'false', 'false', 'false', 'false', 'false']);
    expect(q('[data-reward-progress]', row('features'))!.textContent).toBe('7 so far · 3 more to the next');
    expect(q('[role="progressbar"]', row('features'))!.getAttribute('aria-valuenow')).toBe('40');
    // Every tier earned: said, and the bar is full.
    expect(q('[data-reward-progress]', row('bugs'))!.textContent).toBe('100 — every medal earned');
    expect(q('[role="progressbar"]', row('bugs'))!.getAttribute('aria-valuenow')).toBe('100');
    // None earned yet: 4 of the 5 needed.
    expect(q('[data-reward-progress]', row('ontime'))!.textContent).toBe('4 so far · 1 more to the next');
    expect(q('[role="progressbar"]', row('ontime'))!.getAttribute('aria-valuenow')).toBe('80');
  });

  it('it is read again when the project changes or its records do', async () => {
    const view = render(<ProjectRewards project={project} version={1} />); await shown();
    view.rerender(<ProjectRewards project={project} version={2} />);
    await waitFor(() => expect(srv.calls).toEqual(['p1', 'p1']));
    view.rerender(<ProjectRewards project={{ id: 'p2', name: 'Beam' }} version={2} />);
    await waitFor(() => expect(srv.calls).toEqual(['p1', 'p1', 'p2']));
  });
});
