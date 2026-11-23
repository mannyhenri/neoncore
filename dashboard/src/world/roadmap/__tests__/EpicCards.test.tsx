/**
 * THE EPIC CARDS under the route: every epic in order, each card saying where it stands, its date,
 * what it needs, its features — and every control one call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { RoadmapChart, RoadmapEpic, RoadmapFeature, RoadmapFeatureState } from '../../../types';
import { EpicCards, CARD_STATE, datePill } from '../EpicCards';
import { epicStage } from '../routeLayout';

const feature = (id: string, epicId: string, state: RoadmapFeatureState = 'planned', over: Partial<RoadmapFeature> = {}): RoadmapFeature => ({
  id, name: `Feature ${id}`, slug: id, state, epicId, startDate: '', targetDate: '', completedAt: null, dependsOn: [], blockedBy: [], summary: '', ...over,
});
const epic = (id: string, name: string, features: RoadmapFeature[], over: Partial<RoadmapEpic> = {}): RoadmapEpic => ({
  id, name, outcome: `${name} outcome`, icon: '', position: 0, features, nextUp: null,
  progress: { done: features.filter((f) => f.state === 'delivered').length, total: features.length },
  targetDate: '', dependsOn: [], blockedBy: [], deliveredAt: null, onTime: false, late: false, ...over,
});
const EPICS = [
  epic('e1', 'Winter season launch', [feature('a1', 'e1', 'delivered'), feature('a2', 'e1', 'delivered')], { targetDate: '2026-12-13', deliveredAt: '2026-11-18T10:00:00Z', onTime: true }),
  epic('e2', 'Menu & specials', [feature('b1', 'e2', 'delivered')], { targetDate: '2026-11-10', deliveredAt: '2026-11-13T10:00:00Z' }),
  epic('e3', 'Reservations', [feature('c1', 'e3', 'delivered'), feature('c2', 'e3', 'under-way')], { targetDate: '2026-12-22', dependsOn: ['e1'], nextUp: 'c3' }),
  epic('e4', 'Accessibility', [feature('d1', 'e4', 'late')], { targetDate: '2026-11-01', late: true }),
  epic('e5', 'Loyalty', [feature('f1', 'e5', 'planned', { waitsOnEpics: ['e4'] })], { dependsOn: ['e4', 'e1'], blockedBy: ['e4'] }),
  epic('e6', 'Polish', []),
];
const CHART = { project: { id: 'p', name: 'Diner' }, vision: '', epics: EPICS, unassigned: [], range: { from: '', to: '' }, today: '2026-11-23', totals: { planned: 0, 'under-way': 0, delivered: 0, late: 0 } } as RoadmapChart;
const STAGES = EPICS.map(epicStage);
afterEach(cleanup);

function mount(over: Partial<Parameters<typeof EpicCards>[0]> = {}) {
  const props = {
    chart: CHART, stages: STAGES, selected: null, onSelect: vi.fn(), selectedFeature: null, onPickFeature: vi.fn(),
    iconOf: () => ({ src: '/world/roadmap/icon-planet.png' }), editor: (e: RoadmapEpic) => <div data-editor-for={e.id} />, busy: false,
    onStart: vi.fn(), onAddEpic: vi.fn(), onAddFeature: vi.fn(), onReorder: vi.fn(), onDelete: vi.fn(), onMoveFeature: vi.fn(), ...over,
  };
  render(<EpicCards {...props} />);
  return props;
}
const card = (id: string) => document.querySelector<HTMLElement>(`[data-epic-card="${id}"]`)!;

describe('the epic cards', () => {
  it('every epic, in plan order, under a summary line and the New epic button', () => {
    const p = mount();
    expect([...document.querySelectorAll('[data-epic-card]')].map((c) => c.getAttribute('data-epic-card'))).toEqual(EPICS.map((e) => e.id));
    expect(document.querySelector('[data-epic-cards-summary]')!.textContent).toBe('The route · 6 epics · 4 of 7 features done');
    fireEvent.click(document.querySelector('[data-new-epic]')!);
    expect(p.onAddEpic).toHaveBeenCalled();
  });

  const WANT: Record<string, { state: string; date: string | null; needs: [string, string][]; progress: string; word: string[] }> = {
    e1: { state: 'Done', date: '🎖 On time · due Dec 13, 2026', needs: [], progress: '2/2 done', word: ['done', 'done'] },
    e2: { state: 'Done', date: 'Delivered 3 days after Nov 10, 2026', needs: [], progress: '1/1 done', word: ['done'] },
    e3: { state: 'Under way', date: 'Due Dec 22, 2026', needs: [['⛓ Needs Winter season launch ✓', 'true']], progress: '1/2 done', word: ['done', 'under way'] },
    e4: { state: 'Late', date: 'Late · was due Nov 1, 2026', needs: [], progress: '0/1 done', word: ['late'] },
    e5: { state: 'Waiting', date: null, needs: [['⛓ Needs Accessibility', 'false'], ['⛓ Needs Winter season launch ✓', 'true']], progress: '0/1 done', word: ['⛓ waits'] },
    e6: { state: 'Planned', date: null, needs: [], progress: '0/0 done', word: [] },
  };
  it.each(EPICS.map((e, i) => ({ name: e.name, e, i })))('$name: number, name, state, date, needs, outcome, progress, features', ({ e, i }) => {
    mount();
    const c = card(e.id);
    const w = WANT[e.id];
    expect(c.textContent).toContain(`${i + 1}${e.name}`);
    expect(c.getAttribute('data-stage')).toBe(STAGES[i]);
    expect(c.querySelector('[data-epic-icon]')!.getAttribute('data-epic-icon')).toBe(STAGES[i]);
    expect(c.querySelector('[data-epic-pill="state"]')!.textContent).toBe(w.state);
    expect(CARD_STATE[STAGES[i]]).toBe(w.state);
    expect(c.querySelector('[data-epic-pill="date"]')?.textContent ?? null).toBe(w.date);
    expect(datePill(e)?.text ?? null).toBe(w.date);
    expect([...c.querySelectorAll('[data-epic-pill="needs"]')].map((n) => [n.textContent, n.getAttribute('data-met')])).toEqual(w.needs);
    expect(c.textContent).toContain(e.outcome);
    expect(c.querySelector('[data-epic-progress]')!.textContent).toBe(w.progress);
    expect([...c.querySelectorAll('[data-epic-feature]')].map((f) => f.getAttribute('data-epic-feature'))).toEqual(e.features.map((f) => f.id));
    expect([...c.querySelectorAll('[data-feature-word]')].map((f) => f.textContent)).toEqual(w.word);
    expect(c.querySelector('[data-epic-start]') !== null).toBe(e.nextUp !== null);
  });

  it.each(EPICS.map((e, i) => ({ name: e.name, i })))('$name: ← and → reorder (never off either end), Edit opens its editor, Delete asks for it', ({ i }) => {
    const p = mount();
    const e = EPICS[i];
    const c = card(e.id);
    const left = c.querySelector<HTMLButtonElement>('[data-epic-left]')!;
    const right = c.querySelector<HTMLButtonElement>('[data-epic-right]')!;
    expect(left.disabled).toBe(i === 0);
    expect(right.disabled).toBe(i === EPICS.length - 1);
    const ids = EPICS.map((x) => x.id);
    fireEvent.click(left); fireEvent.click(right);
    const want: string[][] = [];
    if (i > 0) { const n = [...ids]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; want.push(n); }
    if (i < ids.length - 1) { const n = [...ids]; [n[i], n[i + 1]] = [n[i + 1], n[i]]; want.push(n); }
    expect((p.onReorder as ReturnType<typeof vi.fn>).mock.calls.map((x: unknown[]) => x[0])).toEqual(want);
    expect(p.onSelect).not.toHaveBeenCalled();
    fireEvent.click(c.querySelector('[data-epic-delete]')!);
    expect(p.onDelete).toHaveBeenCalledWith(e);
    fireEvent.click(c.querySelector('[data-epic-edit]')!);
    expect(document.querySelector(`[data-editor-for="${e.id}"]`)).not.toBeNull();
  });

  it('a feature row opens its card; a card is selected by a click; the selected card is lit', () => {
    const p = mount({ selected: 'e3', selectedFeature: 'c2' });
    expect([...document.querySelectorAll('[data-epic-card][data-selected]')].map((c) => c.getAttribute('data-epic-card'))).toEqual(['e3']);
    expect(document.querySelector('[data-epic-feature][data-selected]')!.getAttribute('data-epic-feature')).toBe('c2');
    fireEvent.click(document.querySelector('[data-epic-feature="b1"]')!);
    expect(p.onPickFeature).toHaveBeenCalledWith('b1');
    expect(p.onSelect).not.toHaveBeenCalled();
    fireEvent.click(card('e4'));
    expect(p.onSelect).toHaveBeenCalledWith('e4');
    fireEvent.click(card('e3').querySelector('[data-epic-start]')!);
    expect(p.onStart).toHaveBeenCalledWith('c3');
  });

  it('+ add a feature to this epic: a name and a date, into that epic', () => {
    const p = mount();
    fireEvent.click(document.querySelector('[data-epic-add-feature="e6"]')!);
    fireEvent.change(screen.getByLabelText('New feature name'), { target: { value: 'Dark mode' } });
    fireEvent.change(screen.getByLabelText('New feature target date'), { target: { value: '2027-01-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(p.onAddFeature).toHaveBeenCalledWith('e6', 'Dark mode', '2027-01-10');
  });

  it('dragging a feature onto another epic\'s card moves it there; onto its own epic, nothing', () => {
    const p = mount();
    const data = new Map<string, string>();
    const dt = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', get types() { return [...data.keys()]; } };
    fireEvent.dragStart(document.querySelector('[data-epic-feature="a1"]')!, { dataTransfer: dt });
    fireEvent.dragOver(card('e6'), { dataTransfer: dt });
    expect(card('e6').hasAttribute('data-drop-target')).toBe(true);
    fireEvent.drop(card('e6'), { dataTransfer: dt });
    expect(p.onMoveFeature).toHaveBeenCalledWith('a1', 'e6');
    fireEvent.drop(card('e1'), { dataTransfer: dt });
    expect(p.onMoveFeature).toHaveBeenCalledTimes(1);
  });
});
