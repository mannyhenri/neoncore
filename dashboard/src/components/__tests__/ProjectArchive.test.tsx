/**
 * ARCHIVE A PROJECT from its page: it leaves the picker (and the map — the server leaves it out of
 * the project list); the picker's "Archived" list has it, with Restore, which brings it back and
 * on screen. Refused while a feature is under way, with the server's reason.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

const project = (i: number) => ({ id: `p${i}`, name: `Project ${i}`, color: '#5AAEFF', primaryRepo: `/r/${i}`, cartridges: [`/r/${i}`], createdAt: `2026-01-0${i}`, featureCount: 2, featuresDone: 0, featuresActive: 0, featuresNeedYou: 0, featuresExisting: 0, costUsd: 0, description: '', archivedAt: '' });
const data = vi.hoisted(() => ({ live: [] as Record<string, unknown>[], archived: [] as Record<string, unknown>[], refuse: '' }));
const setProjectArchived = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', () => ({ api: new Proxy({}, { get: (_t, name: string) => {
  if (name === 'getGoalProjects') return () => Promise.resolve(data.live);
  if (name === 'getArchivedProjects') return () => Promise.resolve(data.archived);
  if (name === 'setProjectArchived') return setProjectArchived;
  return () => Promise.resolve([]);
} }) }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => {} }));
import { ProjectsProvider, ProjectPicker, ProjectsWorkspace } from '../ProjectsPage';

const page = () => render(<ProjectsProvider active agents={[]}><ProjectPicker /><ProjectsWorkspace /></ProjectsProvider>);
const picker = () => document.querySelector<HTMLButtonElement>('[data-project-picker-button]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[data-project-option]')].map((o) => o.dataset.projectOption);
beforeEach(() => {
  window.location.hash = '#project/p1';
  data.live = [project(1), project(2)]; data.archived = []; data.refuse = '';
  setProjectArchived.mockReset().mockImplementation(async (id: string, archived: boolean) => {
    if (data.refuse) throw new Error(data.refuse);
    const from = archived ? data.live : data.archived; const to = archived ? data.archived : data.live;
    const i = from.findIndex((p) => p.id === id); const [p] = from.splice(i, 1);
    const moved = { ...p, archivedAt: archived ? '2026-11-23T12:00:00Z' : '' }; to.push(moved);
    return moved;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ''; });

describe('archiving a project', () => {
  it('Archive takes it off the list; Archived has it; Restore brings it back, on screen', async () => {
    page();
    await waitFor(() => expect(document.querySelector('[data-archive-project]')).not.toBeNull());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(document.querySelector('[data-archive-project]')!);
    await waitFor(() => expect(setProjectArchived).toHaveBeenCalledWith('p1', true));
    fireEvent.click(picker());
    await waitFor(() => expect(options()).toEqual(['p2']));
    const toggle = await waitFor(() => { const t = document.querySelector<HTMLElement>('[data-archived-toggle]'); expect(t).not.toBeNull(); return t!; });
    expect(toggle.textContent).toMatch(/^Archived\s*1$/);
    fireEvent.click(toggle);
    const row = document.querySelector<HTMLElement>('[data-archived-project="p1"]')!;
    expect(row.textContent).toContain('Project 1');
    fireEvent.click(row.querySelector('[data-restore]')!);
    await waitFor(() => expect(setProjectArchived).toHaveBeenLastCalledWith('p1', false));
    await waitFor(() => expect(window.location.hash).toBe('#project/p1'));
    await waitFor(() => expect(picker().textContent).toContain('Project 1'));
    fireEvent.click(picker());
    await waitFor(() => expect(options().sort()).toEqual(['p1', 'p2']));
    expect(document.querySelector('[data-archived-toggle]'), 'nothing archived: no Archived list').toBeNull();
  });

  it('asks first; refused while a feature is under way, with the server\'s reason, and nothing changes', async () => {
    page();
    await waitFor(() => expect(document.querySelector('[data-archive-project]')).not.toBeNull());
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(document.querySelector('[data-archive-project]')!);
    expect(ask.mock.calls[0][0]).toMatch(/Archive "Project 1"\? It leaves the map and the project list/);
    expect(setProjectArchived).not.toHaveBeenCalled();
    ask.mockReturnValue(true);
    data.refuse = 'Not while 1 feature is under way — finish or stop it first.';
    fireEvent.click(document.querySelector('[data-archive-project]')!);
    await waitFor(() => expect(document.querySelector('[data-archive-error]')!.textContent).toBe(data.refuse));
    fireEvent.click(picker());
    await waitFor(() => expect(options()).toEqual(['p1', 'p2']));
  });
});
