import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSpec, SpecFeature } from '../types';

/**
 * REPORTED: "If I click on it, it doesn't render the page (spec section)".
 *
 * The server serves the dashboard from server/public, so a rebuilt dashboard reaches the browser
 * before the server process that sends `groups` is restarted. The Spec tab read
 * `spec.groups.length` and threw on a spec without it — a blank page. The tab must render every
 * shape a server can send: without groups (an older server), with no areas, and grouped.
 */
const mocks = vi.hoisted(() => ({ getProjectSpec: vi.fn() }));
vi.mock('../lib/api', () => {
  const client = { getProjectSpec: mocks.getProjectSpec, getProjectImports: vi.fn(async () => []) };
  return { api: client, apiFor: () => client };
});

import { SpecTab } from '../components/ProjectHub';

const feature = (id: string, area: string): SpecFeature => ({
  id, name: `Feature ${id}`, slug: id, position: 0, status: 'existing', origin: 'imported', area, alignment: 'documented',
  intent: { summary: '', doneWhen: '', inScope: '', outOfScope: '', invariants: '', assumptions: '' },
  criteria: [], criteriaMet: 0, delivery: null, targetDate: '', lane: '', column: null, completedAt: null, updatedAt: '',
});
const base = (features: SpecFeature[]): ProjectSpec => ({
  generatedAt: '', project: { id: 'p', name: 'P', description: '', repos: [], mainRepo: '', color: '' }, architecture: '',
  features, groups: [],
  totals: { features: features.length, existing: features.length, planned: 0, inProgress: 0, delivered: 0, done: 0, paused: 0, verified: 0, gaps: 0, intentOnly: 0 },
});
const counts = { features: 1, existing: 1, planned: 0, building: 0, done: 0, verified: 0, gaps: 0 };

const SHAPES: [string, ProjectSpec, string[]][] = [
  ['an older server (no groups, no area)', (() => { const s = base([feature('a', '')]) as Partial<ProjectSpec>; delete s.groups; s.features = s.features!.map((f) => { const { area: _a, ...rest } = f; return rest as SpecFeature; }); return s as ProjectSpec; })(), ['Feature a']],
  ['no areas (flat list)', base([feature('a', '')]), ['Feature a']],
  ['grouped', { ...base([feature('a', 'Gateway · Routing'), feature('b', 'Work')]), groups: [
    { name: 'Gateway', summary: 'Routes requests.', sections: [{ name: 'Routing', featureIds: ['a'] }], counts },
    { name: 'Work', summary: '', sections: [{ name: '', featureIds: ['b'] }], counts },
  ] }, ['Gateway', 'Routes requests.', 'Work', 'Feature a', 'Feature b']],
];

const project = { id: 'p', name: 'P', cartridges: [], primaryRepo: '' } as unknown as Project;

describe('the Spec tab renders every spec shape a server can send', () => {
  for (const [label, spec, expected] of SHAPES) {
    it(label, async () => {
      mocks.getProjectSpec.mockResolvedValueOnce(spec);
      render(<SpecTab project={project} agents={[]} version={0} onOpenFeature={() => {}} onChanged={() => {}} />);
      await screen.findByText(/planned features done/);
      // Groups start open for a short list; open any that are not, then every expected text is on the page.
      for (const b of screen.queryAllByText('Expand all')) fireEvent.click(b);
      for (const t of expected) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    });
  }
});
