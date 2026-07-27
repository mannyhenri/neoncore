import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ApiError } from '@neoncore/client';

/**
 * Merged-grid behaviour across several servers.
 *
 * Each case is a failure mode that produces NO error when it goes wrong — the grid just
 * shows something quietly incorrect. That is precisely why they are pinned here.
 */

const LOCAL = '';
const REMOTE = 'http://studio.local:4040';

// vi.mock is hoisted above every top-level binding, so the fixtures it closes over must
// be created inside vi.hoisted or they do not exist yet when the factory runs.
const { local, remote } = vi.hoisted(() => {
  const LOCAL_URL = '';
  const REMOTE_URL = 'http://studio.local:4040';

  function makeAgent(id: string, over: Record<string, unknown> = {}) {
    return {
      id, name: id, machine: 'm', repoPath: `/r/${id}`, repoName: id, branch: 'main',
      currentTask: '', status: 'idle', trustMode: false, plansIncluded: false, mode: 'manual',
      agentType: 'claude', lastSeen: '2026-07-27T00:00:00Z', sessionId: '', lastMessage: '',
      pendingQuestion: '', recoveryStatus: '', interruptedAt: '', activeObjective: '', dismissedAt: '',
      ...over,
    };
  }

  /** One fake server. Reads resolve from `state`; writes are recorded for routing assertions. */
  function fakeServer(name: string, agents: ReturnType<typeof makeAgent>[]) {
    const sent: { agentId: string; text: string }[] = [];
    const state = { agents, fail: null as Error | null, sent, name };
    const guard = <T,>(value: T) => (state.fail ? Promise.reject(state.fail) : Promise.resolve(value));
    return {
      state,
      client: {
        origin: name,
        getAgents: () => guard(state.agents),
        getActivity: () => guard([] as unknown[]),
        getPendingPermissions: () => guard([] as unknown[]),
        getTasks: () => guard([] as unknown[]),
        getPeers: () => guard({
          self: { serverId: `sid-${name}`, name, url: name, version: '1' },
          // Typed explicitly: an empty literal infers never[], which then rejects the
          // populated rosters the aliasing tests substitute in.
          peers: [] as { url: string; serverId: string; name: string; stale: boolean }[],
        }),
        sendCommand: (agentId: string, text: string) => {
          sent.push({ agentId, text });
          return Promise.resolve({ id: 'c1' });
        },
        setAgentMode: (id: string, mode: string) => Promise.resolve(makeAgent(id, { mode })),
      },
    };
  }

  return {
    local: fakeServer(LOCAL_URL, [makeAgent('a-local')]),
    remote: fakeServer(REMOTE_URL, [makeAgent('a-remote')]),
  };
});

vi.mock('../../lib/api', () => ({
  api: local.client,
  apiFor: (url: string) => (url === REMOTE ? remote.client : local.client),
}));

// Sockets are a separate concern; the merge must be correct from polling alone.
vi.mock('../useSocket', () => ({
  useSockets: () => ({ connectedOrigins: { '': true } }),
  useSocket: () => ({ connected: true }),
}));

import { useAgents } from '../useAgents';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    'neoncore.servers.v1',
    JSON.stringify([{ url: REMOTE, serverId: '', name: 'studio', manual: true }]),
  );
  local.state.fail = null;
  remote.state.fail = null;
  local.state.sent.length = 0;
  remote.state.sent.length = 0;
});

afterEach(() => { vi.clearAllMocks(); });

describe('merged grid', () => {
  it('shows cartridges from every server at once', async () => {
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents).toHaveLength(2));
    expect(result.current.agents.map((a) => a.id).sort()).toEqual(['a-local', 'a-remote']);
  });

  it('tags every cartridge with the server it came from', async () => {
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents).toHaveLength(2));

    // Without this the grid cannot route a write, and cannot label which machine a
    // cartridge lives on. Both failures are silent.
    const byId = Object.fromEntries(result.current.agents.map((a) => [a.id, a]));
    expect(byId['a-local'].origin).toBe(LOCAL);
    expect(byId['a-remote'].origin).toBe(REMOTE);
  });

  it('routes a command to the server that owns the agent', async () => {
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents).toHaveLength(2));

    await act(async () => { await result.current.sendCommand('a-remote', 'hello studio'); });

    // The whole point of origin tagging. Sending to the wrong server is not an error --
    // that server simply has no such agent and does nothing at all.
    expect(remote.state.sent).toEqual([{ agentId: 'a-remote', text: 'hello studio' }]);
    expect(local.state.sent).toEqual([]);
  });

  it('routes to local for a local agent', async () => {
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents).toHaveLength(2));

    await act(async () => { await result.current.sendCommand('a-local', 'hey'); });
    expect(local.state.sent).toEqual([{ agentId: 'a-local', text: 'hey' }]);
    expect(remote.state.sent).toEqual([]);
  });

  it('ONE unreachable server does not blank the others', async () => {
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents).toHaveLength(2));

    // The studio laptop goes to sleep.
    remote.state.fail = new ApiError('unreachable', 'fetch failed', { origin: REMOTE });
    await act(async () => { await result.current.refreshData(); });

    await waitFor(() => {
      const status = result.current.serverStatuses.find((s) => s.url === REMOTE);
      expect(status?.reachable).toBe(false);
    });

    // Local cartridges are untouched, and the sleeping server keeps its last-known-good
    // rather than vanishing. A grid that empties itself when a laptop sleeps is worse
    // than one showing data it admits is stale.
    expect(result.current.agents.map((a) => a.id).sort()).toEqual(['a-local', 'a-remote']);
  });

  it('distinguishes a rejected token from an unreachable machine', async () => {
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents).toHaveLength(2));

    remote.state.fail = new ApiError('auth', 'Invalid fleet token', { status: 401, origin: REMOTE });
    await act(async () => { await result.current.refreshData(); });

    await waitFor(() => {
      const status = result.current.serverStatuses.find((s) => s.url === REMOTE);
      // Reporting this as "unreachable" sends you debugging the network for what is a
      // one-line token fix.
      expect(status?.authFailed).toBe(true);
      expect(status?.reachable).toBe(false);
    });
  });

  it('keeps activity buffers per server so a chatty machine cannot starve a quiet one', async () => {
    // 150 events on the remote, 1 on the local. With a single shared 100-item buffer the
    // local event would be evicted entirely and its cartridge would render empty.
    remote.client.getActivity = () =>
      Promise.resolve(Array.from({ length: 150 }, (_, i) => ({
        id: `r${i}`, agentId: 'a-remote', type: 'tool_use', summary: 'x', detail: '',
        timestamp: `2026-07-27T00:00:${String(i % 60).padStart(2, '0')}Z`,
      })));
    local.client.getActivity = () =>
      Promise.resolve([{
        id: 'l1', agentId: 'a-local', type: 'tool_use', summary: 'quiet', detail: '',
        timestamp: '2026-07-27T00:00:00Z',
      }]);

    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.activities.length).toBeGreaterThan(0));
    await waitFor(() => {
      expect(result.current.activitiesByAgent['a-local']).toBeDefined();
    });
    expect(result.current.activitiesByAgent['a-local']).toHaveLength(1);
  });

  it('never lists the local server twice, however storage is seeded', async () => {
    // A stale entry naming this very origin would otherwise duplicate every local
    // cartridge in the grid.
    localStorage.setItem(
      'neoncore.servers.v1',
      JSON.stringify([
        { url: window.location.origin, serverId: '', name: 'me-again', manual: true },
        { url: REMOTE, serverId: '', name: 'studio', manual: true },
      ]),
    );
    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.servers.length).toBe(2));
    expect(result.current.servers.filter((s) => !s.url)).toHaveLength(1);
  });
});

describe('server aliasing — the duplicate-cartridge bug', () => {
  it('does NOT adopt the local server again under the name it advertises to peers', async () => {
    // The real-world shape of the bug: you browse to http://localhost:4040, but the
    // server advertises itself to peers as http://mannys-mac-pro.local:4040. A peer
    // gossips that name back, and URL comparison alone sees a brand-new server — so the
    // local server is added twice and EVERY cartridge on it renders twice.
    const SELF_ALIAS = 'http://mannys-mac-pro.local:4040';

    local.client.getPeers = () => Promise.resolve({
      self: { serverId: 'sid-local', name: 'Mannys-Mac-Pro', url: SELF_ALIAS, version: '1' },
      peers: [],
    });
    // The remote knows this machine by its advertised name and gossips it back.
    remote.client.getPeers = () => Promise.resolve({
      self: { serverId: 'sid-remote', name: 'studio', url: REMOTE, version: '1' },
      peers: [{ url: SELF_ALIAS, serverId: 'sid-local', name: 'Mannys-Mac-Pro', stale: false }],
    });

    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents.length).toBeGreaterThan(0));
    // Give discovery a tick to do its damage, if it is going to.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const localish = result.current.servers.filter(
      (s) => !s.url || s.url === SELF_ALIAS || s.serverId === 'sid-local',
    );
    expect(localish).toHaveLength(1);

    // The symptom the user actually sees.
    const ids = result.current.agents.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'a-local')).toHaveLength(1);
  });

  it('collapses an alias already sitting in storage from a previous session', async () => {
    // Anyone who ran the buggy build has the duplicate persisted in localStorage. It has
    // to heal on load, not require the user to find and delete it by hand.
    localStorage.setItem('neoncore.servers.v1', JSON.stringify([
      { url: 'http://mannys-mac-pro.local:4040', serverId: 'sid-local', name: 'dupe', manual: false },
      { url: REMOTE, serverId: 'sid-remote', name: 'studio', manual: true },
    ]));
    local.client.getPeers = () => Promise.resolve({
      self: { serverId: 'sid-local', name: 'Mannys-Mac-Pro', url: 'http://mannys-mac-pro.local:4040', version: '1' },
      peers: [],
    });

    const { result } = renderHook(() => useAgents());
    await waitFor(() => expect(result.current.agents.length).toBeGreaterThan(0));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const ids = result.current.agents.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
