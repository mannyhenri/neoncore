/**
 * NEEDS FIRST on the dashboard: the feature page's panel, the Mark done button it governs, and the
 * "⛓ Waits on …" line under a blocked feature in the list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const calls = vi.hoisted(() => ({ getFeatureNeeds: vi.fn(), planFeature: vi.fn(), getRoadmap: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: calls }));
import { NeedsFirstPanel, MarkDoneButton, WaitsOn, waitsByFeature, useFeatureNeeds } from '../NeedsFirst';
import type { FeatureNeeds, RoadmapChart } from '../../types';

const needs = (over: Partial<FeatureNeeds> = {}): FeatureNeeds => ({
  chosen: [], unmet: { features: [], epics: [] }, message: '',
  candidates: [{ id: 'a', name: 'Points per visit', state: 'planned' }, { id: 'b', name: 'Cart', state: 'delivered' }, { id: 'c', name: 'Menu', state: 'under-way' }],
  ...over,
});
beforeEach(() => { for (const f of Object.values(calls)) f.mockReset(); });
afterEach(cleanup);

function Harness({ id = 'f1', onDone = vi.fn() }: { id?: string; onDone?: () => void }) {
  const { needs: n, reload } = useFeatureNeeds(id, 0);
  return (<>
    <MarkDoneButton needs={n} onClick={onDone} />
    <NeedsFirstPanel featureId={id} needs={n} onChanged={reload} />
  </>);
}

describe('the Needs first panel and Mark done', () => {
  const CASES: { name: string; n: FeatureNeeds; blocked: boolean }[] = [
    { name: 'nothing needed', n: needs(), blocked: false },
    { name: 'needs a done feature', n: needs({ chosen: ['b'] }), blocked: false },
    { name: 'needs an open feature', n: needs({ chosen: ['a'], unmet: { features: [{ id: 'a', name: 'Points per visit' }], epics: [] }, message: 'Not yet: "Points per visit" must be done first.' }), blocked: true },
    { name: 'its epic waits on another epic', n: needs({ unmet: { features: [], epics: [{ id: 'e', name: 'Online ordering' }] }, message: 'Not yet: the epic "Online ordering" must be done first.' }), blocked: true },
    { name: 'both', n: needs({ chosen: ['a', 'b'], unmet: { features: [{ id: 'a', name: 'Points per visit' }], epics: [{ id: 'e', name: 'Online ordering' }] }, message: 'Not yet: "Points per visit" and the epic "Online ordering" must be done first.' }), blocked: true },
  ];
  it.each(CASES)('$name: Mark done is enabled only when nothing is missing, and says what it waits on', async ({ n, blocked }) => {
    calls.getFeatureNeeds.mockResolvedValue(n);
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    const btn = await screen.findByRole('button', { name: /Mark done/ });
    await waitFor(() => expect(calls.getFeatureNeeds).toHaveBeenCalledWith('f1'));
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(blocked));
    if (blocked) {
      expect(btn.getAttribute('title')).toBe(n.message);
      expect(document.querySelector('[data-mark-done-waits]')!.textContent).toBe(n.message);
    } else expect(document.querySelector('[data-mark-done-waits]')).toBeNull();
    fireEvent.click(btn);
    expect(onDone).toHaveBeenCalledTimes(blocked ? 0 : 1);
    // The panel lists what was chosen, each with whether it is done yet, and what its epic waits on.
    const rows = [...document.querySelectorAll('[data-need]')].map((r) => [r.getAttribute('data-need'), r.getAttribute('data-met')]);
    const featureRows = n.chosen.map((id) => [id, String(!n.unmet.features.some((u) => u.id === id))]);
    const epicRows = n.unmet.epics.map((e) => [`epic:${e.id}`, 'false']);
    expect(rows).toEqual([...featureRows, ...epicRows]);
  });

  it('"⛓ Add what must be done first" offers exactly the candidates, ticked as chosen; ticking or unticking saves the whole list', async () => {
    calls.getFeatureNeeds.mockResolvedValue(needs({ chosen: ['b'] }));
    calls.planFeature.mockResolvedValue({});
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: '⛓ Add what must be done first' }));
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-need-pick] input[type="checkbox"]')];
    expect(boxes.map((b) => [b.value, b.checked])).toEqual([['a', false], ['b', true], ['c', false]]);
    fireEvent.click(boxes[0]);
    await waitFor(() => expect(calls.planFeature).toHaveBeenCalledWith('f1', { dependsOn: ['b', 'a'] }));
    await waitFor(() => expect(calls.getFeatureNeeds).toHaveBeenCalledTimes(2));
    fireEvent.click(document.querySelectorAll<HTMLInputElement>('[data-need-pick] input[type="checkbox"]')[1]);
    await waitFor(() => expect(calls.planFeature).toHaveBeenLastCalledWith('f1', { dependsOn: [] }));
  });

  it('a refusal from the server is shown, not swallowed', async () => {
    calls.getFeatureNeeds.mockResolvedValue(needs());
    calls.planFeature.mockRejectedValue(new Error('that would make the features wait on each other in a circle'));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: '⛓ Add what must be done first' }));
    fireEvent.click(document.querySelector<HTMLInputElement>('[data-need-pick] input[type="checkbox"]')!);
    await waitFor(() => expect(document.querySelector('[data-need-error]')!.textContent).toContain('circle'));
  });

  it('an older server with no needs route: no panel, and Mark done works as before', async () => {
    calls.getFeatureNeeds.mockRejectedValue(new Error('404'));
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    const btn = await screen.findByRole('button', { name: /Mark done/ });
    await waitFor(() => expect(calls.getFeatureNeeds).toHaveBeenCalled());
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[data-needs-first]')).toBeNull();
    fireEvent.click(btn);
    expect(onDone).toHaveBeenCalled();
  });
});

describe('"⛓ Waits on …" in the feature list', () => {
  const f = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, slug: id, state: 'planned', epicId: 'e2', startDate: '', targetDate: '', completedAt: null, dependsOn: [], blockedBy: [], waitsOnEpics: [], summary: '', ...over });
  const chart = {
    project: { id: 'p', name: 'P' }, vision: '', today: '2026-11-23', range: { from: '', to: '' }, totals: { planned: 0, 'under-way': 0, delivered: 0, late: 0 },
    epics: [
      { id: 'e1', name: 'Online ordering', outcome: '', icon: '', position: 0, nextUp: null, progress: { done: 0, total: 1 }, features: [f('a', 'Cart', { epicId: 'e1' })] },
      { id: 'e2', name: 'Loyalty', outcome: '', icon: '', position: 1, nextUp: null, progress: { done: 0, total: 3 }, features: [
        f('b', 'Points per visit'), f('c', 'Rewards page', { blockedBy: ['b'], waitsOnEpics: ['e1'] }), f('d', 'Badge', { waitsOnEpics: ['e1'] }),
      ] },
    ],
    unassigned: [f('u', 'Loose', { epicId: '', blockedBy: ['b', 'a'] })],
  } as unknown as RoadmapChart;
  it('every feature of the plan: what it waits on, features first then epics — nothing for one that waits on nothing', () => {
    const w = waitsByFeature(chart);
    expect([...w.entries()]).toEqual([
      ['c', ['"Points per visit"', 'the epic "Online ordering"']],
      ['d', ['the epic "Online ordering"']],
      ['u', ['"Points per visit"', '"Cart"']],
    ]);
    for (const [, names] of w) {
      cleanup();
      render(<WaitsOn names={names} />);
      expect(document.querySelector('[data-waits-on]')!.textContent).toBe(`⛓ Waits on ${names.join(', ')}`);
    }
    cleanup();
    const { container } = render(<WaitsOn names={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
