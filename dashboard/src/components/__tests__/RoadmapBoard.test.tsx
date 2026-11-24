/**
 * THE BOARD — a project's features in four columns, left to right: To do → In Progress → QA → Done
 * (server lib/project-spec.ts places each one). Drag a card, or use Move…, to put it somewhere; Done
 * is a status (moving there marks it done, moving out reopens it). Chart or Board: the last one
 * used is where the Roadmap tab opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react';
import type { SpecFeature } from '../../types';

const calls = vi.hoisted(() => ({ getProjectSpec: vi.fn(), getProjectImports: vi.fn(), updateGoal: vi.fn(), setEpicQa: vi.fn(), getEpicQa: vi.fn(), runEpicQa: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: calls }));
const party = vi.hoisted(() => ({ celebrateFeature: vi.fn() }));
vi.mock('../../lib/celebrate', () => party);
vi.mock('../../world/roadmap/RoadmapChart', () => ({ RoadmapChart: () => <div data-chart-stub /> }));
import { RoadmapTab, BOARD_COLUMNS, ROADMAP_TAB_KEY } from '../ProjectHub';

const f = (id: string, status: SpecFeature['status'], column: SpecFeature['column'], lane: SpecFeature['lane'] = ''): SpecFeature => ({
  id, name: `Feature ${id}`, status, column, lane, intent: { summary: '' }, criteria: [], criteriaMet: 0, targetDate: '', completedAt: status === 'done' ? '2026-11-20T10:00:00Z' : null,
} as unknown as SpecFeature);
const FEATURES = [
  f('a', 'planned', 'todo'), f('b', 'planned', 'todo'),
  f('c', 'in-progress', 'progress'), f('d', 'paused', 'progress'), f('e', 'planned', 'progress', 'progress'),
  f('g', 'delivered', 'qa'),
  f('h', 'done', 'done'),
  f('x', 'existing', null),
];
const SPEC = { features: FEATURES, totals: { features: 8, existing: 1, done: 1, inProgress: 1, paused: 1, delivered: 1, planned: 3, verified: 0 } };
const project = { id: 'p1', name: 'Orbit' } as never;
const mount = async () => {
  const onChanged = vi.fn();
  render(<RoadmapTab project={project} version={0} onOpenFeature={vi.fn()} onChanged={onChanged} />);
  await waitFor(() => expect(document.querySelector('[data-board-column], [data-chart-stub]')).not.toBeNull());
  return { onChanged };
};
const col = (k: string) => document.querySelector<HTMLElement>(`[data-board-column="${k}"]`)!;
beforeEach(() => {
  window.localStorage.setItem(ROADMAP_TAB_KEY, 'board');
  party.celebrateFeature.mockClear();
  calls.getProjectSpec.mockResolvedValue(SPEC); calls.getProjectImports.mockResolvedValue([]); calls.updateGoal.mockResolvedValue({}); calls.setEpicQa.mockReset().mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe('the Board', () => {
  it('four columns, left to right: To do, In Progress, QA, Done — each feature in the column the server placed it', async () => {
    await mount();
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual(['todo', 'progress', 'qa', 'done']);
    expect([...document.querySelectorAll('[data-board-column]')].map((c) => c.getAttribute('data-board-column'))).toEqual(['todo', 'progress', 'qa', 'done']);
    expect([...document.querySelectorAll('[data-board-column] h4')].map((h) => h.textContent)).toEqual(['To do 2', 'In Progress 3', 'QA 1', 'Done 1']);
    for (const c of BOARD_COLUMNS) {
      expect([...col(c.key).querySelectorAll('[data-board-card]')].map((n) => n.getAttribute('data-board-card'))).toEqual(FEATURES.filter((x) => x.column === c.key).map((x) => x.id));
    }
    expect(document.querySelector('[data-board-card="x"]'), 'a feature that already existed is not on the board').toBeNull();
    expect(screen.queryByText(/^(Now|Next|Later)\b/)).toBeNull();
  });

  it.each([
    { id: 'a', to: 'progress', body: { roadmapLane: 'progress' } },
    { id: 'a', to: 'qa', body: { roadmapLane: 'qa' } },
    { id: 'c', to: 'todo', body: { roadmapLane: 'todo' } },
    { id: 'h', to: 'qa', body: { status: 'active', roadmapLane: 'qa' } },
    { id: 'g', to: 'done', body: { status: 'achieved', roadmapLane: '' } },
  ])('dragging $id to $to sends $body', async ({ id, to, body }) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onChanged } = await mount();
    const data = new Map<string, string>();
    const dt = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: '' };
    fireEvent.dragStart(document.querySelector(`[data-board-card="${id}"]`)!, { dataTransfer: dt });
    fireEvent.dragOver(col(to), { dataTransfer: dt });
    fireEvent.drop(col(to), { dataTransfer: dt });
    await waitFor(() => expect(calls.updateGoal).toHaveBeenCalledWith(id, body));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // Fireworks for a feature dropped on Done — and only then.
    expect(party.celebrateFeature.mock.calls).toEqual(to === 'done' ? [[`Feature ${id}`]] : []);
  });

  it('Move… offers every other column, and "back to automatic" for a placed card', async () => {
    await mount();
    const options = (id: string) => [...document.querySelectorAll<HTMLOptionElement>(`[data-board-card="${id}"] select option`)].map((o) => o.value).filter(Boolean);
    expect(options('a')).toEqual(['progress', 'qa', 'done']);
    expect(options('e')).toEqual(['todo', 'qa', 'done', 'auto']);
    fireEvent.change(document.querySelector('[data-board-card="e"] select')!, { target: { value: 'auto' } });
    await waitFor(() => expect(calls.updateGoal).toHaveBeenCalledWith('e', { roadmapLane: '' }));
  });

  it('an older server\'s Now / Next / Later: on this board where that work is, nothing lost', async () => {
    calls.getProjectSpec.mockResolvedValue({ ...SPEC, features: [f('n', 'in-progress', 'now' as never), f('x1', 'planned', 'next' as never), f('l', 'planned', 'later' as never), f('h', 'done', 'done')] });
    await mount();
    const ids = (k: string) => [...col(k).querySelectorAll('[data-board-card]')].map((n) => n.getAttribute('data-board-card'));
    expect([ids('todo'), ids('progress'), ids('qa'), ids('done')]).toEqual([['x1', 'l'], ['n'], [], ['h']]);
  });

  it('EPIC QA: a done feature whose epic has not passed QA waits in QA, under its epic — "Passed QA" when every feature is done; never dragged to Done on its own', async () => {
    const q = (id: string, epicId: string, epicName: string, epicQa: string, status: SpecFeature['status'] = 'done') => ({ ...f(id, status, status === 'done' ? 'qa' : 'todo'), epicId, epicName, epicQa });
    calls.getProjectSpec.mockResolvedValue({ ...SPEC, features: [
      q('w1', 'e0', 'Phase 0', 'waiting'), q('w2', 'e0', 'Phase 0', 'waiting'),
      q('o1', 'e1', 'Phase 1', 'open'), q('o2', 'e1', 'Phase 1', 'open', 'planned'),
      f('g', 'delivered', 'qa'), { ...f('h', 'done', 'done'), epicQa: 'passed', epicId: 'e9', epicName: 'Old' },
    ] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Phase 0's QA run passed, so Passed QA is allowed (a failed or missing run blocks it).
    calls.getEpicQa.mockResolvedValue({ run: null, current: { id: 'r', status: 'passed', passing: 2, total: 2, at: '', finishedAt: '', failing: [], blockedReason: null } });
    const { onChanged } = await mount();
    const qa = col('qa');
    expect([...qa.querySelectorAll('[data-epic-qa]')].map((n) => n.getAttribute('data-epic-qa'))).toEqual(['e0', 'e1']);
    const ready = qa.querySelector<HTMLElement>('[data-epic-qa="e0"]')!;
    expect(ready.textContent).toContain('Phase 0');
    expect([...ready.querySelectorAll('[data-board-card]')].map((n) => n.getAttribute('data-board-card'))).toEqual(['w1', 'w2']);
    const notYet = qa.querySelector<HTMLElement>('[data-epic-qa="e1"]')!;
    expect(notYet.querySelector('[data-epic-pass-qa]'), 'not every feature done: nothing to sign off yet').toBeNull();
    expect(notYet.textContent).toContain('1 feature still to finish');
    for (const id of ['w1', 'w2', 'o1']) expect(document.querySelector(`[data-board-card="${id}"] [data-qa-waiting]`), id).not.toBeNull();
    expect(document.querySelector('[data-board-card="g"] [data-qa-waiting]'), 'delivered, not yet marked done: no epic wait').toBeNull();
    expect([...col('done').querySelectorAll('[data-board-card]')].map((n) => n.getAttribute('data-board-card'))).toEqual(['h']);
    // Dragged to Done on its own: refused, with what to do.
    const data = new Map<string, string>();
    const dt = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: '' };
    fireEvent.dragStart(document.querySelector('[data-board-card="w1"]')!, { dataTransfer: dt });
    fireEvent.drop(col('done'), { dataTransfer: dt });
    await waitFor(() => expect(screen.getByText(/moves to Done when its epic passes QA/)).toBeTruthy());
    expect(calls.updateGoal).not.toHaveBeenCalled();
    // Passed QA: one call for the epic.
    await waitFor(() => expect(ready.querySelector<HTMLButtonElement>('[data-epic-pass-qa]')!.disabled).toBe(false));
    fireEvent.click(ready.querySelector('[data-epic-pass-qa]')!);
    await waitFor(() => expect(calls.setEpicQa).toHaveBeenCalledWith('e0', true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('Chart or Board: the last one used is where the tab opens', async () => {
    window.localStorage.setItem(ROADMAP_TAB_KEY, 'chart');
    await mount();
    expect(document.querySelector('[data-chart-stub]')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
    expect(col('todo')).not.toBeNull();
    expect(window.localStorage.getItem(ROADMAP_TAB_KEY)).toBe('board');
    cleanup();
    await mount();
    expect(col('todo')).not.toBeNull();
  });
});
