/**
 * THE ROUTE VIEW of the roadmap: the plan as a flight path — every epic a stop, in order, lit by
 * where it stands; the stop on show lists its features; every control is one call to the server.
 * The timeline is the other view of the same plan, and the choice is remembered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { RoadmapChart as Chart, RoadmapEpic, RoadmapFeature, RoadmapFeatureState } from '../../../types';

const feature = (id: string, epicId: string, state: RoadmapFeatureState = 'planned', over: Partial<RoadmapFeature> = {}): RoadmapFeature => ({
  id, name: `Feature ${id}`, slug: id, state, epicId, startDate: '', targetDate: '', completedAt: null, dependsOn: [], blockedBy: [], summary: '', ...over,
});
const epic = (id: string, name: string, features: RoadmapFeature[], over: Partial<RoadmapEpic> = {}): RoadmapEpic => ({
  id, name, outcome: `${name} outcome`, icon: '', position: 0, features, nextUp: null,
  progress: { done: features.filter((f) => f.state === 'delivered').length, total: features.length },
  targetDate: '', dependsOn: [], blockedBy: [], deliveredAt: null, onTime: false, late: false, ...over,
});
const EPICS = [
  epic('e1', 'Setup', [feature('a1', 'e1', 'delivered'), feature('a2', 'e1', 'delivered')], { targetDate: '2026-11-20', deliveredAt: '2026-11-18T10:00:00Z', onTime: true }),
  epic('e2', 'Transport', [feature('b1', 'e2', 'delivered')], { deliveredAt: '2026-11-19T10:00:00Z' }),
  epic('e3', 'Identity', [feature('c1', 'e3', 'delivered'), feature('c2', 'e3', 'under-way', { targetDate: '2026-12-05' }), feature('c3', 'e3')], { nextUp: 'c3', targetDate: '2026-12-24' }),
  epic('e4', 'Pairing', [feature('d1', 'e4', 'late', { targetDate: '2026-11-01' })]),
  epic('e5', 'Commands', [feature('f1', 'e5'), feature('f2', 'e5', 'planned', { blockedBy: ['f1'], dependsOn: ['f1'] })], { dependsOn: ['e3'], blockedBy: ['e3'] }),
  epic('e6', 'Polish', []),
];
const WANT_STAGE = ['commended', 'delivered', 'under-way', 'late', 'blocked', 'planned'];
const CHART: Chart = {
  project: { id: 'p1', name: 'Orbit' }, vision: 'Ship the thing people keep.', epics: EPICS, unassigned: [feature('u1', '')],
  range: { from: '2026-10-01', to: '2027-01-31' }, today: '2026-11-22', totals: { planned: 4, 'under-way': 1, delivered: 4, late: 1 },
};
const calls = vi.hoisted(() => ({
  getRoadmap: vi.fn(), createGoal: vi.fn(), setRoadmapVision: vi.fn(), createEpic: vi.fn(), updateEpic: vi.fn(), deleteEpic: vi.fn(), reorderEpics: vi.fn(), planFeature: vi.fn(), getProjectRewards: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ api: calls }));
import { RoadmapChart, ROADMAP_VIEW_KEY } from '../RoadmapChart';

const project = { id: 'p1', name: 'Orbit' } as never;
const mount = async (chart: Chart = CHART) => {
  calls.getRoadmap.mockResolvedValue(chart);
  const onOpenFeature = vi.fn();
  const view = render(<RoadmapChart project={project} version={0} onOpenFeature={onOpenFeature} onChanged={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelector('[data-roadmap-chart]')).not.toBeNull());
  return { ...view, onOpenFeature };
};
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
beforeEach(() => {
  window.localStorage.clear();
  for (const f of Object.values(calls)) { f.mockReset(); f.mockResolvedValue(CHART); }
  calls.createGoal.mockResolvedValue({ id: 'new-goal' });
  calls.getProjectRewards.mockResolvedValue({ families: [] });
});
afterEach(cleanup);

describe('the roadmap\'s route view', () => {
  it('the roadmap opens on the route: every epic a stop, in plan order, in its stage — and the ship, the legs and the destination', async () => {
    await mount();
    expect(q('[data-route-view]')).not.toBeNull();
    expect(q('[data-timeline]')).toBeNull();
    expect(q('[data-roadmap-view="route"]')!.getAttribute('aria-pressed')).toBe('true');
    const stops = all('[data-route-stop]');
    expect(stops.map((s) => s.getAttribute('data-route-stop'))).toEqual(EPICS.map((e) => e.id));
    expect(stops.map((s) => s.getAttribute('data-stage'))).toEqual(WANT_STAGE);
    // The project is at the first epic that is not delivered.
    expect(stops.map((s) => s.hasAttribute('data-current'))).toEqual([false, false, true, false, false, false]);
    expect(all('[data-route-leg]').map((l) => l.getAttribute('data-state'))).toEqual(['travelled', 'travelled', 'flying', 'ahead', 'ahead', 'ahead', 'ahead']);
    expect(q('[data-route-ship]')).not.toBeNull();
    stops.forEach((s, i) => {
      expect(s.textContent).toContain(`Epic ${i + 1}`);
      expect(s.textContent).toContain(EPICS[i].name);
      expect(s.textContent).toContain(`${EPICS[i].progress.done}/${EPICS[i].progress.total}`);
    });
    expect(q('[data-route-destination]')!.textContent).toContain('Orbit');
    expect(q('[data-route-progress]')!.textContent).toBe('4 of 9 features');
    expect(q('[data-route-destination]')!.hasAttribute('data-reached')).toBe(false);
  });

  it.each(EPICS.map((e, i) => ({ name: e.name, e, i })))('$name: selecting its stop shows the epic — its outcome, what its date says, and exactly its features, each one selectable', async ({ e, i }) => {
    await mount();
    // Before any click the stop on show is where the project is now.
    expect(q('[data-route-epic]')!.getAttribute('data-route-epic')).toBe('e3');
    fireEvent.click(q(`[data-route-stop="${e.id}"]`)!);
    const panel = q('[data-route-epic]')!;
    expect(panel.getAttribute('data-route-epic')).toBe(e.id);
    expect(all('[data-route-stop][data-selected]').map((s) => s.getAttribute('data-route-stop'))).toEqual([e.id]);
    expect(panel.textContent).toContain(`Epic ${i + 1}`);
    expect(panel.textContent).toContain(e.outcome);
    expect(panel.textContent).toContain(`${e.progress.done} of ${e.progress.total} features delivered`);
    const chips = [...panel.querySelectorAll<HTMLElement>('[data-route-feature]')];
    expect(chips.map((c) => [c.getAttribute('data-route-feature'), c.getAttribute('data-state')])).toEqual(e.features.map((f) => [f.id, f.state]));
    expect(panel.querySelector('[data-route-start]') !== null, 'start next only where something can start').toBe(e.nextUp !== null);
    for (const f of e.features) {
      fireEvent.click(panel.querySelector(`[data-route-feature="${f.id}"]`)!);
      expect(panel.querySelector('[data-route-feature][data-selected]')!.getAttribute('data-route-feature')).toBe(f.id);
      // The same card the timeline opens.
      expect(screen.getAllByText(f.name).length).toBeGreaterThan(1);
    }
  });

  it('the stop\'s controls: start next, add a feature, edit the epic — each one call', async () => {
    const { onOpenFeature } = await mount();
    fireEvent.click(q('[data-route-start="e3"]')!);
    expect(onOpenFeature).toHaveBeenCalledWith('c3');
    fireEvent.click(q('[data-route-add-feature]')!);
    fireEvent.change(screen.getByLabelText('New feature name'), { target: { value: 'Key rotation' } });
    fireEvent.change(screen.getByLabelText('New feature target date'), { target: { value: '2026-12-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.planFeature).toHaveBeenCalledWith('new-goal', { epicId: 'e3', targetDate: '2026-12-10' }));
    expect(calls.createGoal).toHaveBeenCalledWith({ name: 'Key rotation', projectId: 'p1' });
    fireEvent.click(q('[data-route-edit]')!);
    expect(q('[data-epic-editor]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Epic due date'), { target: { value: '2027-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.updateEpic).toHaveBeenCalledWith('e3', { name: 'Identity', outcome: 'Identity outcome', icon: '', targetDate: '2027-01-15', dependsOn: [] }));
    await waitFor(() => expect(q('[data-epic-editor]')).toBeNull());
  });

  it('features in no epic are listed under the route, and open the same card', async () => {
    await mount();
    const un = q('[data-route-unassigned]')!;
    expect([...un.querySelectorAll('[data-route-feature]')].map((c) => c.getAttribute('data-route-feature'))).toEqual(['u1']);
    fireEvent.click(un.querySelector('[data-route-feature]')!);
    expect(un.querySelector('[data-route-feature][data-selected]')).not.toBeNull();
  });

  it('the timeline is the other view of the same plan, and the choice is remembered', async () => {
    await mount();
    fireEvent.click(q('[data-roadmap-view="timeline"]')!);
    expect(q('[data-route-view]')).toBeNull();
    expect(q('[data-timeline]')).not.toBeNull();
    expect(all('[data-lane]').length).toBeGreaterThanOrEqual(EPICS.length);
    expect(window.localStorage.getItem(ROADMAP_VIEW_KEY)).toBe('timeline');
    cleanup();
    await mount();
    expect(q('[data-timeline]')).not.toBeNull();
    fireEvent.click(q('[data-roadmap-view="route"]')!);
    expect(q('[data-route-view]')).not.toBeNull();
    expect(window.localStorage.getItem(ROADMAP_VIEW_KEY)).toBe('route');
  });

  it('a project with no epic yet: the route to the destination, and one button to plot the first epic', async () => {
    await mount({ ...CHART, epics: [], unassigned: [], totals: { planned: 0, 'under-way': 0, delivered: 0, late: 0 } });
    expect(all('[data-route-stop]')).toHaveLength(0);
    expect(all('[data-route-leg]')).toHaveLength(1);
    expect(q('[data-route-epic]')).toBeNull();
    fireEvent.click(q('[data-route-first]')!);
    expect(screen.getByLabelText('New epic name')).not.toBeNull();
  });

  it('every epic delivered: the whole route is travelled and the destination is reached', async () => {
    const done = EPICS.slice(0, 2);
    await mount({ ...CHART, epics: done, unassigned: [] });
    expect(all('[data-route-leg]').map((l) => l.getAttribute('data-state'))).toEqual(['travelled', 'travelled', 'flying']);
    expect(q('[data-route-destination]')!.hasAttribute('data-reached')).toBe(true);
    expect(all('[data-route-stop][data-current]')).toHaveLength(0);
    // The stop on show is the last one.
    expect(q('[data-route-epic]')!.getAttribute('data-route-epic')).toBe('e2');
  });
});
