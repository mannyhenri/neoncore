/**
 * THE BOARD — a project's features in four columns, left to right: To do → In Progress → QA → Done
 * (server lib/project-spec.ts places each one). Drag a card, or use Move…, to put it somewhere; Done
 * is a status (moving there marks it done, moving out reopens it). Chart or Board: the last one
 * used is where the Roadmap tab opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react';
import type { SpecFeature } from '../../types';

const calls = vi.hoisted(() => ({ getProjectSpec: vi.fn(), getProjectImports: vi.fn(), updateGoal: vi.fn() }));
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
  calls.getProjectSpec.mockResolvedValue(SPEC); calls.getProjectImports.mockResolvedValue([]); calls.updateGoal.mockResolvedValue({});
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
