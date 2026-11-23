/**
 * THE PROJECT PICKER and THE PROJECT'S TABS — the Projects page is one column: the project is
 * chosen from a dropdown at the top, and its tabs start with the design system.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';

const project = (i: number, over: object = {}) => ({ id: `p${i}`, name: `Project ${i}`, color: '#5AAEFF', primaryRepo: `/r/${i}`, cartridges: [`/r/${i}`], createdAt: `2026-01-0${i}`, featureCount: 4, featuresDone: i, featuresActive: 0, featuresNeedYou: 0, featuresExisting: 0, costUsd: 0, description: '', ...over });
const data = vi.hoisted(() => ({ projects: [] as unknown[], goals: [] as unknown[] }));
vi.mock('../../lib/api', () => ({ api: new Proxy({}, { get: (_t, name: string) => {
  if (name === 'getGoalProjects' || name === 'getProjects') return () => Promise.resolve(data.projects);
  if (name === 'getGoals') return () => Promise.resolve(data.goals);
  return () => Promise.resolve([]);
} }) }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => {} }));

import { ProjectsProvider, ProjectPicker, ProjectsWorkspace } from '../ProjectsPage';

const page = () => render(<ProjectsProvider active agents={[]}><ProjectPicker /><ProjectsWorkspace /></ProjectsProvider>);
const picker = () => document.querySelector<HTMLButtonElement>('[data-project-picker-button]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[data-project-option]')];

beforeEach(() => { window.location.hash = ''; data.projects = [project(1), project(2, { featuresNeedYou: 2 }), project(3)]; data.goals = []; });
afterEach(() => { cleanup(); window.location.hash = ''; });

describe('the project picker', () => {
  it('says the project on screen; opened, it lists every project, and choosing one puts it on screen and closes the list', async () => {
    page();
    await waitFor(() => expect(picker().textContent).toContain('Project'));
    expect(picker().getAttribute('aria-expanded')).toBe('false');
    expect(options()).toHaveLength(0);
    fireEvent.click(picker());
    expect(picker().getAttribute('aria-expanded')).toBe('true');
    expect(options().map((o) => o.dataset.projectOption)).toEqual(['p1', 'p2', 'p3']);
    // Exactly one is the selected one, and it is the one the button names.
    const selected = options().filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(picker().textContent).toContain(selected[0].textContent!.match(/Project \d/)![0]);
    // Every project can be chosen.
    for (const id of ['p3', 'p2', 'p1']) {
      if (options().length === 0) fireEvent.click(picker());
      fireEvent.click(options().find((o) => o.dataset.projectOption === id)!);
      await waitFor(() => expect(picker().textContent).toContain(`Project ${id.slice(1)}`));
      expect(options(), 'the list closes on a choice').toHaveLength(0);
      expect(window.location.hash).toBe(`#project/${id}`);
    }
  });

  it('closes on Escape and on a click outside, and a project elsewhere that needs you is said on the closed picker', async () => {
    page();
    await waitFor(() => expect(picker().textContent).toContain('Project'));
    fireEvent.click(picker());
    fireEvent.click(options().find((o) => o.dataset.projectOption === 'p1')!);
    await waitFor(() => expect(picker().textContent).toContain('Project 1'));
    // Project 2 has two features waiting: not hidden behind the closed dropdown.
    expect(document.querySelector('[data-others-need-you]')!.textContent).toBe('+2 elsewhere');
    fireEvent.click(picker());
    expect(options().find((o) => o.dataset.projectOption === 'p2')!.textContent).toContain('2 need you');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(options()).toHaveLength(0);
    fireEvent.click(picker());
    fireEvent.pointerDown(document.body);
    expect(options()).toHaveLength(0);
  });

  it('with no project it says so and still offers "+ New project"', async () => {
    data.projects = [];
    page();
    await waitFor(() => expect(picker().textContent).toContain('No projects yet'));
    expect(screen.getAllByText('+ New project').length).toBeGreaterThan(0);
  });
});

describe('the project\'s tabs', () => {
  it('start with Roadmap, then Design system, then Features — and the page still opens on Features', async () => {
    page();
    await waitFor(() => expect(document.querySelector('[role="tablist"]')).not.toBeNull());
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tablist"] button')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Roadmap', 'Design system', 'Features', 'Spec', 'Changelog', 'Architecture']);
    expect(tabs.filter((t) => t.getAttribute('aria-current') === 'page').map((t) => t.textContent)).toEqual(['Features']);
    expect(document.querySelector('[data-design-system]')).toBeNull();
    fireEvent.click(tabs[1]);
    await waitFor(() => expect(document.querySelector('[data-design-system]')).not.toBeNull());
    expect(document.querySelector('[data-design-system]')!.textContent).toMatch(/Find the direction/);
    expect(tabs[1].getAttribute('aria-current')).toBe('page');
  });
});
