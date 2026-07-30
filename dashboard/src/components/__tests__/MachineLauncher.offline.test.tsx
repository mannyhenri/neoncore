import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import type { Machine } from '../../types';

/**
 * What "+ Launch" tells you about a machine that isn't connected.
 *
 * This is the bug the user actually hit: four repos under Documents/Git were registered
 * and correct on the server, but the MacBook's runner had been stranded offline, and the
 * launcher rendered the machine as the bare word "Offline" — no folder count, no reason,
 * no remedy, and the "Edit folders" control hidden. The repos became invisible, so a
 * perfectly good install read as a broken one.
 *
 * An offline machine must account for what it holds and say what to do about it.
 */

const getMachines = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    getMachines: () => getMachines(),
    setMachineRepos: vi.fn().mockResolvedValue({}),
    scanMachineFolder: vi.fn().mockResolvedValue({}),
    launchOnMachine: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../hooks/useSocket', () => ({ useSocket: () => ({ on: () => {}, off: () => {} }) }));

import { MachineLauncher } from '../MachineLauncher';

const machine = (o: Partial<Machine> & { hostname: string }): Machine => ({
  id: o.hostname,
  platform: 'darwin',
  arch: 'x64',
  repos: [],
  status: 'offline',
  lastSeen: '2026-07-30T13:21:51.355Z',
  ...o,
} as Machine);

const repos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `/Users/e/Documents/Git/repo${i}`, name: `repo${i}` }));

// Every state a machine row can be in. The offline-with-folders row is the reported bug.
const STATES = [
  { label: 'offline holding folders', m: machine({ hostname: 'macbook', status: 'offline', repos: repos(4) }), mustMention: ['4'] },
  { label: 'offline holding none', m: machine({ hostname: 'desktop', status: 'offline', repos: [] }), mustMention: [] },
  { label: 'online holding folders', m: machine({ hostname: 'macpro', status: 'online', repos: repos(2) }), mustMention: [] },
];

beforeEach(() => {
  getMachines.mockReset();
  getMachines.mockResolvedValue(STATES.map((s) => s.m));
});

async function openLauncher() {
  const view = render(<MachineLauncher />);
  fireEvent.click(await view.findByText('+ Launch'));
  await waitFor(() => expect(getMachines).toHaveBeenCalled());
  return view;
}

describe('+ Launch, offline machines', () => {
  it('says WHY an offline machine has nothing to launch, not just "Offline"', async () => {
    const { container } = await openLauncher();
    await waitFor(() => expect(container.textContent).toContain('macbook'));

    const text = container.textContent || '';
    // The old UI printed exactly "Offline" and stopped. A bare status is what made a
    // recoverable, well-understood state look like a broken install.
    expect(text, 'offline machine must explain that its runner is not connected').toMatch(/runner/i);
  });

  it('accounts for the folders an offline machine still holds', async () => {
    const { container } = await openLauncher();
    await waitFor(() => expect(container.textContent).toContain('macbook'));

    const text = container.textContent || '';
    expect(
      text,
      'an offline machine holding 4 registered folders must say so — otherwise they look lost',
    ).toMatch(/4\s+folders?/i);
  });

  // Set-based: every row must render something meaningful, none may regress to a bare word.
  it('every machine state renders an informative row', async () => {
    const { container } = await openLauncher();
    await waitFor(() => expect(container.textContent).toContain('macbook'));
    const text = container.textContent || '';

    const missing = STATES.filter((s) => !text.includes(s.m.hostname)).map((s) => s.label);
    expect(missing, `these machines never rendered: ${missing.join(', ')}`).toEqual([]);

    const unaccounted = STATES
      .filter((s) => s.mustMention.length > 0 && !s.mustMention.every((frag) => text.includes(frag)))
      .map((s) => s.label);
    expect(unaccounted, `these rows failed to account for their folders: ${unaccounted.join(', ')}`).toEqual([]);
  });

  it('still lets you fix it — the remedy is named, not just the problem', async () => {
    const { container } = await openLauncher();
    await waitFor(() => expect(container.textContent).toContain('macbook'));
    expect(container.textContent || '').toMatch(/start|restart/i);
  });
});
