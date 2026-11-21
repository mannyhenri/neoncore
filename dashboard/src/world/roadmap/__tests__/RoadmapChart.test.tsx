/**
 * The roadmap chart draws THE WHOLE PLAN the server sends — every epic a lane, every feature a
 * waypoint in its state — and every control on it is one call to the server.
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
  getRoadmap: vi.fn(), setRoadmapVision: vi.fn(), createEpic: vi.fn(), updateEpic: vi.fn(), deleteEpic: vi.fn(), reorderEpics: vi.fn(), planFeature: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ api: calls }));
import { RoadmapChart, officerAnim } from '../RoadmapChart';

const project = { id: 'p1', name: 'Orbit' } as never;
const mount = async (onOpenFeature = vi.fn(), onChanged = vi.fn()) => {
  const view = render(<RoadmapChart project={project} version={0} onOpenFeature={onOpenFeature} onChanged={onChanged} />);
  await waitFor(() => expect(view.container.querySelector('[data-roadmap-chart]')).not.toBeNull());
  return { ...view, onOpenFeature, onChanged };
};

beforeEach(() => {
  for (const f of Object.values(calls)) { f.mockReset(); f.mockResolvedValue(CHART); }
});

describe('the roadmap chart', () => {
  it('draws every epic as a lane and every feature as a waypoint in its state', async () => {
    const { container } = await mount();
    const all = [...CHART.epics.flatMap((e) => e.features), ...CHART.unassigned];
    const drawn = new Map([...container.querySelectorAll('[data-waypoint]')].map((n) => [n.getAttribute('data-waypoint'), n.getAttribute('data-state')]));
    expect([...drawn.keys()].sort()).toEqual(all.map((f) => f.id).sort());
    for (const f of all) expect(drawn.get(f.id), f.id).toBe(f.state);
    // An epic a lane; a feature in no epic and with no date is off the chart, in the tray under it.
    expect([...container.querySelectorAll('[data-lane]')].map((n) => n.getAttribute('data-lane'))).toEqual(['e1', 'e2']);
    expect(container.querySelector('[data-unplanned] [data-waypoint="f6"]')).not.toBeNull();
    expect(container.querySelector('[data-waypoint="f6"]')!.hasAttribute('data-unscheduled')).toBe(true);
  });

  it('shows the vision, a column per month, today, and every dependency', async () => {
    const { container } = await mount();
    expect(screen.getByText(CHART.vision)).toBeTruthy();
    // A whole calendar year, JAN to DEC, though the plan covers two months.
    expect([...container.querySelectorAll('[data-month]')].map((n) => n.getAttribute('data-month'))).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`));
    expect([...container.querySelectorAll('[data-month]')].map((n) => n.textContent)).toEqual(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);
    expect(container.querySelector('[data-today-pill]')!.textContent).toBe('TODAY');
    expect(container.querySelector('[data-today]')).not.toBeNull();
    expect([...container.querySelectorAll('[data-dependency]')].map((n) => n.getAttribute('data-dependency')).sort()).toEqual(['f1>f2', 'f4>f5']);
    expect([...container.querySelectorAll('[data-vision-gauge]')].map((n) => n.getAttribute('data-vision-gauge'))).toEqual(['delivery', 'scope', 'readiness']);
    expect([...container.querySelectorAll('[data-legend]')].map((n) => n.getAttribute('data-legend'))).toEqual(['delivered', 'under-way', 'planned', 'late']);
  });

  it('"Start next" opens the feature the server says is next, and only where there is one', async () => {
    const { container, onOpenFeature } = await mount();
    expect([...container.querySelectorAll('[data-start-next]')].map((n) => n.getAttribute('data-start-next'))).toEqual(['e1']);
    fireEvent.click(container.querySelector('[data-start-next="e1"]')!);
    expect(onOpenFeature).toHaveBeenCalledWith('f3');
  });

  it('Start is refused, with the reason, for a feature that waits on another — and allowed for one that does not', async () => {
    const { container, onOpenFeature } = await mount();
    fireEvent.keyDown(container.querySelector('[data-waypoint="f5"]')!, { key: 'Enter' });
    const blocked = container.querySelector('[data-start]') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toContain('Feature f4');
    fireEvent.keyDown(container.querySelector('[data-waypoint="f3"]')!, { key: 'Enter' });
    const free = container.querySelector('[data-start]') as HTMLButtonElement;
    expect(free.disabled).toBe(false);
    fireEvent.click(free);
    expect(onOpenFeature).toHaveBeenCalledWith('f3');
  });

  it('every planning control is one call for that feature, and tells the page', async () => {
    const { container, onChanged } = await mount();
    fireEvent.click(container.querySelector('[data-waypoint="f6"]')!);
    const panel = container.querySelector('[data-selected-feature="f6"]')!;
    fireEvent.change(panel.querySelector('select')!, { target: { value: 'e2' } });
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

  it('saves the vision and adds an epic', async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByTitle('Edit the vision'));
    fireEvent.change(screen.getByLabelText("The project's vision"), { target: { value: 'New aim' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(calls.setRoadmapVision).toHaveBeenCalledWith('p1', 'New aim'));
    fireEvent.click(screen.getByText('+ Epic'));
    fireEvent.change(screen.getByLabelText('New epic name'), { target: { value: 'Launch' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(calls.createEpic).toHaveBeenCalledWith('p1', { name: 'Launch' }));
    expect(container.querySelector('[data-roadmap-chart]')).not.toBeNull();
  });

  it('says what went wrong when a change is refused, and keeps the chart', async () => {
    const { container } = await mount();
    calls.planFeature.mockRejectedValueOnce(new Error('That would make a loop'));
    fireEvent.click(container.querySelector('[data-waypoint="f6"]')!);
    fireEvent.change(container.querySelector('[data-selected-feature] select')!, { target: { value: 'e1' } });
    await waitFor(() => expect(screen.getByText('That would make a loop')).toBeTruthy());
    expect(container.querySelectorAll('[data-waypoint]').length).toBe(6);
  });

  it('the route in a lane is green up to its last delivery, blue from there to what is under way, faint beyond — and a late feature is marked', async () => {
    const { container } = await mount();
    const routes = (lane: string) => [...container.querySelectorAll(`[data-lane="${lane}"] [data-route]`)].map((n) => n.getAttribute('data-route')).sort();
    expect(routes('e1')).toEqual(['ahead', 'delivered', 'under-way']);   // f1 delivered, f2 under way, f3 planned
    expect(routes('e2')).toEqual(['ahead']);                             // nothing delivered or under way
    // One node per waypoint on the chart, drawn in its state; the late one carries the warning sign.
    for (const f of CHART.epics.flatMap((e) => e.features)) {
      const w = container.querySelector(`[data-timeline] [data-waypoint="${f.id}"]`)!;
      expect(w.querySelector('[data-node]')!.getAttribute('data-node'), f.id).toBe(f.state);
      expect(w.textContent!.includes('⚠'), f.id).toBe(f.state === 'late');
    }
  });

  it('the selected waypoint\'s card says its epic, its date and its state; the planning controls open on request', async () => {
    const { container } = await mount();
    fireEvent.keyDown(container.querySelector('[data-waypoint="f2"]')!, { key: 'Enter' });
    const card = container.querySelector('[data-selected-feature="f2"]')!;
    expect(card.textContent).toContain('EPIC 1 — Core');
    expect(card.textContent).toContain('NOV 25');
    expect(card.textContent).toContain('Under way');
    expect(card.querySelector('[data-plan]')).toBeNull();
    // Under way: it is opened, not started.
    expect(card.querySelector('[data-start]')).toBeNull();
    expect(card.querySelector('[data-open-feature]')!.textContent).toBe('OPEN ▸');
    fireEvent.click(card.querySelector('[data-plan-toggle]')!);
    expect(card.querySelectorAll('[data-plan] select, [data-plan] input[type="date"]').length).toBe(3);
  });

  it('the officer of the deck looks as the plan stands — for every mix of states', () => {
    const t = (late: number, underWay: number) => ({ planned: 1, delivered: 1, late, 'under-way': underWay });
    expect([officerAnim(t(0, 0)), officerAnim(t(0, 2)), officerAnim(t(1, 0)), officerAnim(t(3, 2))]).toEqual(['idle', 'log', 'worry', 'worry']);
  });
});
