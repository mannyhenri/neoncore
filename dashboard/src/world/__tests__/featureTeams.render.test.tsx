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
import { FEATURE_BADGES } from '../milestones';

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

  it('every running feature has a plate: its name, its stage, whether it needs you, and its own badges', () => {
    extras.projects = [atlas];
    extras.features = [invoice, exportCsv];
    extras.goals = goalsFor;
    render(scene([
      agent({ id: 'wt-gl', repoPath: '/code/gl-dev-feature-invoice-import', repoName: 'gl-dev-feature-invoice-import' }),
      agent({ id: 'lic', repoPath: '/code/license-server', repoName: 'license-server' }),
    ]));
    for (const f of [invoice, exportCsv]) {
      const plate = document.querySelector<HTMLElement>(`[data-feature-plate="${f.pilotId}"]`);
      expect(plate, `no plate for ${f.name}`).toBeTruthy();
      expect(plate!.textContent).toContain(f.name);
      expect(plate!.textContent).toContain(`${f.stage.position}/${f.stage.total}`);
      expect(plate!.querySelectorAll('[data-badge]')).toHaveLength(FEATURE_BADGES.length);
    }
    expect(document.querySelector('[data-feature-plate="pi2"]')!.textContent).toMatch(/needs you/i);
    expect(document.querySelector('[data-feature-plate="pi1"]')!.textContent).not.toMatch(/needs you/i);
  });

  it('a project with features running keeps a small caption; with none, its full plate', () => {
    extras.projects = [atlas];
    extras.features = [invoice];
    const view = render(scene([agent({ id: 'wt-gl', repoPath: '/code/gl-dev-feature-invoice-import', repoName: 'gl-dev-feature-invoice-import' })]));
    let plate = document.querySelector<HTMLElement>('[data-zone-label]')!;
    expect(plate.textContent).toContain('Atlas');
    expect(plate.textContent).not.toContain('1/3');
    expect(plate.dataset.caption).toBe('true');
    view.unmount();
    extras.features = [];
    render(scene([agent({ id: 'gl', repoPath: '/code/gl-dev', repoName: 'gl-dev' })]));
    plate = document.querySelector<HTMLElement>('[data-zone-label]')!;
    expect(plate.textContent).toContain('1/3');
    expect(plate.dataset.caption).toBeUndefined();
  });

  it('a feature with no agent on the map yet still shows its plate, on its project\'s district', () => {
    extras.projects = [atlas];
    extras.features = [{ ...invoice, agentIds: [] }];
    render(scene([]));
    expect(document.querySelector('[data-feature-plate="pi1"]')).toBeTruthy();
  });
});
