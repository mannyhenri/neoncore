import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act, waitFor } from '@testing-library/react';
import type { Agent, PermissionRequest } from '../../types';

// The drawer reuses the real cartridge card. Here it is a stub that reports WHO it was given,
// which is the contract under test: the scene must hand the card the selected cartridge's agents.
vi.mock('../../components/CartridgeGrid', () => ({
  CartridgeGrid: ({ agents }: { agents: Agent[] }) => <div data-testid="card">{agents.map((a) => a.id).join(',')}</div>,
}));
// Confers and runs are polled too; a test sets the confers it needs.
const live = vi.hoisted(() => ({ confers: [] as unknown[], runs: [] as unknown[] }));
vi.mock('../../hooks/useLiveWork', () => ({ useLiveWork: () => live }));
// Queue and token burn are polled from the server; here they are whatever the test sets.
const extras = vi.hoisted(() => ({ queue: { items: [], lanes: [] } as { items: unknown[]; lanes: unknown[] }, burn: new Map<string, number>(), machines: [] as { hostname: string; status: 'online' | 'offline' }[], projects: [] as Record<string, unknown>[], goals: [] as Record<string, unknown>[], ready: true }));
vi.mock('../useCrewExtras', () => ({ useCrewExtras: () => extras }));

import { WorldScene, FIGURE_DRAG_Z } from '../WorldScene';
import { api } from '../../lib/api';
import { CREW_STATUSES } from '../crew';
import { WORK_CYCLE } from '../anim';
import { OUTPOST } from '../sites';
import { FEATURE_BADGES } from '../milestones';
import { KIT } from '../kit';
import { AMBIENT_GROUND, AMBIENT_PROPS } from '../ambient.generated';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public');

const iso = () => new Date().toISOString();
function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    name: over.id, machine: 'm1', repoPath: `/r/${over.id}`, repoName: over.id, branch: 'main',
    currentTask: '', status: 'idle', trustMode: false, plansIncluded: false, mode: 'manual',
    agentType: 'claude', lastSeen: iso(), sessionId: `s-${over.id}`, lastMessage: '',
    pendingQuestion: '', recoveryStatus: '', interruptedAt: '', activeObjective: '', ...over,
  } as Agent;
}
const noop = () => {};
const handlers = {
  onDecidePermission: noop, onSetMode: noop, onSendCommand: noop, onDelete: noop,
  onDismiss: noop, onRestore: noop, onDismissStuck: noop,
};

afterEach(() => { cleanup(); extras.queue = { items: [], lanes: [] }; extras.burn = new Map(); extras.machines = []; extras.projects = []; extras.goals = []; extras.ready = true; live.confers = []; });

describe('WorldScene', () => {
  const agents = [
    ...CREW_STATUSES.map((s) => agent({ id: `repo-${s}`, status: s, currentTask: `task for ${s}` })),
    agent({ id: 'sib', repoName: 'repo-idle', status: 'idle' }),
    agent({ id: 'off', status: 'offline' }),
  ];
  const perms: PermissionRequest[] = [
    { id: 'p1', agentId: 'repo-idle', toolName: 'Bash', toolInput: '', description: 'rm -rf build', status: 'pending', createdAt: iso(), decidedAt: null, response: '' },
  ];

  it('draws one avatar with an overhead panel per cartridge, each naming its work', () => {
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={perms} stuckAlerts={[]} {...handlers} />);
    const panels = screen.getAllByRole('button', { name: /^Crew member / });
    expect(panels).toHaveLength(CREW_STATUSES.length);
    for (const s of CREW_STATUSES) {
      const p = screen.getByRole('button', { name: new RegExp(`^Crew member repo-${s}\\b`) });
      expect(within(p).getByText(`task for ${s}`)).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /^Crew member off\b/ })).toBeNull();
    expect(document.querySelectorAll('.world-member')).toHaveLength(CREW_STATUSES.length);
    // Every crew member whose engine has a drawn sheet gets a figure; nothing is drawn from code.
    expect(document.querySelectorAll('[data-world-avatar]')).toHaveLength(CREW_STATUSES.length);
    expect(document.querySelectorAll('.world-member svg, .world-member canvas')).toHaveLength(0);
    for (const el of document.querySelectorAll<HTMLElement>('[data-world-avatar] > div')) {
      expect(el.style.backgroundImage).toMatch(/\/world\/crew\/[a-z0-9-]+\.png/);
    }
  });

  it('flags the crew member that needs you', () => {
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={perms} stuckAlerts={[]} {...handlers} />);
    const p = screen.getByRole('button', { name: /^Crew member repo-idle\b/ });
    expect(p.getAttribute('data-attention')).toBe('approval');
    expect(within(p).getByText(/needs you/i)).toBeTruthy();
  });

  it('the status filter narrows the crew, and counts are reported for every status', () => {
    const counts = vi.fn();
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} statusFilter="working" onStatusCounts={counts} {...handlers} />);
    expect(screen.getAllByRole('button', { name: /^Crew member / })).toHaveLength(1);
    const last = counts.mock.calls.at(-1)![0];
    expect(last.all).toBe(CREW_STATUSES.length);
    for (const s of CREW_STATUSES) expect(last[s], s).toBe(1);
  });

  it('clicking a crew member opens its cartridge card OVER that figure — not a side drawer — for every crew member', () => {
    // jsdom has no layout, so give the scene a size to place the card in.
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    try {
      render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={perms} stuckAlerts={[]} {...handlers} />);
      expect(screen.queryByTestId('card')).toBeNull();
      const cards = () => [...document.querySelectorAll<HTMLElement>('[data-crew-card]')];
      const lefts = new Set<string>();
      for (const s of CREW_STATUSES) {
        fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Crew member repo-${s}\\b`) }));
        // One card at a time, for the one that was clicked, with every agent of that repo.
        expect(cards()).toHaveLength(1);
        const card = cards()[0];
        expect(card.dataset.crewCard).toBe(`m1:repo-${s}`);
        expect(screen.getByTestId('card').textContent!.split(',').sort()).toEqual(s === 'idle' ? ['repo-idle', 'sib'] : [`repo-${s}`]);
        // It floats: placed by coordinates near the figure, never pinned to the scene's edges.
        expect(card.className).not.toMatch(/\b(top-0|bottom-0|right-0)\b/);
        expect(card.style.left).toMatch(/px$/);
        expect(card.style.top || card.style.bottom).toMatch(/px$/);
        expect(parseFloat(card.style.left)).toBeGreaterThanOrEqual(0);
        expect(parseFloat(card.style.left) + parseFloat(card.style.width)).toBeLessThanOrEqual(1200);
        // See-through, so the map stays visible behind it: 90% and no more.
        expect(card.style.background).toMatch(/0\.9\)$/);
        lefts.add(`${card.style.left}|${card.style.top}|${card.style.bottom}`);
      }
      expect(lefts.size, 'the card follows the figure it belongs to').toBeGreaterThan(1);
      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(screen.queryByTestId('card')).toBeNull();
    } finally {
      w.mockRestore();
    }
  });

  it('says so when nobody is on site, and offers the list', () => {
    const open = vi.fn();
    render(<WorldScene agents={[agent({ id: 'off', status: 'offline' })]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} offSceneCount={2} onOpenList={open} {...handlers} />);
    expect(screen.getByText(/no agents on site/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /2 more in the list/i }));
    expect(open).toHaveBeenCalled();
  });

  it('each avatar plays the cycle its state calls for', () => {
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={perms} stuckAlerts={[]} {...handlers} />);
    const animOf = (repo: string) =>
      screen.getByRole('button', { name: new RegExp(`^Crew member ${repo}\\b`) }).closest('.world-member')!.getAttribute('data-anim');
    // The working agent plays whichever work cycle its site calls for — standing or on the floor.
    const working = screen.getByRole('button', { name: /^Crew member repo-working\b/ }).closest('.world-member')!;
    expect(animOf('repo-working')).toBe(WORK_CYCLE[working.getAttribute('data-work') as 'stand' | 'kneel']);
    expect(animOf('repo-waiting')).toBe('alert');
    expect(animOf('repo-idle')).toBe('alert');      // idle, but it has an approval pending
  });

  it('an agent that arrives later walks in from the entry point, then settles', () => {
    vi.useFakeTimers();
    try {
      const first = [agent({ id: 'early', status: 'idle' })];
      const { rerender } = render(<WorldScene agents={first} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
      // The cycle is recorded on the figure itself, so it is checkable with or without art.
      const avatar = (repo: string) =>
        screen.getByRole('button', { name: new RegExp(`^Crew member ${repo}\\b`) }).closest('.world-member')!;
      // Whoever is there when the scene opens is already at their site.
      expect(avatar('early').getAttribute('data-anim')).toBe('idle');

      rerender(<WorldScene agents={[...first, agent({ id: 'late', status: 'idle' })]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
      // It comes by shuttle: not on the map until the shuttle is down, then it walks out.
      expect(screen.queryByRole('button', { name: /^Crew member late\b/ })).toBeNull();
      for (let t = 0; t < 4600; t += 100) act(() => { vi.advanceTimersByTime(100); });
      expect(avatar('late').getAttribute('data-anim')).toBe('walk');
      expect(avatar('early').getAttribute('data-anim')).toBe('idle');   // and nobody else moves

      act(() => { vi.advanceTimersByTime(20_000); });
      expect(avatar('late').getAttribute('data-anim')).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('working at a floor-level site is a kneeling cycle, facing the object', () => {
    // Fill the plate so every site is occupied by a working agent, then check each against its site.
    const crowd = OUTPOST.sites.map((_, i) => agent({ id: `w${String(i).padStart(2, '0')}`, status: 'working' }));
    render(<WorldScene agents={crowd} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    const figures = [...document.querySelectorAll('.world-member')];
    expect(figures).toHaveLength(OUTPOST.sites.length);
    const seen = new Set<string>();
    for (const el of figures) {
      const site = OUTPOST.sites.find((s) => s.id === el.getAttribute('data-site'))!;
      expect(site, 'figure is not at a known site').toBeDefined();
      seen.add(site.id);
      expect(el.getAttribute('data-anim'), site.id).toBe(WORK_CYCLE[site.work]);
      expect(el.getAttribute('data-facing'), site.id).toBe(String(site.faces));
    }
    expect(seen.size).toBe(OUTPOST.sites.length);
  });

  it('agents on the same engine are still different characters', () => {
    const same = ['a', 'b', 'c'].map((id) => agent({ id, agentType: 'claude', status: 'idle' }));
    render(<WorldScene agents={same} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    const cast = [...document.querySelectorAll('[data-world-avatar]')].map((e) => e.getAttribute('data-world-avatar'));
    expect(cast).toHaveLength(3);
    expect(new Set(cast).size, 'three Claude agents, fewer than three characters').toBe(3);
  });

  it('a crew member can be dragged to a new spot, stays there, and goes back on a double-click', () => {
    localStorage.clear();
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    try {
      const one = [agent({ id: 'mover', status: 'idle' })];
      const { unmount } = render(<WorldScene agents={one} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
      const figure = () => document.querySelector<HTMLElement>('.world-member')!;
      const handle = () => figure().querySelector<HTMLElement>('[data-drag-handle]')!;
      const home = { left: figure().style.left, top: figure().style.top };

      fireEvent.pointerDown(handle(), { clientX: 500, clientY: 250, pointerId: 1, button: 0 });
      fireEvent.pointerMove(handle(), { clientX: 700, clientY: 400, pointerId: 1 });
      fireEvent.pointerUp(handle(), { clientX: 700, clientY: 400, pointerId: 1 });
      const moved = { left: figure().style.left, top: figure().style.top };
      expect(moved).not.toEqual(home);
      expect(parseFloat(moved.left) - parseFloat(home.left)).toBeCloseTo(20, 0);   // 200px of 1000
      expect(parseFloat(moved.top) - parseFloat(home.top)).toBeCloseTo(30, 0);     // 150px of 500
      expect(screen.queryByTestId('card'), 'a drag must not open the cartridge card').toBeNull();

      // Remembered: a fresh scene puts it where it was dropped.
      unmount();
      render(<WorldScene agents={one} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
      expect({ left: figure().style.left, top: figure().style.top }).toEqual(moved);
      expect(screen.getByRole('button', { name: /reset positions/i })).toBeTruthy();

      fireEvent.doubleClick(handle());
      expect(screen.queryByRole('button', { name: /reset positions/i })).toBeNull();
    } finally {
      rect.mockRestore();
      localStorage.clear();
    }
  });

  it('a plain click on the figure still opens its cartridge card', () => {
    render(<WorldScene agents={[agent({ id: 'solo', status: 'idle' })]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    const handle = document.querySelector<HTMLElement>('[data-drag-handle]')!;
    fireEvent.pointerDown(handle, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerUp(handle, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(screen.getByTestId('card').textContent).toBe('solo');
  });

  it('an approval can be allowed or denied straight from the panel — both decisions', () => {
    for (const decision of ['allowed', 'denied'] as const) {
      const decide = vi.fn();
      const { unmount } = render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={perms} stuckAlerts={[]} {...handlers} onDecidePermission={decide} />);
      const figure = screen.getByRole('button', { name: /^Crew member repo-idle\b/ }).closest('.world-member') as HTMLElement;
      fireEvent.click(within(figure).getByRole('button', { name: decision === 'allowed' ? /^approve/i : /^deny/i }));
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith('p1', decision);
      expect(screen.queryByTestId('card'), 'deciding must not also open the card').toBeNull();
      unmount();
    }
  });

  it('a question cannot be answered with a button — it opens the card instead', () => {
    const asks: PermissionRequest[] = [{ ...perms[0], toolName: 'AskUserQuestion', description: 'Which rounding?' }];
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={asks} stuckAlerts={[]} {...handlers} />);
    const figure = screen.getByRole('button', { name: /^Crew member repo-idle\b/ }).closest('.world-member') as HTMLElement;
    expect(within(figure).queryByRole('button', { name: /^approve/i })).toBeNull();
    fireEvent.click(within(figure).getByRole('button', { name: /^answer/i }));
    expect(screen.getByTestId('card')).toBeTruthy();
  });

  it('a stuck agent gets its own red marker, and nobody else does', () => {
    const stuck = [{ agentId: 'repo-working', pattern: 'loop', severity: 'high' as const, suggestion: 'nudge it', detectedAt: iso() }];
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={stuck} {...handlers} />);
    const markers = document.querySelectorAll('[data-stuck-marker]');
    expect(markers).toHaveLength(1);
    expect(markers[0].closest('.world-member')!.querySelector('button')!.getAttribute('aria-label')).toMatch(/^Crew member repo-working\b/);
  });

  it('the panel shows what is queued behind the agent and how hard it is burning', () => {
    extras.queue = {
      items: [
        { id: 'q1', kind: 'prompt', payload: {}, targets: [], lane: 'agent:repo-working', status: 'queued', position: 1, handle: '', result: '' },
        { id: 'q2', kind: 'prompt', payload: {}, targets: [], lane: 'agent:repo-working', status: 'queued', position: 2, handle: '', result: '' },
        { id: 'q3', kind: 'prompt', payload: {}, targets: [], lane: 'agent:repo-working', status: 'done', position: 3, handle: '', result: '' },
      ],
      lanes: [],
    };
    extras.burn = new Map([['m1:repo-working', 2_400_000], ['m1:repo-idle', 600_000]]);
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    const working = screen.getByRole('button', { name: /^Crew member repo-working\b/ }).closest('.world-member') as HTMLElement;
    expect(within(working).getByText(/2 queued/i)).toBeTruthy();
    // …and the same two items are a stack of two crates at its feet.
    expect(working.querySelector('[data-queue-crates]')!.getAttribute('data-queue-crates')).toBe('crate-2');
    expect(working.querySelector<HTMLImageElement>('[data-queue-crates]')!.getAttribute('src')).toBe('/world/kit/crate-2.png');
    expect(within(working).getByText(/2\.4M\/h/)).toBeTruthy();
    expect(working.querySelector('[data-burn]')!.getAttribute('data-burn')).toBe('1.00');
    const idle = screen.getByRole('button', { name: /^Crew member repo-idle\b/ }).closest('.world-member') as HTMLElement;
    expect(idle.querySelector('[data-burn]')!.getAttribute('data-burn')).toBe('0.25');
    expect(within(idle).queryByText(/queued/i)).toBeNull();
    expect(idle.querySelector('[data-queue-crates]')).toBeNull();
    // No burn recorded → no bar at all.
    const waiting = screen.getByRole('button', { name: /^Crew member repo-waiting\b/ }).closest('.world-member') as HTMLElement;
    expect(waiting.querySelector('[data-burn]')).toBeNull();
  });

  it('a selected crew card opens the agent\'s full final answer', async () => {
    localStorage.clear();
    const full = vi.spyOn(api, 'getFinalAnswer').mockResolvedValue({ text: 'Everything it said, in full.', complete: true, sessionId: 's', at: new Date().toISOString() });
    render(<WorldScene agents={[agent({ id: 'reader', status: 'working', lastMessage: 'Working on it.' })]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    expect(screen.queryByRole('button', { name: /final answer/i })).toBeNull();
    fireEvent.click(document.querySelector<HTMLElement>('.world-member button[aria-pressed]')!);
    fireEvent.click(screen.getByRole('button', { name: /final answer/i }));
    expect(full).toHaveBeenCalledWith('reader');
    expect(await screen.findByText('Everything it said, in full.')).toBeTruthy();
    full.mockRestore();
  });

  it('a finished agent shows its last message over its head until it is read — for idle agents only', async () => {
    localStorage.clear();
    const said = 'The login redirect is fixed. I added a regression test and it passes.';
    const withMessages = CREW_STATUSES.map((st) => agent({ id: `said-${st}`, status: st, lastMessage: said }));
    const { unmount } = render(<WorldScene agents={withMessages} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    const bubbles = () => [...document.querySelectorAll<HTMLElement>('[data-finished-bubble]')];
    // One bubble, on the agent that is finished (idle) — not on one still working or waiting on you.
    expect(bubbles()).toHaveLength(1);
    const owner = bubbles()[0].closest('.world-member')!.querySelector('button[aria-pressed]')!.getAttribute('aria-label')!;
    expect(owner).toMatch(/^Crew member said-idle\b/);
    expect(bubbles()[0].textContent).toMatch(/login redirect is fixed/);

    // It is still there after a reload…
    unmount();
    const again = render(<WorldScene agents={withMessages} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    expect(bubbles()).toHaveLength(1);
    // Clicked, it opens the agent's FULL final answer (not the card); closing that is reading it —
    // the bubble goes, and stays gone.
    const full = vi.spyOn(api, 'getFinalAnswer').mockResolvedValue({ text: `${said} And the whole rest of the answer.`, complete: true, sessionId: 's', at: new Date().toISOString() });
    fireEvent.click(bubbles()[0]);
    expect(full).toHaveBeenCalledWith('said-idle');
    const dialog = screen.getByRole('dialog', { name: /final answer/i });
    expect(screen.queryByTestId('card')).toBeNull();
    await waitFor(() => expect(dialog.textContent).toMatch(/whole rest of the answer/));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bubbles()).toHaveLength(0);
    full.mockRestore();
    again.unmount();
    const third = render(<WorldScene agents={withMessages} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    expect(bubbles()).toHaveLength(0);

    // A new message from the same agent brings it back.
    third.rerender(<WorldScene agents={withMessages.map((a) => ({ ...a, lastMessage: 'Second task done too.' }))} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].textContent).toMatch(/Second task done too/);
    localStorage.clear();
  });

  it('the scenery is placed sprites; pads are named after machines, and a machine being online parks no shuttle', () => {
    const structures = () => [...document.querySelectorAll<HTMLImageElement>('[data-structure]')];
    const shuttles = () => [...document.querySelectorAll<HTMLElement>('[data-shuttle]')];
    const expected = OUTPOST.structures.filter((st) => !st.when);
    const none = render(<WorldScene agents={[]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    expect(structures().map((e) => e.dataset.structure).sort()).toEqual(expected.map((st) => st.id).sort());
    expect(shuttles()).toHaveLength(0);
    none.unmount();

    // Every machine state: offline, online by the runner, online because an agent is live on it.
    extras.machines = [{ hostname: 'studio', status: 'offline' }, { hostname: 'laptop', status: 'online' }];
    const viaRunner = render(<WorldScene agents={[]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    const names = () => [...document.querySelectorAll<HTMLElement>('[data-pad-label]')].map((e) => `${e.dataset.padLabel}:${e.textContent}`);
    // One dock (servers are not linked): the machine online holds it; an offline one gets none.
    expect(names()).toEqual(['pad-north:laptop']);
    expect(shuttles(), 'the shuttle flies for a launch, not for a machine').toHaveLength(0);
    viaRunner.unmount();

    extras.machines = [{ hostname: 'studio', status: 'online' }];
    render(<WorldScene agents={[agent({ id: 'live', status: 'idle', machine: 'laptop.local' })]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    expect(names()).toEqual(['pad-north:laptop']);
    expect(shuttles()).toHaveLength(0);
  });

  it('the map zooms in and out with the buttons, within its limits, and resets', () => {
    // jsdom has no layout, so give the scene a size to zoom within.
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    try {
      render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
      const scene = screen.getByTestId('world-scene');
      const zoom = () => Number(scene.getAttribute('data-zoom'));
      const zin = screen.getByRole('button', { name: 'Zoom in' });
      const zout = screen.getByRole('button', { name: 'Zoom out' });
      expect(zoom()).toBe(1);
      expect((zout as HTMLButtonElement).disabled, 'cannot zoom out past the whole map').toBe(true);
      fireEvent.click(zin);
      expect(zoom()).toBeCloseTo(1.25, 2);
      for (let i = 0; i < 20; i++) fireEvent.click(zin);
      expect(zoom()).toBe(4);
      expect((zin as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(zout);
      expect(zoom()).toBeLessThan(4);
      fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
      expect(zoom()).toBe(1);
    } finally {
      w.mockRestore();
    }
  });

  it('grabbing the ground of a zoomed map moves it by exactly as far as the pointer went — however fast the moves come', () => {
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    try {
      render(<WorldScene agents={[]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      const stage = document.querySelector<HTMLElement>('[data-world-stage]')!;
      const ground = stage.querySelector('img')!;
      expect(ground.className).toContain('cursor-grab');
      const at = () => ({ x: parseFloat(stage.style.left), y: parseFloat(stage.style.top) });
      // 1 move, then bursts of 3 and 8 moves that arrive before the screen repaints.
      for (const moves of [1, 3, 8]) {
        for (const dir of [-1, 1]) {
          const before = at();
          act(() => {
            fireEvent.pointerDown(ground, { clientX: 600, clientY: 400, pointerId: 1, button: 0 });
            for (let i = 1; i <= moves; i++) fireEvent.pointerMove(ground, { clientX: 600 + dir * 10 * i, clientY: 400 + dir * 5 * i, pointerId: 1 });
            fireEvent.pointerUp(ground, { clientX: 600 + dir * 10 * moves, clientY: 400 + dir * 5 * moves, pointerId: 1 });
          });
          expect(at().x - before.x, `${moves} moves, x`).toBeCloseTo(dir * 10 * moves, 3);
          expect(at().y - before.y, `${moves} moves, y`).toBeCloseTo(dir * 5 * moves, 3);
        }
      }
    } finally {
      w.mockRestore();
    }
  });

  it('status drives the look, not the place: finishing jumps, then the agent stands idle where it is; starting work is the work cycle on the same spot', () => {
    vi.useFakeTimers();
    try {
      const at = (st: Agent['status']) => [agent({ id: 'mover', status: st })];
      const scene = (st: Agent['status']) => <WorldScene agents={at(st)} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />;
      const { rerender } = render(scene('working'));
      const figure = () => document.querySelector<HTMLElement>('.world-member')!;
      const anim = () => figure().getAttribute('data-anim');
      const where = () => `${figure().style.left},${figure().style.top}`;
      const site = where();
      expect(Object.values(WORK_CYCLE)).toContain(anim());

      // The turn finishes: a jump on the spot first…
      rerender(scene('idle'));
      expect(anim()).toBe('jump');
      expect(where()).toBe(site);
      // …then it stands still, right where it worked: there is nowhere else for an idle agent to go.
      act(() => { vi.advanceTimersByTime(1400); });
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(anim(), 'idle: standing still').toBe('idle');
      expect(figure().getAttribute('data-resting')).toBeNull();
      expect(figure().getAttribute('data-seat')).toBeNull();
      expect(where()).toBe(site);

      // Work starts again: the work cycle, same spot.
      rerender(scene('working'));
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(Object.values(WORK_CYCLE)).toContain(anim());
      expect(where()).toBe(site);

      // Needing you: an idle agent with an approval stays at its site and waves.
      rerender(<WorldScene agents={at('idle')} activitiesByAgent={{}} pendingPermissions={[{ id: 'pz', agentId: 'mover', toolName: 'Bash', toolInput: '', description: 'x', status: 'pending', createdAt: iso(), decidedAt: null, response: '' }]} stuckAlerts={[]} {...handlers} />);
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(anim()).toBe('alert');
      expect(where()).toBe(site);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stuck agent calls out', () => {
    const stuck = [{ agentId: 'repo-working', pattern: 'loop', severity: 'high' as const, suggestion: 'nudge it', detectedAt: iso() }];
    render(<WorldScene agents={agents} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={stuck} {...handlers} />);
    expect(screen.getByRole('button', { name: /^Crew member repo-working\b/ }).closest('.world-member')!.getAttribute('data-anim')).toBe('call');
  });

  it('launching a cartridge brings the shuttle in: it lands, the new agent steps out of the landing zone, and it takes off again', () => {
    vi.useFakeTimers();
    try {
      const scene = (list: Agent[]) => <WorldScene agents={list} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />;
      const ship = () => document.querySelector<HTMLElement>('[data-shuttle]');
      const crewOnMap = () => document.querySelectorAll('.world-member').length;
      const step = (ms: number, each?: () => void) => { for (let t = 0; t < ms; t += 100) { each?.(); act(() => { vi.advanceTimersByTime(100); }); } };
      // An EMPTY scene, open for a while — the case a first launch starts from.
      const { rerender } = render(scene([]));
      step(5000);
      expect(ship()).toBeNull();

      rerender(scene([agent({ id: 'fresh', status: 'working' })]));
      // The shuttle is on its way in; the agent is not on the map yet.
      expect(ship()!.dataset.shuttlePhase).toBe('landing');
      expect(ship()!.dataset.shuttle).toBe('pad-north');
      expect(crewOnMap()).toBe(0);
      const frames: string[] = [];
      step(4200, () => { if (frames[frames.length - 1] !== ship()!.dataset.frame) frames.push(ship()!.dataset.frame!); expect(crewOnMap(), 'nobody steps out of a shuttle still in the air').toBe(0); });
      expect(frames, 'airborne, legs down, engines cutting').toEqual(['3', '2', '1']);
      step(400);
      // Down: the agent appears at the pad's door and walks to its site.
      expect(ship()!.dataset.shuttlePhase).toBe('landed');
      expect(crewOnMap()).toBe(1);
      const fig = document.querySelector<HTMLElement>('.world-member')!;
      expect(fig.dataset.anim).toBe('walk');
      // Then the shuttle leaves and the pad is empty again.
      const leaving: string[] = [];
      step(9000, () => { if (ship() && ship()!.dataset.shuttlePhase === 'leaving' && leaving[leaving.length - 1] !== ship()!.dataset.frame) leaving.push(ship()!.dataset.frame!); });
      expect(leaving).toEqual(['1', '2', '3']);
      expect(ship()).toBeNull();
      expect(document.querySelector<HTMLElement>('.world-member')!.dataset.anim).not.toBe('walk');
      expect(crewOnMap()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the pond, the hologram and the water station move all the time — with nobody on the map and nothing happening', () => {
    render(<WorldScene agents={[]} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />);
    const strips = [...document.querySelectorAll<HTMLElement>('[data-ambient]')];
    // Every ambient thing the art build produced is on the map, exactly once.
    const want = [...Object.keys(AMBIENT_GROUND), ...OUTPOST.structures.filter((st) => AMBIENT_PROPS[st.sprite]).map((st) => st.id)].sort();
    expect(want).toEqual(expect.arrayContaining(['pond', 'holo-table', 'water-station', 'dish']));
    expect(strips.map((e) => e.dataset.ambient).sort()).toEqual(want);
    for (const el of strips) {
      const strip = el.querySelector<HTMLElement>('.world-strip')!;
      const art = AMBIENT_GROUND[el.dataset.ambient!] ?? AMBIENT_PROPS[OUTPOST.structures.find((st) => st.id === el.dataset.ambient)!.sprite];
      // A drawn strip, stepped frame by frame, looping for ever, and never in the way of a click.
      expect(strip.style.backgroundImage).toContain(art.src);
      expect(strip.style.animationTimingFunction).toBe(`steps(${art.frames})`);
      expect(parseFloat(strip.style.animationDuration)).toBeCloseTo(art.frames / art.fps, 3);
      expect(strip.style.width).toBe(`${art.frames * 100}%`);
      expect(el.className).toContain('pointer-events-none');
      expect(art.frames).toBeGreaterThanOrEqual(4);
      expect(existsSync(resolve(PUBLIC, `.${art.src}`)), `${art.src} is missing from public/`).toBe(true);
    }
    // A moving structure is drawn at the same scale as its still sprite, however much room its motion needs.
    for (const st of OUTPOST.structures.filter((x) => AMBIENT_PROPS[x.sprite])) {
      const el = document.querySelector<HTMLElement>(`[data-ambient="${st.id}"]`)!;
      const art = AMBIENT_PROPS[st.sprite];
      expect(parseFloat(el.style.width), st.id).toBeCloseTo(st.w * (art.w / KIT[st.sprite].w) * 100, 3);
      expect(art.w).toBeGreaterThanOrEqual(KIT[st.sprite].w);
    }
    // Structures that are animated are still the structures they were.
    expect(document.querySelector('[data-structure="holo-table"]')).toBe(document.querySelector('[data-ambient="holo-table"]'));
  });

  // ── The connections: project → zone, repo → building, feature → gate, confer → table ──────

  const atlas = {
    id: 'p1', name: 'Atlas', color: '#2EE6D6', primaryRepo: '/code/gl-dev', createdAt: '2026-01-01T00:00:00Z',
    cartridges: ['/code/gl-dev', '/code/license-server'], featureCount: 3, featuresDone: 1, featuresActive: 0,
  };
  const scene = (list: Agent[]) => <WorldScene agents={list} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />;
  const figure = (name: string) => screen.getByRole('button', { name: new RegExp(`^Crew member ${name}\\b`) }).closest<HTMLElement>('.world-member')!;

  it('every agent of a project works at its own repo\'s building; the others keep off the project\'s land', () => {
    extras.projects = [atlas];
    const list = [
      agent({ id: 'gl-dev', repoPath: '/code/gl-dev', status: 'working' }),
      agent({ id: 'license-server', repoPath: '/Code/License-Server/', status: 'working' }),
      agent({ id: 'neoncore', repoPath: '/code/neoncore', status: 'working' }),
      agent({ id: 'scratch', repoPath: '/tmp/x/gl-dev', status: 'working' }),
    ];
    render(scene(list));
    const siteOf = (name: string) => OUTPOST.sites.find((s) => s.id === figure(name).dataset.site)!;
    // Each of the project's agents stands in the project's pod, at a building.
    for (const repo of ['gl-dev', 'license-server']) {
      expect(siteOf(repo).district, repo).toBe('nw');
      expect(siteOf(repo).at, repo).toBeTruthy();
    }
    expect(siteOf('gl-dev').at).not.toBe(siteOf('license-server').at);
    // A repo whose character is on the map needs no name plate: the character says it.
    expect(document.querySelectorAll('[data-building-label]')).toHaveLength(0);
    // The project's name is on its district, with how far its features are.
    const plate = document.querySelector<HTMLElement>('[data-zone-label]')!;
    expect(plate.textContent).toContain('Atlas');
    expect(plate.textContent).toContain('1/3');
    expect(plate.dataset.zoneLabel).toBe('nw');
    for (const other of ['neoncore', 'scratch']) expect(siteOf(other).district, other).not.toBe('nw');
  });

  it('a building is named only for the repos that have no character on the map — for every mix of present and absent', () => {
    extras.projects = [{ ...atlas, cartridges: ['/code/a', '/code/b', '/code/c'] , primaryRepo: '/code/a' }];
    const plates = () => [...document.querySelectorAll<HTMLElement>('[data-building-label]')].flatMap((e) => e.textContent!.split(' · ')).sort();
    const repos = ['a', 'b', 'c'];
    for (let mask = 0; mask < 8; mask++) {
      const present = repos.filter((_, i) => mask & (1 << i));
      const view = render(scene(present.map((r) => agent({ id: r, repoPath: `/code/${r}`, status: 'working' }))));
      expect(plates(), `present: ${present.join(',') || 'nobody'}`).toEqual(repos.filter((r) => !present.includes(r)));
      view.unmount();
    }
  });

  it.each(CREW_STATUSES)('a %s agent of a project is at its building in its project\'s pod — idle included: there are no benches to go to', (status) => {
    extras.projects = [atlas];
    render(scene([
      agent({ id: 'gl-dev', repoPath: '/code/gl-dev', status }),
      agent({ id: 'neoncore', repoPath: '/code/neoncore', status }),
    ]));
    const pct = (v: number) => `${v * 100}%`;
    const mine = figure('gl-dev');
    const other = figure('neoncore');
    expect(OUTPOST.sites.find((x) => x.id === mine.dataset.site)!.district).toBe('nw');
    for (const el of [mine, other]) {
      const site = OUTPOST.sites.find((x) => x.id === el.dataset.site)!;
      expect([el.style.left, el.style.top], `${status}: not at its site`).toEqual([pct(site.x), pct(site.y)]);
      expect(el.dataset.anim).not.toBe('sit');
      expect(el.dataset.seat).toBeUndefined();
      expect(el.dataset.resting).toBeUndefined();
      if (status === 'idle') expect(el.dataset.anim).toBe('idle');
    }
  });

  it('the map has no benches: a whole idle crew stands at its buildings, nobody sits, nobody shares a spot', () => {
    extras.projects = [{ ...atlas, cartridges: Array.from({ length: 5 }, (_, i) => `/code/r${i}`), primaryRepo: '/code/r0' }];
    const crew = [
      ...Array.from({ length: 5 }, (_, i) => agent({ id: `r${i}`, repoPath: `/code/r${i}`, status: 'idle' })),
      ...Array.from({ length: 7 }, (_, i) => agent({ id: `free${i}`, repoPath: `/code/free${i}`, status: 'idle' })),
    ];
    const { container } = render(scene(crew));
    const figures = [...document.querySelectorAll<HTMLElement>('.world-member')];
    expect(figures).toHaveLength(12);
    expect(new Set(figures.map((f) => `${f.style.left},${f.style.top}`)).size, 'two agents in exactly the same place').toBe(12);
    expect(figures.every((f) => f.dataset.anim === 'idle' && f.dataset.seat === undefined)).toBe(true);
    // Not one bench drawn, of all the things on the map.
    expect([...container.querySelectorAll('img')].filter((img) => /bench/.test(img.getAttribute('src') ?? ''))).toHaveLength(0);
  });

  it('nothing is drawn until the records have loaded, so nobody walks across the map on opening', () => {
    extras.ready = false;
    extras.machines = [{ hostname: 'laptop', status: 'online' }];
    const { rerender } = render(scene([agent({ id: 'a', status: 'working' })]));
    expect(document.querySelectorAll('.world-member, [data-gate]')).toHaveLength(0);
    extras.ready = true;
    rerender(scene([agent({ id: 'a', status: 'working' })]));
    expect(document.querySelectorAll('.world-member')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.world-member')!.dataset.anim).not.toBe('walk');
    expect(document.querySelector('[data-shuttle]'), 'agents already here did not just arrive').toBeNull();
  });

  it('a district\'s gate is open while its project has a feature under way — it opens and closes frame by frame', () => {
    vi.useFakeTimers();
    try {
      const gates = () => [...document.querySelectorAll<HTMLElement>('[data-gate]')];
      const run = (ms: number) => { for (let t = 0; t < ms; t += 50) act(() => { vi.advanceTimersByTime(50); }); };
      extras.projects = [atlas];
      const { rerender } = render(scene([]));
      // One gate per gated district, all closed: no project has a feature under way.
      expect(gates()).toHaveLength(OUTPOST.structures.filter((st) => st.gate).length);
      expect(gates().every((g) => g.dataset.gate === 'closed' && g.dataset.frame === '0')).toBe(true);

      extras.projects = [{ ...atlas, featuresActive: 1 }];
      rerender(scene([]));
      const mine = () => gates().filter((g) => g.dataset.gate === 'open');
      expect(mine().map((g) => g.dataset.district), 'only the project\'s own district opens').toEqual(['nw']);
      const seen = new Set<string>();
      for (let t = 0; t < 1500; t += 50) { seen.add(mine()[0].dataset.frame!); act(() => { vi.advanceTimersByTime(50); }); }
      expect([...seen].sort()).toEqual(['0', '1', '2', '3']);
      expect(mine()[0].dataset.frame).toBe('3');

      extras.projects = [atlas];
      rerender(scene([]));
      run(1500);
      expect(gates().every((g) => g.dataset.gate === 'closed' && g.dataset.frame === '0')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the participants of a running confer gather at the commons table, and go back when it ends', () => {
    const list = [agent({ id: 'a', status: 'working' }), agent({ id: 'b', status: 'idle' }), agent({ id: 'c', status: 'working' })];
    live.confers = [{ id: 'k', status: 'running', participantIds: ['a', 'b'] }];
    const { rerender } = render(scene(list));
    const meet = OUTPOST.meet.map((s) => s.id);
    for (const name of ['a', 'b']) {
      expect(meet, `${name} should be at the table`).toContain(figure(name).dataset.site);
      expect(figure(name).dataset.meeting).toBe('true');
      expect(figure(name).dataset.resting, 'an idle participant stays at the table').toBeUndefined();
    }
    expect(figure('a').dataset.site).not.toBe(figure('b').dataset.site);
    expect(meet).not.toContain(figure('c').dataset.site);

    live.confers = [{ id: 'k', status: 'completed', participantIds: ['a', 'b'] }];
    rerender(scene(list));
    for (const name of ['a', 'b', 'c']) {
      expect(meet).not.toContain(figure(name).dataset.site);
      expect(figure(name).dataset.meeting).toBeUndefined();
    }
  });

  it('a confer among agents of ONE project leaves them in their pod; one across projects brings them to the table', () => {
    extras.projects = [atlas, { ...atlas, id: 'p2', name: 'Other', cartridges: ['/code/x'], primaryRepo: '/code/x' }];
    const list = [
      agent({ id: 'gl-dev', repoPath: '/code/gl-dev', status: 'working' }),
      agent({ id: 'license-server', repoPath: '/code/license-server', status: 'working' }),
      agent({ id: 'x', repoPath: '/code/x', status: 'working' }),
    ];
    const meet = OUTPOST.meet.map((m) => m.id);
    live.confers = [{ id: 'k', status: 'running', participantIds: ['gl-dev', 'license-server'] }];
    const view = render(scene(list));
    for (const name of ['gl-dev', 'license-server', 'x']) expect(meet, `${name} left its pod for a confer inside one project`).not.toContain(figure(name).dataset.site);
    expect(OUTPOST.sites.find((st) => st.id === figure('gl-dev').dataset.site)!.district).toBe('nw');
    live.confers = [{ id: 'k', status: 'running', participantIds: ['gl-dev', 'x'] }];
    view.rerender(scene(list));
    for (const name of ['gl-dev', 'x']) expect(meet, name).toContain(figure(name).dataset.site);
    expect(meet).not.toContain(figure('license-server').dataset.site);
  });

  it('a new agent arrives on its own machine\'s pad; one whose session ends walks back to that pad, the shuttle collects it, and both are gone', () => {
    vi.useFakeTimers();
    try {
      extras.machines = [{ hostname: 'alpha', status: 'online' }, { hostname: 'beta', status: 'online' }];
      const pct = (v: number) => `${v * 100}%`;
      const door = (pad: string) => OUTPOST.structures.find((st) => st.id === pad)!.door!;
      const ships = () => [...document.querySelectorAll<HTMLElement>('[data-shuttle]')].map((e) => e.dataset.shuttle);
      const step = (ms: number) => { for (let t = 0; t < ms; t += 100) act(() => { vi.advanceTimersByTime(100); }); };
      const stay = agent({ id: 'stay', status: 'working', machine: 'alpha' });
      const { rerender } = render(scene([stay]));
      rerender(scene([stay, agent({ id: 'late', status: 'working', machine: 'beta.local' })]));
      // One dock: a second machine's agents land on it too.
      expect(ships(), 'beta lands on the one dock').toEqual(['pad-north']);
      step(4600);
      const late = figure('late');
      expect(late.dataset.anim).toBe('walk');
      step(15000);
      expect(ships()).toEqual([]);
      const at = [figure('late').style.left, figure('late').style.top];
      expect(at).not.toEqual([pct(door('pad-north').x), pct(door('pad-north').y)]);

      // Its session ends: the figure is replaced by one walking back to the pad; the shuttle comes for it.
      rerender(scene([stay]));
      expect(screen.queryByRole('button', { name: /^Crew member late\b/ })).toBeNull();
      const ghost = () => document.querySelector<HTMLElement>('[data-departing]');
      expect(ghost()!.dataset.departing).toBe('beta.local:late');
      expect([ghost()!.style.left, ghost()!.style.top], 'starts where the agent stood').toEqual(at);
      expect(ships()).toEqual(['pad-north']);
      act(() => { vi.advanceTimersByTime(50); });
      expect([ghost()!.style.left, ghost()!.style.top], 'heads for the dock').toEqual([pct(door('pad-north').x), pct(door('pad-north').y)]);
      step(20000);
      expect(ghost()).toBeNull();
      expect(ships()).toEqual([]);
      expect(document.querySelectorAll('.world-member')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });


  // ── Deadlines, delivery and rewards (milestones.ts) ────────────────────────────────────

  const DAY = 24 * 60 * 60 * 1000;
  const dated = (left: number, total = 100) => ({
    id: `g${left}`, projectId: 'p1', status: 'active', origin: '',
    createdAt: new Date(Date.now() - (total - left) * DAY).toISOString(), targetDate: new Date(Date.now() + left * DAY + 60_000).toISOString(),
  });

  it.each([[90, 'ok', '0'], [60, 'ok', '1'], [30, 'ok', '2'], [15, 'tight', '3'], [5, 'tight', '4'], [-2, 'overdue', '6']] as const)(
    'with %i days left of 100 the pod\'s oxygen gauge reads %s (frame %s)', (left, state, frame) => {
      extras.projects = [atlas];
      extras.goals = [dated(left)];
      render(scene([]));
      const gauges = [...document.querySelectorAll<HTMLElement>('[data-deadline]')];
      expect(gauges, 'one gauge, in the project\'s own district').toHaveLength(1);
      expect(gauges[0].dataset.deadline).toBe('nw');
      expect(gauges[0].dataset.deadlineState).toBe(state);
      expect(gauges[0].dataset.frame).toBe(frame);
      expect(gauges[0].getAttribute('src')).toContain(`gauge-${frame}`);
    });

  it('a project with no dated open feature has no gauge, and the red light of a tight one blinks', () => {
    vi.useFakeTimers();
    try {
      extras.projects = [atlas];
      const { rerender } = render(scene([]));
      expect(document.querySelector('[data-deadline]')).toBeNull();
      extras.goals = [dated(5)];
      rerender(scene([]));
      const frames = new Set<string>();
      for (let t = 0; t < 2400; t += 100) { frames.add(document.querySelector<HTMLElement>('[data-deadline]')!.dataset.frame!); act(() => { vi.advanceTimersByTime(100); }); }
      expect([...frames].sort()).toEqual(['4', '5']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the pennant shows how much of the plan is delivered, and a flare goes up for each new delivery', () => {
    vi.useFakeTimers();
    try {
      const plan = (done: number) => [{ ...atlas, featureCount: 4, featuresDone: done }];
      const pennant = () => document.querySelector<HTMLElement>('[data-pennant]');
      const flares = () => document.querySelectorAll('[data-burst]').length;
      const settle = () => { for (let t = 0; t < 2500; t += 100) act(() => { vi.advanceTimersByTime(100); }); };
      extras.projects = [{ ...atlas, featureCount: 0, featuresDone: 0 }];
      const { rerender } = render(scene([]));
      expect(pennant(), 'nothing planned: no pole').toBeNull();
      // What is already delivered when the scene opens is simply shown: no flare for old news.
      extras.projects = plan(1);
      rerender(scene([]));
      settle();
      expect(flares()).toBe(0);
      const seen: string[] = [];
      for (const done of [1, 2, 3, 4]) {
        extras.projects = plan(done);
        rerender(scene([]));
        if (done > 1) expect(flares(), `delivery ${done} sends up a flare`).toBe(1);
        settle();
        expect(flares(), 'the flare burns out').toBe(0);
        seen.push(pennant()!.dataset.frame!);
      }
      expect(seen).toEqual(['1', '2', '2', '3']);
      // Fewer delivered (a feature reopened) is not a celebration.
      extras.projects = plan(3);
      rerender(scene([]));
      expect(flares()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([['scoping', 0], ['clarifying', 1], ['planning', 2], ['proposed', 3], ['staffing', 4], ['running', 5], ['completed', 6]] as const)(
    'a feature in %s has earned %i badges on its project\'s banner', (phase, n) => {
      extras.projects = [atlas];
      extras.goals = [{ id: 'g', projectId: 'p1', status: 'active', origin: '', updatedAt: '2026-11-19T10:00:00Z', pilot: { phase } }];
      render(scene([]));
      const row = [...document.querySelectorAll<HTMLElement>('[data-zone-label="nw"] [data-badge]')];
      // Seven places, in the order of the process; the earned ones are lit, the rest are faint.
      expect(row.map((e) => e.dataset.badge)).toEqual(FEATURE_BADGES.map((b) => b.step));
      expect(row.filter((e) => e.dataset.earned === 'true').map((e) => e.dataset.badge)).toEqual(FEATURE_BADGES.slice(0, n).map((b) => b.step));
    });

  it('the banner has no badge row until a feature has been started, shows all seven once one is delivered, and resets when the next starts', () => {
    extras.projects = [atlas];
    const earned = () => document.querySelectorAll('[data-zone-label="nw"] [data-badge][data-earned="true"]').length;
    const view = render(scene([]));
    expect(document.querySelectorAll('[data-badge]')).toHaveLength(0);
    const done = { id: 'd', projectId: 'p1', status: 'achieved', origin: '', updatedAt: '2026-11-19T09:00:00Z', doneAt: '2026-11-19T09:00:00Z', pilot: { phase: 'completed' } };
    extras.goals = [done];
    view.rerender(scene([]));
    expect(earned()).toBe(7);
    extras.goals = [done, { id: 'n', projectId: 'p1', status: 'active', origin: '', updatedAt: '2026-11-19T12:00:00Z', pilot: { phase: 'clarifying' } }];
    view.rerender(scene([]));
    expect(earned()).toBe(1);
    // The earlier design is gone: nothing is placed in the commons, and there is no separate medal.
    expect(document.querySelectorAll('[data-reward], [data-medal]')).toHaveLength(0);
  });

  it('LAYERS: a project banner is above every character, and every character is above all the scenery — wherever they stand', () => {
    extras.projects = [atlas, { ...atlas, id: 'p2', name: 'Other', cartridges: ['/code/x'], primaryRepo: '/code/x', featureCount: 2, featuresDone: 1 }];
    extras.goals = [{ id: 'g', projectId: 'p1', status: 'active', origin: '', updatedAt: '2026-11-19T10:00:00Z', createdAt: new Date(Date.now() - 50 * DAY).toISOString(), targetDate: new Date(Date.now() + 5 * DAY).toISOString(), pilot: { phase: 'running' } }];
    // A crowd, so characters stand at the very top and the very bottom of the map; one finished, one needing you.
    const crowd = [
      ...OUTPOST.sites.map((_, i) => agent({ id: `w${String(i).padStart(2, '0')}`, status: i % 3 === 0 ? 'idle' : 'working', lastMessage: i === 0 ? 'All done.' : '' })),
      agent({ id: 'gl-dev', repoPath: '/code/gl-dev', status: 'waiting' }),
    ];
    render(scene(crowd));
    const z = (el: Element) => Number((el as HTMLElement).style.zIndex || 0);
    const banners = [...document.querySelectorAll('[data-zone-label]')];
    const characters = [...document.querySelectorAll('.world-member')];
    const scenery = [...document.querySelectorAll('[data-structure], [data-ambient], [data-deadline], [data-pennant], [data-building-label], [data-pad-label]')];
    expect(banners.length).toBe(2);
    expect(characters.length).toBe(crowd.length);
    expect(scenery.length).toBeGreaterThan(15);
    const lowestCharacter = Math.min(...characters.map(z));
    const highestCharacter = Math.max(...characters.map(z));
    expect(Math.max(...scenery.map(z)), 'something in the scenery is drawn over a character').toBeLessThan(lowestCharacter);
    // Above a character at rest, one being hovered (index.css) and one being dragged.
    const css = readFileSync(resolve(PUBLIC, '../src/index.css'), 'utf8');
    const hover = Number(/\.world-member:hover[^{]*\{\s*z-index:\s*(\d+)/.exec(css)![1]);
    for (const b of banners) expect(z(b), 'a character is drawn over a project banner').toBeGreaterThan(Math.max(highestCharacter, hover, FIGURE_DRAG_Z));
    // Among themselves, characters still sort by where they stand: nearer the bottom, nearer the front.
    const byY = characters.map((c) => ({ y: parseFloat((c as HTMLElement).style.top), z: z(c), bubble: c.querySelector('[data-finished-bubble]') !== null })).filter((c) => !c.bubble).sort((a, b) => a.y - b.y);
    for (let i = 1; i < byY.length; i++) expect(byY[i].z).toBeGreaterThanOrEqual(byY[i - 1].z);
  });

  it('dragging is yours to keep: the spot you drop an agent on is where it works from then on — idle or not', () => {
    vi.useFakeTimers();
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1200, height: 671, right: 1200, bottom: 671, x: 0, y: 0, toJSON: () => ({}) });
    try {
      localStorage.clear();
      const pct = (v: number) => `${v * 100}%`;
      const settle = () => { for (let t = 0; t < 9000; t += 100) act(() => { vi.advanceTimersByTime(100); }); };
      const view = render(scene([agent({ id: 'mover', status: 'working' })]));
      const fig = () => figure('mover');
      const at = () => [fig().style.left, fig().style.top];
      const drag = (toX: number, toY: number) => {
        const handle = fig().querySelector<HTMLElement>('[data-drag-handle]')!;
        fireEvent.pointerDown(handle, { clientX: 300, clientY: 300, pointerId: 1, button: 0 });
        fireEvent.pointerMove(handle, { clientX: toX, clientY: toY, pointerId: 1 });
        fireEvent.pointerUp(handle, { clientX: toX, clientY: toY, pointerId: 1 });
      };
      const go = (status: 'working' | 'waiting' | 'idle') => { view.rerender(scene([agent({ id: 'mover', status })])); settle(); };
      const home = at();
      drag(500, 420);
      const mine = at();
      expect(mine).not.toEqual(home);
      // Through every status and back, twice: it never leaves the spot I put it on.
      for (let round = 0; round < 2; round++) {
        for (const status of ['waiting', 'idle', 'working', 'idle', 'waiting', 'working'] as const) {
          go(status);
          expect(at(), `round ${round}: ${status} left the spot I put it on`).toEqual(mine);
          if (status === 'idle') expect(fig().dataset.anim).toBe('idle');
        }
      }
      // The spot is still remembered — it was never thrown away.
      expect(Object.keys(JSON.parse(localStorage.getItem('neoncore.world.spots.base') ?? '{}'))).toEqual(['m1:mover']);
      // Dragged WHILE idle: that is its spot too, and it works from there afterwards.
      go('idle');
      drag(700, 200);
      settle();
      const lounge = at();
      expect(lounge).not.toEqual(mine);
      go('working');
      expect(at()).toEqual(lounge);
      go('idle');
      expect(at()).toEqual(lounge);
      // Double-click sends it home for good; a spot saved by an older version is honoured as a work spot.
      go('working');
      fireEvent.doubleClick(fig().querySelector<HTMLElement>('[data-drag-handle]')!);
      settle();
      expect(at()).toEqual(home);
      view.unmount();
      localStorage.setItem('neoncore.world.spots.base', JSON.stringify({ 'm1:mover': { x: 0.5, y: 0.5 } }));
      render(scene([agent({ id: 'mover', status: 'working' })]));
      expect(at()).toEqual([pct(0.5), pct(0.5)]);
    } finally {
      rect.mockRestore(); w.mockRestore(); vi.useRealTimers(); localStorage.clear();
    }
  });
});

