import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, render, screen, fireEvent } from '@testing-library/react';

/**
 * The dashboard talks to ONE server: the one that served it.
 *
 * REQUESTED: "right now we are connecting multiple machines together and reporting to each other
 * and I would rather not do this anymore and keep the server isolated to the machine I'm working
 * on". The dashboard used to merge every server it knew — added by hand, or learned from its
 * server's peer roster every 30 s — into one grid. THE SET is every way an earlier version left a
 * server list in this browser's storage; for each, only the local server is ever queried, no peer
 * roster is asked for, and a command goes to the local server.
 */
const REMOTE = 'http://studio.local:4040';
const { local, remote } = vi.hoisted(() => {
  function fake(name: string, agentId: string) {
    const calls: string[] = [];
    const agent = {
      id: agentId, name: agentId, machine: 'm', repoPath: `/r/${agentId}`, repoName: agentId, branch: 'main', currentTask: '',
      status: 'idle', trustMode: false, plansIncluded: false, mode: 'manual', agentType: 'claude', lastSeen: '2026-11-19T00:00:00Z',
      sessionId: '', lastMessage: '', pendingQuestion: '', recoveryStatus: '', interruptedAt: '', activeObjective: '', dismissedAt: '',
    };
    const rec = <T,>(what: string, v: T) => { calls.push(what); return Promise.resolve(v); };
    return {
      calls,
      client: {
        origin: name,
        getAgents: () => rec('getAgents', [agent]),
        getActivity: () => rec('getActivity', []),
        getPendingPermissions: () => rec('getPendingPermissions', []),
        getTasks: () => rec('getTasks', []),
        getPeers: () => rec('getPeers', { self: { serverId: `sid-${name}`, name, url: name, version: '1' }, peers: [{ url: 'http://studio.local:4040', serverId: 'sid-remote', name: 'studio', stale: false }] }),
        sendCommand: (agentId: string, text: string) => rec(`sendCommand:${agentId}:${text}`, { id: 'c1' }),
      },
    };
  }
  return { local: fake('', 'a-local'), remote: fake('http://studio.local:4040', 'a-remote') };
});

vi.mock('../../lib/api', () => ({ api: local.client, apiFor: (url: string) => (url ? remote.client : local.client) }));
vi.mock('../useSocket', () => ({ useSockets: () => ({ connectedOrigins: { '': true } }), useSocket: () => ({ connected: true }) }));

import { useAgents } from '../useAgents';
import { ServerPicker } from '../../components/ServerPicker';

const STORED_LISTS: [string, unknown[]][] = [
  ['a server added by hand', [{ url: REMOTE, serverId: '', name: 'studio', manual: true }]],
  ['a server found through gossip', [{ url: REMOTE, serverId: 'sid-remote', name: 'studio', manual: false }]],
  ['a hidden server', [{ url: REMOTE, serverId: '', name: 'studio', manual: true, hidden: true }]],
  ['this server under another name', [{ url: window.location.origin, serverId: '', name: 'me-again', manual: true }]],
  ['nothing stored', []],
];

beforeEach(() => { localStorage.clear(); local.calls.length = 0; remote.calls.length = 0; });
afterEach(() => { vi.clearAllMocks(); });

describe('one server, whatever an earlier version stored', () => {
  for (const [label, stored] of STORED_LISTS) {
    it(label, async () => {
      if (stored.length) localStorage.setItem('neoncore.servers.v1', JSON.stringify(stored));
      const { result } = renderHook(() => useAgents());
      await waitFor(() => expect(result.current.agents.map((a) => a.id)).toEqual(['a-local']));
      expect(result.current.servers.map((s) => s.url)).toEqual(['']);
      await act(async () => { await result.current.sendCommand('a-local', 'hello'); });
      expect(local.calls).toContain('sendCommand:a-local:hello');
      expect(local.calls).not.toContain('getPeers');
      expect(remote.calls, `another server was contacted: ${remote.calls.join(', ')}`).toEqual([]);
    });
  }
});

describe('the server pill', () => {
  it('shows the connection and the fleet token — no list of servers, nothing to add', () => {
    const onSetToken = vi.fn();
    render(<ServerPicker statuses={[{ url: '', reachable: true, authFailed: false, lastError: '', lastOkAt: '' }] as never} onSetToken={onSetToken} />);
    fireEvent.click(screen.getByRole('button', { name: /live/i }));
    expect(screen.queryByPlaceholderText(/studio\.local/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.getByRole('button', { name: /fleet token/i })).toBeTruthy();
  });
});
