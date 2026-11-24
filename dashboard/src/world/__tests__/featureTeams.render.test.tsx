import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Agent } from '../../types';

/**
 * REQUESTED: "So when I start this, what will show up on the map … Should we instead of showing the
 * project label on the map show the feature … with the badge" — chosen: feature plates + a small
 * project name.
 *
 * A feature on its own branch runs its cartridges in worktrees (gl-dev-feature-…), which no project
 * lists — before this they fell onto unclaimed land, named after the folder. Now an agent working in
 * a feature's worktree stands at its REAL repo's building, each running feature has a plate (name,
 * stage, needs-you, its own badges), and a project with features running keeps only a small caption.
 */
vi.mock('../../components/CartridgeGrid', () => ({ CartridgeGrid: () => <div data-testid="card" /> }));
const live = vi.hoisted(() => ({ confers: [] as unknown[], runs: [] as unknown[] }));
vi.mock('../../hooks/useLiveWork', () => ({ useLiveWork: () => live }));
const extras = vi.hoisted(() => ({
  queue: { items: [], lanes: [] } as { items: unknown[]; lanes: unknown[] }, burn: new Map<string, number>(),
  machines: [] as { hostname: string; status: 'online' | 'offline' }[], projects: [] as Record<string, unknown>[],
  goals: [] as Record<string, unknown>[], features: [] as Record<string, unknown>[], ready: true,
}));
vi.mock('../useCrewExtras', () => ({ useCrewExtras: () => extras }));

import { WorldScene } from '../WorldScene';
import { OUTPOST } from '../sites';
import { plateOrder } from '../FeaturePlates';

const iso = () => new Date().toISOString();
const agent = (over: Partial<Agent> & { id: string }): Agent => ({
  name: over.id, machine: 'm1', repoPath: `/r/${over.id}`, repoName: over.id, branch: 'main', currentTask: '', status: 'working',
  trustMode: false, plansIncluded: false, mode: 'manual', agentType: 'claude', lastSeen: iso(), sessionId: `s-${over.id}`,
  lastMessage: '', pendingQuestion: '', recoveryStatus: '', interruptedAt: '', activeObjective: '', ...over,
} as Agent);
const noop = () => {};
const handlers = { onDecidePermission: noop, onSetMode: noop, onSendCommand: noop, onDelete: noop, onDismiss: noop, onRestore: noop, onDismissStuck: noop };
const atlas = {
  id: 'p1', name: 'Atlas', color: '#2EE6D6', primaryRepo: '/code/gl-dev', createdAt: '2026-01-01T00:00:00Z',
  cartridges: ['/code/gl-dev', '/code/license-server'], featureCount: 3, featuresDone: 1, featuresActive: 2,
};
const invoice = {
  pilotId: 'pi1', goalId: 'g1', projectId: 'p1', name: 'Invoice import', phase: 'running', branch: 'feature/invoice-import',
  stage: { position: 3, total: 8, title: 'Build it' }, needsYou: '', agentIds: ['wt-gl'],
  worktrees: [{ worktreePath: '/code/gl-dev-feature-invoice-import', repoPath: '/code/gl-dev' }],
};
const exportCsv = {
  pilotId: 'pi2', goalId: 'g2', projectId: 'p1', name: 'Export CSV', phase: 'paused', branch: '',
  stage: { position: 2, total: 5, title: 'Plan' }, needsYou: 'The pipeline stopped and needs you', agentIds: ['lic'], worktrees: [],
};
const goalsFor = [
  { id: 'g1', projectId: 'p1', status: 'active', origin: '', updatedAt: iso(), doneAt: '', pilot: { phase: 'running' } },
  { id: 'g2', projectId: 'p1', status: 'active', origin: '', updatedAt: iso(), doneAt: '', pilot: { phase: 'paused' } },
];
const scene = (list: Agent[]) => <WorldScene agents={list} activitiesByAgent={{}} pendingPermissions={[]} stuckAlerts={[]} {...handlers} />;
const figure = (name: string) => screen.getByRole('button', { name: new RegExp(`^Crew member ${name}\\b`) }).closest<HTMLElement>('.world-member')!;
const siteOf = (name: string) => OUTPOST.sites.find((s) => s.id === figure(name).dataset.site)!;

afterEach(() => { cleanup(); extras.projects = []; extras.goals = []; extras.features = []; });

describe('features on the map', () => {
  it('an agent in a feature\'s worktree works at its real repo\'s building, in the project\'s pod', () => {
    extras.projects = [atlas];
    extras.features = [invoice];
    render(scene([agent({ id: 'wt-gl', repoPath: '/code/gl-dev-feature-invoice-import', repoName: 'gl-dev-feature-invoice-import' })]));
    expect(siteOf('gl-dev-feature-invoice-import').district).toBe('nw');
    expect(siteOf('gl-dev-feature-invoice-import').at).toBeTruthy();
  });

  it('features are not drawn on the map: every running feature is in the HUD at the bottom, with its stage and whether it needs you', () => {
    extras.projects = [atlas];
    extras.features = [invoice, exportCsv];
    extras.goals = goalsFor;
    render(scene([agent({ id: 'wt-gl', repoPath: '/code/gl-dev-feature-invoice-import', repoName: 'gl-dev-feature-invoice-import' }), agent({ id: 'lic', repoPath: '/code/license-server' })]));
    expect(document.querySelector('[data-feature-plate], [data-feature-stack]')).toBeNull();
    for (const f of [invoice, exportCsv]) {
      const row = document.querySelector<HTMLElement>(`[data-feature-hud] [data-hud-feature="${f.goalId}"]`);
      expect(row, `no HUD row for ${f.name}`).toBeTruthy();
      expect(row!.textContent).toContain(f.name);
      expect(row!.textContent).toContain(`${f.stage.position}/${f.stage.total}`);
    }
    expect(document.querySelector('[data-hud-feature="g2"]')!.textContent).toMatch(/needs you/i);
    expect(document.querySelector('[data-hud-feature="g1"]')!.hasAttribute('data-needs-you')).toBe(false);
  });

  it('a project\'s sign carries its name only: no banner of counts and badges on the map, whether or not features are running', () => {
    for (const features of [[invoice], []]) {
      extras.projects = [atlas];
      extras.features = features;
      extras.goals = goalsFor;
      render(scene([]));
      const plate = document.querySelector<HTMLElement>('[data-zone-label]')!;
      expect(plate.textContent).toBe('Atlas');
      expect(document.querySelector('[data-zone-plaque]')).toBeNull();
      expect(document.querySelectorAll('.world-scene [data-badge], [data-zone-label] [data-badge]')).toHaveLength(0);
      cleanup();
    }
  });

  it('a feature with no agent on the map yet is in the HUD all the same', () => {
    extras.projects = [atlas];
    extras.features = [{ ...invoice, agentIds: [] }];
    render(scene([]));
    expect(document.querySelector('[data-hud-feature="g1"]')).toBeTruthy();
  });

  it('the HUD holds the features of EVERY sector, not just the one on screen', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...atlas, id: `s${i}`, name: `Proj ${i}`, primaryRepo: `/code/r${i}`, cartridges: [`/code/r${i}`], featuresActive: 1 }));
    extras.projects = five;
    extras.features = five.map((p, i) => ({ ...invoice, pilotId: `pp${i}`, goalId: `gg${i}`, projectId: p.id, name: `Feature of ${p.name}`, agentIds: [], worktrees: [] }));
    render(scene([]));
    const signs = document.querySelectorAll('[data-zone-label]').length;
    expect(signs, 'more projects than this sector holds').toBeLessThan(5);
    expect([...document.querySelectorAll('[data-hud-feature]')].map((r) => r.getAttribute('data-hud-feature')).sort()).toEqual(['gg0', 'gg1', 'gg2', 'gg3', 'gg4']);
  });
});

describe('the order of features', () => {
  const feat = (n: number, over: Record<string, unknown> = {}) => ({ ...invoice, pilotId: `px${n}`, goalId: `gx${n}`, name: `Feature ${n}`, stage: { position: n, total: 9, title: 'x' }, agentIds: [], ...over });
  it('needs you first, then furthest along, then by name — for every pair', () => {
    const a = feat(2), b = feat(5), c = feat(5, { name: 'Alpha' }), d = feat(1, { needsYou: 'x' });
    expect(plateOrder([a, b, c, d] as unknown as (Parameters<typeof plateOrder>[0][number] & { pilotId: string })[]).map((f) => f.pilotId)).toEqual([d.pilotId, c.pilotId, b.pilotId, a.pilotId]);
  });
});
