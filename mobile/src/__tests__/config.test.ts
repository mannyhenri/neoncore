import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Roster storage and the pre-federation migration.
 *
 * The migration case is the important one and it is a DATA-LOSS regression if it breaks:
 * before federation the phone stored one URL under a different key. Ship the new key
 * without migrating and every existing user is silently returned to the Connect screen on
 * update, as though the app had never been set up — with no error to explain it.
 */

const store = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

const {
  loadServers, saveServers, upsertServer, removeServer, setServerHidden,
  setFleetToken, activeServers, normalizeUrl, loadServerUrl,
} = await import('../config');

const LEGACY_KEY = 'neoncore.serverUrl';
const KEY = 'neoncore.servers.v1';

beforeEach(() => store.clear());

describe('migration from the single-server build', () => {
  it('carries a pre-federation server URL into the roster', async () => {
    store.set(LEGACY_KEY, 'http://desktop.local:4040');

    const servers = await loadServers();

    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe('http://desktop.local:4040');
    expect(servers[0].manual).toBe(true);
  });

  it('persists the migration so it runs exactly once', async () => {
    store.set(LEGACY_KEY, 'http://desktop.local:4040');
    await loadServers();
    expect(store.has(KEY)).toBe(true);

    // Second boot reads the new key; the legacy value is no longer consulted.
    store.set(LEGACY_KEY, 'http://SOMETHING-ELSE:9999');
    const again = await loadServers();
    expect(again[0].url).toBe('http://desktop.local:4040');
  });

  it('leaves the legacy key in place so a downgrade still finds its server', async () => {
    store.set(LEGACY_KEY, 'http://desktop.local:4040');
    await loadServers();
    expect(store.get(LEGACY_KEY)).toBe('http://desktop.local:4040');
  });

  it('normalizes a legacy value that was stored without a scheme', async () => {
    store.set(LEGACY_KEY, 'desktop.local:4040');
    const servers = await loadServers();
    expect(servers[0].url).toBe('http://desktop.local:4040');
  });

  it('a fresh install with nothing stored starts empty, not broken', async () => {
    expect(await loadServers()).toEqual([]);
  });

  it('corrupt roster storage falls back to the legacy value instead of throwing', async () => {
    store.set(KEY, '{not json');
    store.set(LEGACY_KEY, 'http://desktop.local:4040');
    const servers = await loadServers();
    expect(servers[0].url).toBe('http://desktop.local:4040');
  });

  it('loadServerUrl still answers for push registration and deep links', async () => {
    store.set(LEGACY_KEY, 'http://desktop.local:4040');
    expect(await loadServerUrl()).toBe('http://desktop.local:4040');
  });
});

describe('url normalization', () => {
  it('treats host casing and trailing slashes as the same server', () => {
    // Otherwise one machine enters the roster twice and every cartridge on it is listed
    // twice — with no error to hint at why.
    expect(normalizeUrl('http://Studio.LOCAL:4040/')).toBe('http://studio.local:4040');
    expect(normalizeUrl('studio.local:4040')).toBe('http://studio.local:4040');
  });

  it('returns empty for junk rather than storing it', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });
});

describe('roster operations', () => {
  it('adding the same server twice yields one entry', async () => {
    let servers = upsertServer([], { url: 'studio.local:4040', manual: true });
    servers = upsertServer(servers, { url: 'http://STUDIO.local:4040/', manual: true });
    expect(servers).toHaveLength(1);
  });

  it('a discovered peer inherits the fleet token already in use', () => {
    const servers = upsertServer(
      [{ url: 'http://a:4040', name: 'a', serverId: '', token: 'shared-secret', manual: true }],
      { url: 'http://b:4040', manual: false },
    );
    expect(servers[1].token).toBe('shared-secret');
  });

  it('an update never blanks metadata already known', () => {
    let servers = upsertServer([], { url: 'http://a:4040', name: 'alpha', serverId: 'sid-1' });
    servers = upsertServer(servers, { url: 'http://a:4040' });
    expect(servers[0].name).toBe('alpha');
    expect(servers[0].serverId).toBe('sid-1');
  });

  it('hiding keeps a server stored but out of the grid', () => {
    let servers = upsertServer([], { url: 'http://a:4040' });
    servers = setServerHidden(servers, 'http://a:4040', true);
    expect(servers).toHaveLength(1);
    expect(activeServers(servers)).toHaveLength(0);
  });

  it('one token applies to the whole fleet', () => {
    let servers = upsertServer([], { url: 'http://a:4040' });
    servers = upsertServer(servers, { url: 'http://b:4040' });
    servers = setFleetToken(servers, 'tok');
    expect(servers.every((s) => s.token === 'tok')).toBe(true);
  });

  it('removing normalizes, so the displayed URL is removable', () => {
    const servers = upsertServer([], { url: 'http://a:4040' });
    expect(removeServer(servers, 'http://A:4040/')).toHaveLength(0);
  });

  it('saved rosters round-trip and stay deduped', async () => {
    await saveServers([
      { url: 'http://a:4040', name: 'a', serverId: '', manual: true },
      { url: 'http://A:4040/', name: 'dupe', serverId: '', manual: true },
    ]);
    expect(await loadServers()).toHaveLength(1);
  });
});
