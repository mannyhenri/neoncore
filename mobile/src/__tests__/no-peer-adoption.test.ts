import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The phone talks to the servers you gave it — it no longer adopts the ones a server gossips about.
 *
 * REQUESTED: "right now we are connecting multiple machines together and reporting to each other
 * and I would rather not do this anymore and keep the server isolated to the machine I'm working
 * on". The phone used to add every peer in its servers' rosters every 30 s. Now:
 *   - a roster updates the identity (id, name) of the server that sent it, and adds nothing;
 *   - servers an earlier version adopted ("found") are dropped on load; ones you added stay.
 */
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));
const { loadServers, applyServerIdentity } = await import('../config');

const MAC = 'http://mac.local:4040';
const LAPTOP = 'http://laptop.local:4040';
beforeEach(() => store.clear());

describe('a roster adds nothing', () => {
  it('updates the sender\'s identity and adopts none of its peers', () => {
    const before = [{ url: MAC, name: '', serverId: '', token: null, manual: true }];
    const roster = {
      self: { serverId: 'sid-mac', name: 'Mac Pro', url: MAC, version: '1' },
      peers: [{ url: LAPTOP, serverId: 'sid-laptop', name: 'Laptop', stale: false }],
    };
    const after = applyServerIdentity(before, MAC, roster);
    expect(after.map((s) => s.url)).toEqual([MAC]);
    expect(after[0]).toMatchObject({ serverId: 'sid-mac', name: 'Mac Pro' });
  });
});

describe('servers adopted by an earlier version are dropped; yours stay', () => {
  const CASES: [string, unknown[], string[]][] = [
    ['only adopted ones', [{ url: LAPTOP, name: 'Laptop', serverId: 'x', token: null, manual: false }], []],
    ['yours and adopted', [
      { url: MAC, name: 'Mac', serverId: '', token: null, manual: true },
      { url: LAPTOP, name: 'Laptop', serverId: 'x', token: null, manual: false },
    ], [MAC]],
    ['only yours', [{ url: MAC, name: 'Mac', serverId: '', token: null, manual: true }], [MAC]],
  ];
  for (const [label, stored, want] of CASES) {
    it(label, async () => {
      store.set('neoncore.servers.v1', JSON.stringify(stored));
      expect((await loadServers()).map((s) => s.url)).toEqual(want);
    });
  }
});
