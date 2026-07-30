import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import type { Machine, ServerEntry } from '../../types';

/**
 * "+ Launch" across a fleet.
 *
 * Agents already merge across every server (useAgents) — "point the app at one server and
 * the rest of the fleet appears". Machines did not: MachineLauncher called a plain
 * single-server api.getMachines(). So a MacBook whose runner registers with the Mac Pro
 * showed its four repos on the Mac Pro's portal and an empty launcher on its own, which
 * read as "my install is broken" when nothing was.
 *
 * The correctness trap is the second half: a machine's launch/edit/scan MUST go back to
 * the server that owns it. Routing everything at the page's own server would dispatch a
 * launch to a box that has never heard of that machine.
 */

const LOCAL = '';                                   // the server that served the page
const REMOTE = 'http://emmanuels-macbook-pro.local:4040';

const machine = (id: string, hostname: string): Machine => ({
  id, hostname, platform: 'darwin', arch: 'x64',
  repos: [{ path: `/repos/${id}`, name: id }],
  status: 'online', lastSeen: '2026-07-30T14:02:35.140Z',
} as Machine);

// The registry this test iterates: which machines live on which server.
const FLEET: { base: string; label: string; machines: Machine[] }[] = [
  { base: LOCAL,  label: 'mac-pro (local)', machines: [machine('mp1', 'Mannys-Mac-Pro'), machine('mp2', 'DESKTOP-MGGCGSG')] },
  { base: REMOTE, label: 'macbook (remote)', machines: [machine('mb1', 'Emmanuels-MacBook-Pro.local')] },
];

const ALL = FLEET.flatMap((s) => s.machines);

function makeClient(base: string) {
  const entry = FLEET.find((s) => s.base === base);
  return {
    getMachines: vi.fn().mockResolvedValue(entry ? entry.machines : []),
    launchOnMachine: vi.fn().mockResolvedValue({ ok: true, sessionId: 's' }),
    setMachineRepos: vi.fn().mockResolvedValue({ ok: true }),
    scanMachineFolder: vi.fn().mockResolvedValue({ ok: true }),
  };
}

let clients: Record<string, ReturnType<typeof makeClient>>;

vi.mock('../../lib/api', () => ({
  get api() { return clients[LOCAL]; },
  apiFor: (base: string) => clients[base] ?? makeClient(base),
}));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => ({ on: () => {}, off: () => {} }) }));

import { MachineLauncher } from '../MachineLauncher';

const servers: ServerEntry[] = [
  { url: LOCAL, serverId: 'a', name: 'Mannys-Mac-Pro', token: null, manual: true } as ServerEntry,
  { url: REMOTE, serverId: 'b', name: 'Emmanuels-MacBook-Pro', token: null, manual: true } as ServerEntry,
];

beforeEach(() => {
  clients = { [LOCAL]: makeClient(LOCAL), [REMOTE]: makeClient(REMOTE) };
});

async function openLauncher(list: ServerEntry[] = servers) {
  const view = render(<MachineLauncher servers={list} />);
  fireEvent.click(await view.findByText('+ Launch'));
  await waitFor(() => expect(clients[LOCAL].getMachines).toHaveBeenCalled());
  return view;
}

describe('+ Launch across the fleet', () => {
  it('asks EVERY active server for its machines, not just the page origin', async () => {
    await openLauncher();
    const unasked = FLEET.filter((s) => clients[s.base].getMachines.mock.calls.length === 0).map((s) => s.label);
    expect(unasked, `these servers were never queried: ${unasked.join(', ')}`).toEqual([]);
  });

  it('shows every machine from every server, exactly once', async () => {
    const { container } = await openLauncher();
    await waitFor(() => expect(container.textContent).toContain('Emmanuels-MacBook-Pro.local'));

    const text = container.textContent || '';
    const missing = ALL.filter((m) => !text.includes(m.hostname)).map((m) => m.hostname);
    expect(missing, `these machines never appeared: ${missing.join(', ')}`).toEqual([]);

    for (const m of ALL) {
      const hits = text.split(m.hostname).length - 1;
      expect(hits, `${m.hostname} rendered ${hits} times`).toBe(1);
    }
  });

  // THE correctness trap: every machine's launch must reach the server that owns it.
  it('routes a launch to the OWNING server for every machine in the fleet', async () => {
    const misrouted: string[] = [];

    for (const server of FLEET) {
      for (const m of server.machines) {
        clients = { [LOCAL]: makeClient(LOCAL), [REMOTE]: makeClient(REMOTE) };
        const view = render(<MachineLauncher servers={servers} />);
        fireEvent.click(await view.findByText('+ Launch'));
        await waitFor(() => expect(view.container.textContent).toContain(m.hostname));

        // Expand the repo (its name is the machine id), then pick an agent type.
        fireEvent.click(await view.findByText(m.repos[0].name));
        fireEvent.click(await view.findByText('Claude'));

        await waitFor(() => {
          expect(FLEET.some((s) => clients[s.base].launchOnMachine.mock.calls.length > 0)).toBe(true);
        });

        const calledOn = FLEET
          .filter((s) => clients[s.base].launchOnMachine.mock.calls.length > 0)
          .map((s) => s.label);
        if (calledOn.length !== 1 || calledOn[0] !== server.label) {
          misrouted.push(`${m.hostname} (owned by ${server.label}) → dispatched to ${calledOn.join(',') || 'nothing'}`);
        }
        view.unmount();
      }
    }

    expect(misrouted, `launches sent to the wrong server: ${misrouted.join(' | ')}`).toEqual([]);
  });

  it('one unreachable server does not blank the rest', async () => {
    clients[REMOTE].getMachines.mockRejectedValue(new Error('asleep'));
    const { container } = await openLauncher();
    await waitFor(() => expect(container.textContent).toContain('Mannys-Mac-Pro'));
    expect(container.textContent, 'a sleeping laptop must not hide the healthy server').toContain('Mannys-Mac-Pro');
  });

  it('falls back to the local server when no roster is supplied', async () => {
    await openLauncher([]);
    expect(clients[LOCAL].getMachines).toHaveBeenCalled();
  });
});
