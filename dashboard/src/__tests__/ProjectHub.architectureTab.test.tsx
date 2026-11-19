import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';

/**
 * REQUESTED: "for the architecture generation, I'd like instead of doing an MD to generate an
 * artifact that shows in the architecture tab. and don't ask to generate everything there."
 *
 * The tab asks for the architecture only — none of the other parts is offered — and shows the
 * generated page in a sandboxed frame (no permissions: the page is written by a cartridge).
 */
const mocks = vi.hoisted(() => ({ getArchitecturePage: vi.fn(async () => ({ html: '<h1>How it is built</h1><svg></svg>' })) }));
vi.mock('../lib/api', () => {
  const client = { getProjectImports: vi.fn(async () => []), getArchitecturePage: mocks.getArchitecturePage };
  return { api: client, apiFor: () => client };
});

import { ArchitectureTab } from '../components/ProjectHub';

const project = (over: Partial<Project>) => ({ id: 'p', name: 'P', cartridges: ['/r'], primaryRepo: '/r', architecture: '', ...over }) as unknown as Project;

describe('the Architecture tab', () => {
  it('offers only the architecture — no part to tick, no features, changelog or backlog', () => {
    render(<ArchitectureTab project={project({})} agents={[]} version={0} onChanged={() => {}} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    for (const other of ['Existing features + specs', 'Changelog', 'Backlog']) expect(screen.queryByText(other)).toBeNull();
    expect(screen.getByText('Not generated yet — generate it with AI above.')).toBeTruthy();
  });

  it('shows the generated page in a frame with no permissions', async () => {
    const { container } = render(<ArchitectureTab project={project({ hasArchitecturePage: true })} agents={[]} version={0} onChanged={() => {}} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('How it is built');
  });
});
