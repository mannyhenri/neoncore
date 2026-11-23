/**
 * THE VIEW REGISTRY — every screen in the view bar, in order.
 *
 * V3 adds Workflows as its own view: the Agents screen is now the scene and takes the whole
 * space, so the workflow templates that used to sit in its rail needed a home of their own.
 * `__tests__/views.registry.test.ts` iterates this list, so a view cannot be added without a
 * switch in the view bar, a title and a working surface.
 */
export const VIEWS = ['projects', 'agents', 'workflows', 'tasks', 'tokens', 'qa', 'triage'] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_TITLE: Record<View, string> = {
  projects: 'Projects',
  agents: 'Agents',
  workflows: 'Workflows',
  tasks: 'Tasks',
  tokens: 'Tokens',
  qa: 'QA',
  triage: 'Triage',
};

/** How the Agents screen is drawn: the scene, or the plain list of cartridge cards. */
export const AGENTS_LAYOUTS = ['scene', 'list'] as const;
export type AgentsLayout = (typeof AGENTS_LAYOUTS)[number];

const LAYOUT_KEY = 'neoncore.agentsLayout';

export function readAgentsLayout(): AgentsLayout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return (AGENTS_LAYOUTS as readonly string[]).includes(v ?? '') ? (v as AgentsLayout) : 'scene';
  } catch {
    return 'scene';
  }
}

export function writeAgentsLayout(layout: AgentsLayout): void {
  try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* the choice just won't persist */ }
}
