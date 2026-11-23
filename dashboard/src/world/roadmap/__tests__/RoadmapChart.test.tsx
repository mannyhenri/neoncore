/**
 * The roadmap deck around the route: the vision and its gauges, the officer, the deck's controls,
 * and the selected feature's card — every control on it one call to the server. (The route and the
 * epic cards themselves: RoadmapChart.route.test.tsx.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RoadmapChart as Chart, RoadmapFeature, RoadmapFeatureState } from '../../../types';

const feature = (id: string, state: RoadmapFeatureState, over: Partial<RoadmapFeature> = {}): RoadmapFeature => ({
  id, name: `Feature ${id}`, slug: id, state, epicId: '', startDate: '', targetDate: '', completedAt: null, dependsOn: [], blockedBy: [], summary: '', ...over,
});
const CHART: Chart = {
  project: { id: 'p1', name: 'Orbit' },
  vision: 'Ship the thing people keep.',
  epics: [
    { id: 'e1', name: 'Core', outcome: 'The base works', icon: '', position: 0, progress: { done: 1, total: 3 }, nextUp: 'f3',
      features: [
        feature('f1', 'delivered', { epicId: 'e1', targetDate: '2026-11-05', completedAt: '2026-11-04T10:00:00Z' }),
        feature('f2', 'under-way', { epicId: 'e1', targetDate: '2026-11-25', dependsOn: ['f1'] }),
        feature('f3', 'planned', { epicId: 'e1', targetDate: '2026-12-10' }),
      ] },
    { id: 'e2', name: 'Growth', outcome: '', icon: '', position: 1, progress: { done: 0, total: 2 }, nextUp: null,
      features: [
        feature('f4', 'late', { epicId: 'e2', targetDate: '2026-11-10' }),
        feature('f5', 'planned', { epicId: 'e2', targetDate: '2026-12-20', dependsOn: ['f4'], blockedBy: ['f4'] }),
      ] },
  ],
  unassigned: [feature('f6', 'planned')],
  range: { from: '2026-11-01', to: '2026-12-31' },
  today: '2026-11-20',
  totals: { planned: 3, 'under-way': 1, delivered: 1, late: 1 },
};

const calls = vi.hoisted(() => ({
  getRoadmap: vi.fn(), createGoal: vi.fn(), setRoadmapVision: vi.fn(), createEpic: vi.fn(), updateEpic: vi.fn(), deleteEpic: vi.fn(), reorderEpics: vi.fn(), planFeature: vi.fn(), getProjectRewards: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ api: calls }));
import { RoadmapChart, officerAnim } from '../RoadmapChart';

const project = { id: 'p1', name: 'Orbit' } as never;
const mount = async (onOpenFeature = vi.fn(), onChanged = vi.fn()) => {
  const view = render(<RoadmapChart project={project} version={0} onOpenFeature={onOpenFeature} onChanged={onChanged} />);
  await waitFor(() => expect(view.container.querySelector('[data-route-view]')).not.toBeNull());
  return { ...view, onOpenFeature, onChanged };
};
const pick = (container: HTMLElement, id: string) => fireEvent.click(container.querySelector(`[data-epic-feature="${id}"], [data-route-feature="${id}"]`)!);

beforeEach(() => {
  window.localStorage.clear();
  for (const f of Object.values(calls)) { f.mockReset(); f.mockResolvedValue(CHART); }
  calls.createGoal.mockResolvedValue({ id: 'new-goal' });
  calls.getProjectRewards.mockResolvedValue({ families: [] });
});

describe('the roadmap deck', () => {
  it('shows which project it is, the vision, its three gauges and the legend', async () => {
    const { container } = await mount();
    const badge = container.querySelector('[data-roadmap-project]')!;
    expect(badge.textContent).toMatch(/Project roadmap/);
    expect(badge.textContent).toContain('Orbit');
    expect(container.querySelector('[data-vision]')!.firstElementChild).toBe(badge);
    expect(screen.getByText(CHART.vision)).toBeTruthy();
    expect([...container.querySelectorAll('[data-vision-gauge]')].map((n) => n.getAttribute('data-vision-gauge'))).toEqual(['delivery', 'scope', 'readiness']);
    expect([...container.querySelectorAll('[data-legend]')].map((n) => n.getAttribute('data-legend'))).toEqual(['delivered', 'under-way', 'planned', 'late']);
  });

  it('Start is refused, with the reason, for a feature that waits on another — and allowed for one that does not', async () => {
    const { container, onOpenFeature } = await mount();
    pick(container, 'f5');
    const blocked = container.querySelector('[data-selected-feature="f5"] [data-start]') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toContain('Feature f4');
    pick(container, 'f3');
    const free = container.querySelector('[data-selected-feature="f3"] [data-start]') as HTMLButtonElement;
    expect(free.disabled).toBe(false);
    fireEvent.click(free);
    expect(onOpenFeature).toHaveBeenCalledWith('f3');
  });

  it('the selected feature\'s card says its epic, its date and its state; the planning controls open on request', async () => {
    const { container } = await mount();
    pick(container, 'f2');
    const card = container.querySelector('[data-selected-feature="f2"]')!;
    expect(card.textContent).toContain('EPIC 1 — Core');
    expect(card.textContent).toContain('NOV 25');
    expect(card.textContent).toContain('Under way');
    expect(card.querySelector('[data-plan]')).toBeNull();
    expect(card.querySelector('[data-start]')).toBeNull();
    expect(card.querySelector('[data-open-feature]')!.textContent).toBe('OPEN ▸');
    fireEvent.click(card.querySelector('[data-plan-toggle]')!);
    expect(card.querySelectorAll('[data-plan] select, [data-plan] input[type="date"]').length).toBe(3);
  });

  it('every planning control is one call for that feature, and tells the page', async () => {
    const { container, onChanged } = await mount();
    pick(container, 'f6');
    const panel = container.querySelector('[data-selected-feature="f6"]')!;
    fireEvent.click(panel.querySelector('[data-plan-toggle]')!);
    fireEvent.change(panel.querySelector('[data-plan] select')!, { target: { value: 'e2' } });
    const [starts, target] = [...panel.querySelectorAll('input[type="date"]')];
    fireEvent.change(starts, { target: { value: '2026-12-01' } });
    fireEvent.change(target, { target: { value: '2026-12-15' } });
    fireEvent.click(panel.querySelectorAll('[data-depends] input')[0]);
    await waitFor(() => expect(calls.planFeature).toHaveBeenCalledTimes(4));
    expect(calls.planFeature.mock.calls).toEqual([
      ['f6', { epicId: 'e2' }], ['f6', { startDate: '2026-12-01' }], ['f6', { targetDate: '2026-12-15' }], ['f6', { dependsOn: ['f1'] }],
    ]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(4));
  });

  it('says what went wrong when a change is refused, and keeps the route', async () => {
    const { container } = await mount();
    calls.planFeature.mockRejectedValueOnce(new Error('That would make a loop'));
    pick(container, 'f6');
    const panel = container.querySelector('[data-selected-feature="f6"]')!;
    fireEvent.click(panel.querySelector('[data-plan-toggle]')!);
    fireEvent.change(panel.querySelector('[data-plan] select')!, { target: { value: 'e1' } });
    await waitFor(() => expect(screen.getByText('That would make a loop')).toBeTruthy());
    expect(container.querySelectorAll('[data-route-stop]').length).toBe(2);
  });

  it('saves the vision and adds an epic from the header', async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByTitle('Edit the vision'));
    fireEvent.change(screen.getByLabelText("The project's vision"), { target: { value: 'New aim' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(calls.setRoadmapVision).toHaveBeenCalledWith('p1', 'New aim'));
    fireEvent.click(container.querySelector('[data-add-epic]')!);
    fireEvent.change(screen.getByLabelText('New epic name'), { target: { value: 'Launch' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(calls.createEpic).toHaveBeenCalledWith('p1', { name: 'Launch' }));
  });

  it('the officer of the deck looks as the plan stands — for every mix of states', () => {
    const t = (late: number, underWay: number) => ({ planned: 1, delivered: 1, late, 'under-way': underWay });
    expect([officerAnim(t(0, 0)), officerAnim(t(0, 2)), officerAnim(t(1, 0)), officerAnim(t(3, 2))]).toEqual(['idle', 'log', 'worry', 'worry']);
  });

  it('the deck\'s controls are stacked in the officer\'s column, so they never run over the chart\'s title', async () => {
    const view = render(<RoadmapChart project={project} version={0} onOpenFeature={vi.fn()} onChanged={vi.fn()}
      toolbar={<><button>← Board</button><button>✦ Plan from a document</button></>} />);
    await waitFor(() => expect(view.container.querySelector('[data-route-view]')).not.toBeNull());
    const bar = view.container.querySelector('[data-roadmap-toolbar]')!;
    expect(bar.closest('[data-officer]')).not.toBeNull();
    expect(bar.className).toMatch(/\bflex-col\b/);
    expect(bar.className).toContain('[&>*]:max-w-full');
    expect([...bar.children].map((b) => b.textContent)).toEqual(['← Board', '✦ Plan from a document']);
  });
});
