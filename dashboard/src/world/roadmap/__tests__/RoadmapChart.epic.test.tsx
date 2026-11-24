/**
 * AN EPIC'S DATE AND WHAT IT WAITS ON, on the roadmap's route: what its card and its stop say for every
 * state an epic can be in, and the editor that sets both — one call to the server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { RoadmapChart as Chart, RoadmapEpic, RoadmapFeature } from '../../../types';

const feature = (id: string, epicId: string, over: Partial<RoadmapFeature> = {}): RoadmapFeature => ({
  id, name: `Feature ${id}`, slug: id, state: 'planned', epicId, startDate: '', targetDate: '', completedAt: null, dependsOn: [], blockedBy: [], summary: '', ...over,
});
const epic = (id: string, name: string, over: Partial<RoadmapEpic> = {}): RoadmapEpic => ({
  id, name, outcome: '', icon: '', position: 0, progress: { done: 0, total: 1 }, nextUp: null, features: [feature(`f-${id}`, id)],
  targetDate: '', dependsOn: [], blockedBy: [], deliveredAt: null, onTime: false, late: false, ...over,
});
const EPICS = [
  epic('e1', 'On time', { targetDate: '2026-11-20', deliveredAt: '2026-11-18T10:00:00Z', onTime: true }),
  epic('e2', 'After its date', { targetDate: '2026-11-10', deliveredAt: '2026-11-13T10:00:00Z' }),
  epic('e3', 'Delivered, undated', { deliveredAt: '2026-11-13T10:00:00Z' }),
  epic('e4', 'Late', { targetDate: '2026-11-01', late: true }),
  epic('e5', 'Due', { targetDate: '2026-12-24', dependsOn: ['e4', 'e1'], blockedBy: ['e4'] }),
  epic('e6', 'Plain'),
];
const CHART: Chart = {
  project: { id: 'p1', name: 'Orbit' }, vision: '', epics: EPICS, unassigned: [],
  range: { from: '2026-10-01', to: '2027-01-31' }, today: '2026-11-22', totals: { planned: 6, 'under-way': 0, delivered: 0, late: 0 },
};
const calls = vi.hoisted(() => ({
  getRoadmap: vi.fn(), createGoal: vi.fn(), setRoadmapVision: vi.fn(), createEpic: vi.fn(), updateEpic: vi.fn(), deleteEpic: vi.fn(), reorderEpics: vi.fn(), planFeature: vi.fn(), getProjectRewards: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ api: calls }));
import { RoadmapChart, epicStatus } from '../RoadmapChart';
import { datePill } from '../EpicCards';

const project = { id: 'p1', name: 'Orbit' } as never;
const mount = async () => {
  const view = render(<RoadmapChart project={project} version={0} onOpenFeature={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelector('[data-roadmap-chart]')).not.toBeNull());
  return view;
};
beforeEach(() => {
  for (const f of Object.values(calls)) { f.mockReset(); f.mockResolvedValue(CHART); }
  calls.getProjectRewards.mockResolvedValue({ families: [], rank: { index: 2, id: 'commander', title: 'Commander', commendations: 2, next: { title: 'Admiral', at: 3 } } });
});
afterEach(cleanup);
const numberOf = (id: string) => EPICS.findIndex((e) => e.id === id) + 1;

describe('an epic\'s date and dependencies on the chart', () => {
  const WANT: Record<string, { kind: string; text: string }[]> = {
    e1: [{ kind: 'commend', text: '★ Commendation · delivered Nov 18, due Nov 20' }],
    e2: [{ kind: 'delivered', text: 'Delivered Nov 13 · 3 days after its date' }],
    e3: [{ kind: 'delivered', text: 'Delivered Nov 13' }],
    e4: [{ kind: 'late', text: 'Late · was due Nov 1' }],
    e5: [{ kind: 'waits', text: 'Waits on Epic 4' }, { kind: 'due', text: 'Due Dec 24' }],
    e6: [],
  };
  it.each(EPICS.map((e) => ({ name: e.name, e })))('$name: what its card says', async ({ e }) => {
    expect(epicStatus(e, numberOf)).toEqual(WANT[e.id]);
    const { container } = await mount();
    const card = container.querySelector(`[data-epic-card="${e.id}"]`)!;
    // Its date: a pill when it has one, in the state the date is in; none for an undated epic.
    const pill = card.querySelector('[data-epic-pill="date"]');
    const want = datePill(e);
    expect(pill !== null).toBe(e.targetDate !== '');
    if (want) expect({ kind: pill!.getAttribute('data-kind'), text: pill!.textContent }).toEqual(want);
    // What it waits on: one pill per epic it needs, met or not.
    expect([...card.querySelectorAll('[data-epic-pill="needs"]')].map((n) => n.getAttribute('data-met'))).toEqual((e.dependsOn ?? []).map((id) => String(!(e.blockedBy ?? []).includes(id))));
  });

  it('one day after its date reads "1 day", and an epic from an older server (no date fields) says nothing', () => {
    expect(epicStatus(epic('x', 'X', { targetDate: '2026-11-12', deliveredAt: '2026-11-13T01:00:00Z' }), numberOf)).toEqual([{ kind: 'delivered', text: 'Delivered Nov 13 · 1 day after its date' }]);
    const old = { id: 'o', name: 'Old', outcome: '', icon: '', position: 0, progress: { done: 0, total: 0 }, nextUp: null, features: [] } as RoadmapEpic;
    expect(epicStatus(old, numberOf)).toEqual([]);
  });

  it.each(EPICS.map((e) => ({ name: e.name, e })))('$name: its editor shows its date and what it waits on, offers every OTHER epic, and saves both in one call', async ({ e }) => {
    await mount();
    fireEvent.click(screen.getByLabelText(`Edit the epic ${e.name}`));
    const deps = e.dependsOn ?? [];
    const date = screen.getByLabelText('Epic due date') as HTMLInputElement;
    expect(date.value).toBe(e.targetDate);
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-epic-waits] input[type="checkbox"]')];
    expect(boxes.map((b) => b.value)).toEqual(EPICS.filter((o) => o.id !== e.id).map((o) => o.id));
    expect(boxes.filter((b) => b.checked).map((b) => b.value).sort()).toEqual([...deps].sort());
    // Change the date, and flip the first other epic.
    fireEvent.change(date, { target: { value: '2027-01-15' } });
    const first = boxes[0];
    fireEvent.click(first);
    const waits = first.checked ? [...deps, first.value] : deps.filter((id) => id !== first.value);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.updateEpic).toHaveBeenCalledTimes(1));
    expect(calls.updateEpic).toHaveBeenCalledWith(e.id, { name: e.name, outcome: '', icon: '', targetDate: '2027-01-15', dependsOn: waits, qaCommand: '' });
  });

  it('clearing the date saves an empty date', async () => {
    await mount();
    fireEvent.click(screen.getByLabelText('Edit the epic Due'));
    fireEvent.change(screen.getByLabelText('Epic due date'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.updateEpic).toHaveBeenCalledWith('e5', { name: 'Due', outcome: '', icon: '', targetDate: '', dependsOn: ['e4', 'e1'], qaCommand: '' }));
  });

  it('the officer of the deck wears the project\'s rank', async () => {
    const { container } = await mount();
    await waitFor(() => expect(container.querySelector('[data-officer] [data-rank]')).not.toBeNull());
    expect(container.querySelector('[data-officer] [data-rank]')!.getAttribute('data-rank')).toBe('commander');
    expect(calls.getProjectRewards).toHaveBeenCalledWith('p1');
  });
});
