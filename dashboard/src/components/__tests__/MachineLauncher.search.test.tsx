import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import type { Machine } from '../../types';
import { filterMachinesByRepo, countRepos } from '@neoncore/client';

/**
 * Finding one repo in a fleet, without losing WHICH COMPUTER it is on.
 *
 * "+ Launch" lists every machine and, under each, every folder its runner exposes. That is
 * fine with two machines and four folders and unusable at fleet scale — the reported ask is a
 * quick search across repos that still says which box each hit came from, because the same
 * repo is checked out on several machines and picking the right copy is the entire decision.
 *
 * WHY THE MACHINE MUST SURVIVE THE FILTER. A flat list of matching repo names answers the
 * wrong question: `gridlight` exists on the Mac Pro and the MacBook, and launching in the
 * wrong one puts the cartridge on a box the user is not sitting at. So hostname is BOTH a
 * search term (type "gridlight macbook") and a required part of every rendered result.
 *
 * THE SET. Not "does search work" — every rule the matcher has to obey, iterated. An
 * example-based test ("searching gridlight finds gridlight") passes on a matcher that ignores
 * paths, drops offline machines, or silently loses the hostname, which are exactly the
 * half-done versions this prevents.
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

const m = (hostname: string, status: 'online' | 'offline', repos: [string, string][]): Machine => ({
  id: hostname, hostname, platform: 'darwin', arch: 'arm64', status,
  lastSeen: '2026-08-21T10:00:00.000Z',
  repos: repos.map(([name, path]) => ({ name, path })),
});

/**
 * The fleet under test. Deliberately contains the shape that motivates the feature: ONE repo
 * name (`gridlight`) checked out on two different machines, at two different paths.
 */
const FLEET: Machine[] = [
  m('mac-pro', 'online', [
    ['gridlight', '/Users/e/code/gridlight'],
    ['neoncore', '/Users/e/code/neoncore'],
    ['film-engine', '/Users/e/code/film-engine'],
  ]),
  m('macbook', 'online', [
    ['gridlight', '/Users/e/Documents/Git/gridlight'],
    ['baseback', '/Users/e/Documents/Git/baseback'],
  ]),
  m('build-box', 'offline', [
    ['gridlight-work', '/srv/gridlight-work'],
  ]),
  m('empty-box', 'online', []),
];

/** THE SET: every rule the matcher must obey. */
const CASES: {
  label: string;
  query: string;
  /** hostname -> the repo names that must survive, in any order. Absent host = filtered out. */
  expect: Record<string, string[]>;
}[] = [
  {
    label: 'empty query changes nothing — every machine, every repo, empty one included',
    query: '',
    expect: { 'mac-pro': ['gridlight', 'neoncore', 'film-engine'], macbook: ['gridlight', 'baseback'], 'build-box': ['gridlight-work'], 'empty-box': [] },
  },
  {
    label: 'whitespace-only is the same as empty, not a search for nothing',
    query: '   ',
    expect: { 'mac-pro': ['gridlight', 'neoncore', 'film-engine'], macbook: ['gridlight', 'baseback'], 'build-box': ['gridlight-work'], 'empty-box': [] },
  },
  {
    label: 'a repo name on two machines keeps BOTH — this is the whole point',
    query: 'gridlight',
    expect: { 'mac-pro': ['gridlight'], macbook: ['gridlight'], 'build-box': ['gridlight-work'] },
  },
  {
    label: 'case-insensitive',
    query: 'GRIDLIGHT',
    expect: { 'mac-pro': ['gridlight'], macbook: ['gridlight'], 'build-box': ['gridlight-work'] },
  },
  {
    label: 'matches on PATH, not just name — how you tell two checkouts apart',
    query: 'Documents/Git',
    expect: { macbook: ['gridlight', 'baseback'] },
  },
  {
    label: 'hostname is a search term — "everything on the macbook"',
    query: 'macbook',
    expect: { macbook: ['gridlight', 'baseback'] },
  },
  {
    label: 'multi-word narrows across repo AND machine — the disambiguating search',
    query: 'gridlight macbook',
    expect: { macbook: ['gridlight'] },
  },
  {
    label: 'an OFFLINE machine still matches — its folders are registered, just not launchable',
    query: 'gridlight-work',
    expect: { 'build-box': ['gridlight-work'] },
  },
  {
    label: 'a machine with no folders cannot match anything',
    query: 'empty-box',
    expect: {},
  },
  {
    label: 'no match anywhere yields nothing, not everything',
    query: 'zzzz-not-a-repo',
    expect: {},
  },
];

describe('+ Launch, repo search (the matcher)', () => {
  it('the fleet fixture is non-trivial — an empty one would pass every case vacuously', () => {
    expect(FLEET.length).toBeGreaterThan(3);
    expect(countRepos(FLEET)).toBeGreaterThan(5);
    const names = FLEET.flatMap((x) => x.repos.map((r) => r.name));
    expect(new Set(names).size, 'fixture must contain a repo name on two machines').toBeLessThan(names.length);
  });

  it('EVERY matching rule holds', () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const got = filterMachinesByRepo(FLEET, c.query);
      const actual: Record<string, string[]> = {};
      for (const machine of got) actual[machine.hostname] = machine.repos.map((r) => r.name);

      const hosts = [...new Set([...Object.keys(c.expect), ...Object.keys(actual)])];
      for (const h of hosts) {
        const want = c.expect[h];
        const have = actual[h];
        if (want === undefined) { wrong.push(`${c.label}: "${h}" should have been filtered out, got [${have}]`); continue; }
        if (have === undefined) { wrong.push(`${c.label}: "${h}" is missing, expected [${want}]`); continue; }
        if ([...want].sort().join(',') !== [...have].sort().join(',')) {
          wrong.push(`${c.label}: "${h}" expected [${want}] got [${have}]`);
        }
      }
    }
    expect(wrong, `matcher rules broken:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('never mutates the fleet it was given', () => {
    const before = JSON.stringify(FLEET);
    filterMachinesByRepo(FLEET, 'gridlight');
    expect(JSON.stringify(FLEET), 'filtering mutated the source machines').toEqual(before);
  });
});

describe('+ Launch, repo search (the UI)', () => {
  beforeEach(() => {
    getMachines.mockReset();
    getMachines.mockResolvedValue(FLEET);
  });

  async function openLauncher() {
    const view = render(<MachineLauncher />);
    fireEvent.click(await view.findByText('+ Launch'));
    await waitFor(() => expect(getMachines).toHaveBeenCalled());
    await waitFor(() => expect(view.container.textContent).toContain('mac-pro'));
    return view;
  }

  it('offers a search box when the launcher is open', async () => {
    const view = await openLauncher();
    expect(view.container.querySelector('input[data-testid="repo-search"]')).toBeTruthy();
  });

  /**
   * The load-bearing assertion: for EVERY case that keeps results, the machine each result
   * came from is still on screen. This is what stops the feature from becoming a flat list
   * of repo names you cannot act on.
   */
  it('EVERY search keeps the machine each result came from visible', async () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const view = await openLauncher();
      const input = view.container.querySelector('input[data-testid="repo-search"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: c.query } });
      await waitFor(() => {});
      const text = view.container.textContent || '';

      const searching = c.query.trim().length > 0;
      for (const [host, repoNames] of Object.entries(c.expect)) {
        if (repoNames.length === 0) continue;
        if (!text.includes(host)) wrong.push(`"${c.query}": host "${host}" vanished from the UI`);

        // With NO search the launcher keeps its original layout, and an offline row
        // deliberately summarises ("N folders still registered") instead of listing names —
        // see MachineLauncher.offline.test.tsx. Listing them is a search-only behaviour,
        // because only then is "which machine holds this repo" the question being asked.
        const offline = FLEET.find((f) => f.hostname === host)?.status === 'offline';
        if (offline && !searching) continue;

        for (const r of repoNames) {
          if (!text.includes(r)) wrong.push(`"${c.query}": repo "${r}" (on ${host}) not rendered`);
        }
      }
      for (const machine of FLEET) {
        if (c.expect[machine.hostname] === undefined && machine.repos.length > 0 && text.includes(machine.hostname)) {
          wrong.push(`"${c.query}": host "${machine.hostname}" should have been filtered out but is rendered`);
        }
      }
      view.unmount();
    }
    expect(wrong, `search UI broken:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('says so when nothing matches, instead of rendering an empty panel', async () => {
    const view = await openLauncher();
    const input = view.container.querySelector('input[data-testid="repo-search"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzzz-not-a-repo' } });
    await waitFor(() => {
      expect((view.container.textContent || '').toLowerCase()).toMatch(/no (repo|folder|match)/);
    });
  });
});
