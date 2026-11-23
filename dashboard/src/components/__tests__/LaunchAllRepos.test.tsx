import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { planProjectLaunch, sameRepoPath } from '@neoncore/client';
import type { Agent, Machine } from '../../types';

/**
 * "Launch all repos" on a project = the + Launch menu's launch, once per repo. THE SET under test
 * is every rule that makes that true: the right machine for each repo, the runner's own path
 * spelling, offline runners ignored, live repos skipped by default, and one launchOnMachine call
 * per chosen repo with the same arguments the menu would send.
 */

const getMachines = vi.fn();
const launchOnMachine = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    getMachines: () => getMachines(),
    launchOnMachine: (...a: unknown[]) => launchOnMachine(...a),
  },
  apiFor: () => { throw new Error('single-server test: every launch must go to the same-origin client'); },
}));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => ({ on: () => {}, off: () => {} }) }));

import { LaunchAllRepos } from '../LaunchAllRepos';

const m = (hostname: string, status: 'online' | 'offline', paths: string[]): Machine => ({
  id: hostname, hostname, platform: 'darwin', arch: 'arm64', status, lastSeen: '2026-11-23T10:00:00.000Z',
  repos: paths.map((path) => ({ path, name: path.split('/').pop()! })),
});

const FLEET: Machine[] = [
  m('macbook', 'online', ['/Users/e/code/api']),
  m('mac-pro', 'online', ['/Users/e/code/web', '/Users/e/code/api', '/Users/e/code/infra/']),
  m('build-box', 'offline', ['/srv/docs']),
];
const PROJECT = ['/Users/e/code/web', '/Users/e/code/api', '/Users/E/code/infra', '/srv/docs'];

describe('planProjectLaunch — the rules', () => {
  const plan = planProjectLaunch(PROJECT, FLEET);
  const by = (r: string) => plan.find((p) => p.repoPath === r)!;

  it.each([
    ['one repo per project repo, in project order', () => expect(plan.map((p) => p.repoPath)).toEqual(PROJECT)],
    ['a repo on one machine targets that machine', () => expect(by('/Users/e/code/web').targets.map((t) => t.machine.id)).toEqual(['mac-pro'])],
    ['a repo on several machines prefers the box holding most of the project', () =>
      expect(by('/Users/e/code/api').targets.map((t) => t.machine.id)).toEqual(['mac-pro', 'macbook'])],
    ['case and trailing slash are spelling; the RUNNER\'s spelling is what gets launched', () =>
      expect(by('/Users/E/code/infra').targets[0].path).toBe('/Users/e/code/infra/')],
    ['an offline runner is not a target', () => expect(by('/srv/docs').targets).toEqual([])],
  ])('%s', (_label, check) => check());

  it.each([
    ['C:\\code\\api', 'c:/code/api/', true],
    ['/a/b', '/a/b/', true],
    ['/a/b', '/a/bc', false],
    ['', '', false],
  ])('sameRepoPath(%s, %s) = %s', (a, b, want) => expect(sameRepoPath(a, b)).toBe(want));
});

describe('LaunchAllRepos — launches like one-by-one', () => {
  beforeEach(() => {
    getMachines.mockReset().mockResolvedValue(FLEET);
    launchOnMachine.mockReset().mockResolvedValue({ ok: true, sessionId: 'remote-1', resumed: null });
  });

  const liveApi = { id: 'a1', repoPath: '/Users/e/code/api', status: 'idle' } as unknown as Agent;

  it('launches each launchable, not-running repo once, in order, on its machine', async () => {
    render(<LaunchAllRepos repos={PROJECT} agents={[liveApi]} servers={[]} onClose={() => {}} />);
    // api is already running → unticked; docs is nowhere online → not launchable. 2 remain.
    const btn = await screen.findByRole('button', { name: 'Launch 2 repos' });
    fireEvent.click(btn);
    await waitFor(() => expect(launchOnMachine).toHaveBeenCalledTimes(2));
    expect(launchOnMachine.mock.calls).toEqual([
      ['mac-pro', '/Users/e/code/web', 'claude', undefined, undefined],
      ['mac-pro', '/Users/e/code/infra/', 'claude', undefined, undefined],
    ]);
    await screen.findByRole('button', { name: 'Done' });
  });

  it('honours fresh, a re-ticked live repo, and a machine override', async () => {
    render(<LaunchAllRepos repos={PROJECT} agents={[liveApi]} servers={[]} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Launch 2 repos' });
    fireEvent.click(screen.getByLabelText('Launch api'));
    fireEvent.change(screen.getByLabelText('Machine for api'), { target: { value: 'macbook' } });
    fireEvent.click(screen.getByLabelText("Start fresh (don't resume)"));
    fireEvent.click(screen.getByRole('button', { name: 'Launch 3 repos' }));
    await waitFor(() => expect(launchOnMachine).toHaveBeenCalledTimes(3));
    expect(launchOnMachine.mock.calls.map((c) => [c[0], c[1], c[4]])).toEqual([
      ['mac-pro', '/Users/e/code/web', { fresh: true }],
      ['macbook', '/Users/e/code/api', { fresh: true }],
      ['mac-pro', '/Users/e/code/infra/', { fresh: true }],
    ]);
  });

  it('one failure is reported on its row and does not stop the rest', async () => {
    launchOnMachine.mockRejectedValueOnce(new Error('Machine is offline'));
    render(<LaunchAllRepos repos={PROJECT} agents={[]} servers={[]} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch 3 repos' }));
    await waitFor(() => expect(launchOnMachine).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Machine is offline')).toBeTruthy();
    expect(screen.getAllByText(/on mac-pro — fresh session/)).toHaveLength(2);
  });
});
