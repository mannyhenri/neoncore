/**
 * FIVE OR MORE PROJECTS ON THE MAP. The world has a district for four; the fifth and later are on
 * the next SECTOR — the same world again. Every project has its district and signpost in its
 * sector, an agent is on the map of its own project's sector only, and a sector you are not
 * looking at says when one of its agents needs you.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Agent, PermissionRequest } from '../../types';

vi.mock('../../components/CartridgeGrid', () => ({ CartridgeGrid: () => <div data-testid="card" /> }));
const live = vi.hoisted(() => ({ confers: [] as unknown[], runs: [] as unknown[] }));
vi.mock('../../hooks/useLiveWork', () => ({ useLiveWork: () => live }));
const extras = vi.hoisted(() => ({ queue: { items: [], lanes: [] } as { items: unknown[]; lanes: unknown[] }, burn: new Map<string, number>(), machines: [] as unknown[], projects: [] as Record<string, unknown>[], goals: [] as Record<string, unknown>[], ready: true }));
vi.mock('../useCrewExtras', () => ({ useCrewExtras: () => extras }));
// What each project has earned (the server counts it); a test sets what it needs.
const earned = vi.hoisted(() => ({ projects: [] as unknown[], maps: [] as unknown[] }));
vi.mock('../../lib/api', async (orig) => ({ api: { ...((await orig()) as { api: object }).api, getRewards: () => Promise.resolve({ projects: earned.projects }), getWorldProgress: () => Promise.resolve({ totals: {}, maps: earned.maps }) } }));

import { WorldScene } from '../WorldScene';
import { OUTPOST } from '../sites';

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
const projects = (n: number) => Array.from({ length: n }, (_, i) => project(i));
/** One agent per project, plus one whose repo no project owns. */
const crewFor = (n: number, over: Record<number, Partial<Agent>> = {}) => [
  ...Array.from({ length: n }, (_, i) => agent({ id: `a${i}`, repoPath: `/code/repo-${i}`, status: 'working', ...over[i] })),
  agent({ id: 'drifter', repoPath: '/tmp/nobody', status: 'working' }),
];
const scene = (list: Agent[], perms: PermissionRequest[] = [], filter?: 'waiting') =>
  <WorldScene agents={list} activitiesByAgent={{}} pendingPermissions={perms} stuckAlerts={[]} {...(filter ? { statusFilter: filter } : {})} {...handlers} />;
const onMap = () => screen.queryAllByRole('button', { name: /^Crew member / }).filter((b) => b.closest('.world-member')).map((b) => /^Crew member (\S+)/.exec(b.getAttribute('aria-label') ?? b.textContent ?? '')![1]).sort();
const signs = () => [...document.querySelectorAll<HTMLElement>('[data-zone-label]')].map((s) => s.textContent ?? '');
const signed = (i: number) => signs().some((t) => t.includes(`Project ${i}`));
const tabs = () => [...document.querySelectorAll<HTMLElement>('[data-sector]')];

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); extras.projects = []; });

describe('sectors on the map', () => {
  it('up to four projects: one world, no sector switch, every project signposted', () => {
    for (const n of [0, 1, 4]) {
      extras.projects = projects(n);
      render(scene(crewFor(n)));
      expect(document.querySelector('[data-sectors]'), `${n} projects`).toBeNull();
      for (let i = 0; i < n; i++) expect(signed(i), `Project ${i} of ${n}`).toBe(true);
      expect(onMap()).toEqual([...Array.from({ length: n }, (_, i) => `a${i}`), 'drifter'].sort());
      cleanup();
    }
  });

  it.each([5, 8, 9])('%i projects: EVERY project has its signpost in its sector, and every agent is on the map of its own project\'s sector', (n) => {
    extras.projects = projects(n);
    render(scene(crewFor(n)));
    const count = Math.ceil(n / 4);
    expect(tabs()).toHaveLength(count);
    const seenSigns = new Set<number>(); const seenAgents = new Set<string>();
    for (let s = 0; s < count; s++) {
      fireEvent.click(tabs()[s]);
      expect(tabs().map((t) => t.getAttribute('data-current'))).toEqual(tabs().map((_, i) => (i === s ? 'true' : null)));
      const mine = Array.from({ length: n }, (_, i) => i).filter((i) => Math.floor(i / 4) === s);
      // Exactly this sector's projects are signposted, each once…
      for (let i = 0; i < n; i++) expect(signed(i), `sector ${s + 1}, Project ${i}`).toBe(mine.includes(i));
      expect(signs().filter((t) => /Project \d/.test(t))).toHaveLength(mine.length);
      // …and exactly their agents are on the map, with the one no project owns.
      expect(onMap()).toEqual([...mine.map((i) => `a${i}`), 'drifter'].sort());
      // The tab names its projects and counts its agents.
      for (const i of mine) expect(tabs()[s].textContent).toContain(`Project ${i}`);
      expect(tabs()[s].textContent).toContain(`${mine.length} agent${mine.length === 1 ? '' : 's'}`);
      mine.forEach((i) => { seenSigns.add(i); seenAgents.add(`a${i}`); });
    }
    expect(seenSigns.size).toBe(n);
    expect(seenAgents.size).toBe(n);
  });

  it('a sector you are not looking at says when an agent there needs you — and only then', () => {
    extras.projects = projects(6);
    const perms: PermissionRequest[] = [{ id: 'p1', agentId: 'a5', toolName: 'Bash', toolInput: '', description: 'rm -rf build', status: 'pending', createdAt: iso(), decidedAt: null, response: '' }];
    render(scene(crewFor(6, { 4: { status: 'waiting', pendingQuestion: 'Which database?' } }), perms));
    const [first, second] = tabs();
    expect(first.getAttribute('data-needs')).toBeNull();
    expect(first.querySelector('[data-sector-needs]')).toBeNull();
    expect(second.getAttribute('data-needs')).toBe('2');
    expect(second.querySelector('[data-sector-needs]')!.textContent).toBe('2 need you');
    expect(second.getAttribute('title')).toMatch(/Sector 2: Project 4, Project 5 — 2 agents, 2 need you/);
    // The agents of the other sector are not on this map, but they are still counted.
    expect(onMap()).toEqual(['a0', 'a1', 'a2', 'a3', 'drifter']);
  });

  it('a project with four repos keeps a second district: its eight agents work in two pods of four, on one map', () => {
    const big = { ...project(0), cartridges: ['/code/g-a', '/code/g-b', '/code/g-c', '/code/g-d'], primaryRepo: '/code/g-a' };
    extras.projects = [big, project(1), project(2), project(3), project(4)];
    // Eight agents of the big project: one per repo, and one per repo's feature branch (same repo paths here).
    const eight = ['a', 'b', 'c', 'd'].flatMap((r) => [agent({ id: `g-${r}`, repoPath: `/code/g-${r}`, status: 'working' }), agent({ id: `feat-${r}`, machine: 'm2', repoPath: `/code/g-${r}`, status: 'working' })]);
    render(scene([...eight, agent({ id: 'a1', repoPath: '/code/repo-1', status: 'working' })]));
    // The big project counts for two districts, so the first sector holds it and two more — not four.
    expect(tabs().map((t) => [...t.querySelectorAll('span.inline-flex')].map((x) => x.textContent))).toEqual([['Project 0', 'Project 1', 'Project 2'], ['Project 3', 'Project 4']]);
    // Its second pod is signposted, on this same map…
    expect(document.querySelectorAll('[data-zone-annex]')).toHaveLength(1);
    // …and its eight stand four and four: no district holds more than a pod's worth.
    const districtOf = (el: HTMLElement) => OUTPOST.sites.find((x) => x.id === el.dataset.site)?.district;
    const where = eight.map((a) => districtOf(screen.getByRole('button', { name: new RegExp(`^Crew member ${a.name}\\b`) }).closest<HTMLElement>('.world-member')!));
    const perDistrict = [...new Set(where)].map((d) => where.filter((x) => x === d).length).sort();
    expect(perDistrict).toEqual([4, 4]);
  });

  it('a spot dropped on open ground while a project had no district does not keep its agent away from the district it has now; an agent of no project keeps its spot', () => {
    extras.projects = projects(5);
    // Saved by the map before sectors: project 4 had no district, its agent was left out on the road. No district recorded.
    window.localStorage.setItem('neoncore.world.spots.base', JSON.stringify({ 'm1:a4': { x: 0.81, y: 0.558 }, 'm1:drifter': { x: 0.5, y: 0.93 } }));
    window.localStorage.setItem('neoncore.world.sector', '1');
    render(scene(crewFor(5)));
    const fig = (n: string) => screen.getByRole('button', { name: new RegExp(`^Crew member ${n}\\b`) }).closest<HTMLElement>('.world-member')!;
    expect(signed(4)).toBe(true);
    // It works at its project's district now, not on the road…
    expect([fig('a4').style.left, fig('a4').style.top]).not.toEqual(['81%', '55.800000000000004%']);
    expect(OUTPOST.sites.find((x) => x.id === fig('a4').dataset.site)!.district).toBe('nw');
    const site = OUTPOST.sites.find((x) => x.id === fig('a4').dataset.site)!;
    expect(parseFloat(fig('a4').style.left)).toBeCloseTo(site.x * 100, 3);
    // …the drifter, who has no project, stays where it was put; and nothing was thrown away.
    expect(parseFloat(fig('drifter').style.left)).toBeCloseTo(50, 3);
    expect(Object.keys(JSON.parse(window.localStorage.getItem('neoncore.world.spots.base')!))).toEqual(['m1:a4', 'm1:drifter']);
  });

  it('the sector is remembered, a sector that no longer exists falls back to the last one, and an empty sector says so', () => {
    extras.projects = projects(5);
    const view = render(scene(crewFor(5)));
    fireEvent.click(tabs()[1]);
    expect(window.localStorage.getItem('neoncore.world.sector')).toBe('1');
    view.unmount();
    render(scene(crewFor(5)));
    expect(tabs()[1].getAttribute('data-current')).toBe('true');
    expect(signed(4)).toBe(true);
    cleanup();
    // A project was deleted: four are left, one sector, and the map shows it.
    extras.projects = projects(4);
    render(scene(crewFor(4)));
    expect(document.querySelector('[data-sectors]')).toBeNull();
    expect(signed(0)).toBe(true);
    cleanup();
    // A sector with nobody in it, under a filter: it says where, not just "no agents".
    extras.projects = projects(5);
    window.localStorage.setItem('neoncore.world.sector', '1');
    render(scene(crewFor(5).filter((a) => a.id !== 'drifter'), [], 'waiting'));
    expect(screen.getByText(/No waiting agents in this sector/)).toBeTruthy();
  });

  it('a project\'s medals hang under its signpost: the highest earned in each family, named for the project — only for the sector on the map', async () => {
    const fam = (id: string, count: number, tiers: number[]) => ({ id, label: id, count, next: tiers.find((t) => count < t) ?? null, tiers: tiers.map((t) => ({ threshold: t, earned: count >= t, label: `NAME — ${t} ${id}` })) });
    const of = (i: number, counts: [string, number, number[]][]) => ({ projectId: `p${i}`, name: `Project ${i}`, color: '#4af', earned: 0, total: 0,
      families: counts.map(([id, c, tiers]) => { const f = fam(id, c, tiers); return { ...f, tiers: f.tiers.map((t) => ({ ...t, label: t.label.replace('NAME', `Project ${i}`) })) }; }) });
    extras.projects = projects(5);
    earned.projects = [
      of(0, [['features', 12, [1, 5, 10, 25]], ['bugs', 0, [1, 5]], ['qa', 30, [5, 25, 50]]]),
      of(1, [['features', 0, [1, 5]]]),                               // nothing earned: no rack
      of(4, [['epics', 1, [1, 5]]]),                                  // on the other sector
    ];
    try {
      render(scene(crewFor(5)));
      await waitFor(() => expect(document.querySelector('[data-zone-rewards="p0"]')).not.toBeNull());
      const rack = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-zone-rewards="${id}"] [data-reward-medal]`)].map((m) => [m.getAttribute('data-family'), m.getAttribute('data-threshold'), m.getAttribute('aria-label')]);
      expect(rack('p0')).toEqual([['features', '10', 'Project 0 — 10 features'], ['qa', '25', 'Project 0 — 25 qa']]);
      expect(document.querySelector('[data-zone-rewards="p1"]')).toBeNull();
      expect(document.querySelector('[data-zone-rewards="p4"]')).toBeNull();
      fireEvent.click(tabs()[1]);
      expect(rack('p4')).toEqual([['epics', '1', 'Project 4 — 1 epics']]);
      expect(document.querySelector('[data-zone-rewards="p0"]')).toBeNull();
    } finally { earned.projects = []; }
  });

  it('the next map to discover: a chip on the map says how far it is; open, every requirement with its count — locked until ALL are met', async () => {
    const req = (family: string, count: number, target: number) => ({ family, label: `${target} ${family}`, count, target, met: count >= target });
    const map = (counts: number[], unlockedAt: string | null = null) => {
      const requirements = [req('features', counts[0], 10), req('epics', counts[1], 5), req('qa', counts[2], 5), req('releases', counts[3], 5), req('ontime', counts[4], 5), req('bugs', counts[5], 5)];
      return { id: 'frontier', name: 'The new frontier', requirements, met: requirements.filter((r) => r.met).length, total: 6, unlocked: !!unlockedAt, unlockedAt };
    };
    const chip = () => document.querySelector<HTMLElement>('[data-new-map="frontier"]')!;
    try {
      // With one sector only, the chip is still there: the switch row appears for it.
      extras.projects = projects(2);
      earned.maps = [map([12, 5, 2, 0, 5, 9])];
      render(scene(crewFor(2)));
      await waitFor(() => expect(chip()).not.toBeNull());
      expect(tabs()).toHaveLength(0);
      expect(chip().getAttribute('data-unlocked')).toBe('false');
      expect(chip().textContent).toContain('New map');
      expect(chip().querySelector('[data-new-map-count]')!.textContent).toBe('4 of 6 done');
      expect(document.querySelector('[data-new-map-panel]')).toBeNull();
      fireEvent.click(chip().querySelector('button')!);
      const rows = [...document.querySelectorAll<HTMLElement>('[data-map-requirement]')];
      expect(rows.map((r) => [r.getAttribute('data-map-requirement'), r.getAttribute('data-met')])).toEqual([['features', 'true'], ['epics', 'true'], ['qa', 'false'], ['releases', 'false'], ['ontime', 'true'], ['bugs', 'true']]);
      // A count past its target shows as the target reached, not more; the bar says how far each is.
      expect(rows.map((r) => r.textContent!.match(/(\d+ \/ \d+)/)![1])).toEqual(['10 / 10', '5 / 5', '2 / 5', '0 / 5', '5 / 5', '5 / 5']);
      expect(rows.map((r) => r.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'))).toEqual(['10', '5', '2', '0', '5', '5']);
      expect(document.querySelector('[data-new-map-state]')!.textContent).toMatch(/Opens when all your projects together have done every one/);
      cleanup();
      // Unlocked: it says so, and that the map is open — travelled to from the map switch (maps.render.test.tsx).
      earned.maps = [map([12, 5, 5, 5, 5, 9], '2026-11-22T12:00:00Z')];
      render(scene(crewFor(2)));
      await waitFor(() => expect(chip()).not.toBeNull());
      expect(chip().getAttribute('data-unlocked')).toBe('true');
      expect(chip().textContent).toContain('New map open');
      expect(chip().textContent).toContain('The new frontier');
      fireEvent.click(chip().querySelector('button')!);
      expect(document.querySelector('[data-new-map-state]')!.textContent).toMatch(/^Unlocked .*2026\. It is open — travel there from the map switch\./);
      expect(document.querySelectorAll('[data-map-requirement][data-met="true"]')).toHaveLength(6);
    } finally { earned.maps = []; }
  });
});
