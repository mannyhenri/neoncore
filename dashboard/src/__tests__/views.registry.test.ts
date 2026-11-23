import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VIEWS, VIEW_TITLE, AGENTS_LAYOUTS } from '../lib/views';

/**
 * V3: "the agents screen … the entire space will be replaced by the scene. The workflow
 * templates will move to its own screen."
 *
 * Set-based over the VIEWS registry, so adding a view without a nav switch, a title or a
 * working surface fails here — and so does the half-move this ask could have produced:
 * Workflows gaining a nav entry while its panel stays behind in the Agents rail.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../App.tsx'), 'utf8');
const nav = SRC.slice(SRC.indexOf('<nav'), SRC.indexOf('</nav>'));
const main = SRC.slice(SRC.indexOf('<main'), SRC.lastIndexOf('</main>'));
const aside = SRC.slice(SRC.indexOf('<aside'), SRC.indexOf('</aside>'));

/** What renders each view's working surface inside <main>. */
const SURFACE: Record<(typeof VIEWS)[number], RegExp> = {
  projects: /<ProjectsWorkspace/,
  agents: /<WorldScene/,
  workflows: /<WorkflowPanel/,
  tasks: /<TasksPage/,
  tokens: /<TokensPage/,
  qa: /<QaPage/,
  triage: /<TriagePage/,
};

describe('the view registry', () => {
  it('has exactly the V3 views and QA, Triage, Workflows among them', () => {
    expect([...VIEWS]).toEqual(['projects', 'agents', 'workflows', 'tasks', 'tokens', 'qa', 'triage']);
    expect(Object.keys(SURFACE).sort()).toEqual([...VIEWS].sort());
  });

  it.each(VIEWS.map((v) => ({ v })))('$v has a title, a switch in the view bar and a surface in <main>', ({ v }) => {
    expect(VIEW_TITLE[v]).toBeTruthy();
    expect(nav, 'no switch in the view bar').toContain(`setActiveView('${v}')`);
    expect(SURFACE[v].test(main), 'no working surface in <main>').toBe(true);
  });

  it('Workflows left the Agents rail entirely', () => {
    expect(aside).not.toMatch(/<WorkflowPanel/);
    expect(SRC.match(/<WorkflowPanel/g)).toHaveLength(1);
  });

  it('the Agents screen is the scene by default, with the list as the plain view', () => {
    expect([...AGENTS_LAYOUTS]).toEqual(['scene', 'list']);
    expect(main).toMatch(/<CartridgeGrid/);   // the plain view keeps every cartridge control
    expect(main).toMatch(/<WorldScene/);
  });
});
