import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * A screen must reach a DECIDED state — data or an error — never an endless spinner.
 *
 * The fleet is the reason this is not theoretical. The phone auto-adopts every peer the
 * server advertises, and a fleet reliably contains a machine that is asleep, off the
 * network, or has moved: this one has a peer sitting at 5064 consecutive failures whose
 * last error is "The operation was aborted due to timeout". A laptop answers that in
 * milliseconds with a refused connection. A phone on Wi-Fi, reaching a host that ACCEPTS
 * the connection and then never replies, waits for the OS TCP timeout — over a minute —
 * because `fetch` has no timeout of its own.
 *
 * Whichever server sorts first becomes `primary`, and every screen bound to a single
 * baseUrl (Queue, Workflows) hangs on it. Federated screens survive because they fan out
 * with Promise.allSettled — which is exactly why only SOME screens break, and why the
 * bug reads as "the app is flaky" rather than "one machine is down".
 */

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

const { api, requestConfig, ApiError } = await import('../api');
const { reachablePeers } = await import('../config');

describe('a request to a server that never answers', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { requestConfig.timeoutMs = 60; });
  afterEach(() => { globalThis.fetch = realFetch; requestConfig.timeoutMs = 12_000; });

  /** A host that accepts the connection and then goes silent — the case that hangs. */
  function silentServer() {
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_ok, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no timeout wired up: this promise never settles
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
  }

  it('gives up instead of hanging forever', async () => {
    silentServer();
    await expect(api.health('http://dead.local:4040')).rejects.toBeInstanceOf(ApiError);
  });

  it('reports it as unreachable, not as a token or server problem', async () => {
    silentServer();
    await api.health('http://dead.local:4040').then(
      () => { throw new Error('expected the request to fail'); },
      (err: InstanceType<typeof ApiError>) => {
        expect(err.kind).toBe('unreachable');
        expect(err.message).toMatch(/timed out/i);
      },
    );
  });

  it('still settles when the caller passes its own init', async () => {
    silentServer();
    await expect(
      api.sendCommand('http://dead.local:4040', 'agent-1', 'hello'),
    ).rejects.toMatchObject({ kind: 'unreachable' });
  });
});

/**
 * The same claim against a REAL socket, with nothing mocked.
 *
 * The mocked test above proves req() aborts a signal-aware fetch. It would still pass if
 * the signal were never honoured end-to-end — a fetch polyfill that accepts `signal` and
 * ignores it produces a green suite and a phone that hangs. This opens a listener that
 * accepts the connection and then says nothing, which is precisely the dead peer's
 * behaviour, and requires the request to come back on its own.
 */
describe('a real socket that accepts the connection and goes silent', () => {
  let server: net.Server;
  let port = 0;

  beforeAll(async () => {
    server = net.createServer(() => { /* accept, then never reply */ });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => { server.close(); });
  afterEach(() => { requestConfig.timeoutMs = 12_000; });

  it('comes back on its own instead of hanging', async () => {
    requestConfig.timeoutMs = 400;
    const started = Date.now();
    const err = await api.health(`http://127.0.0.1:${port}`).catch((e) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toMatch(/timed out/i);
    // Generous, because the assertion is "it returns at all", not "it returns in 400ms".
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('peers the server has already marked stale', () => {
  it('are not adopted as servers to talk to', () => {
    const peers = [
      { url: 'http://alive.local:4040', serverId: 'a', name: 'Alive', stale: false },
      { url: 'http://dead.local:4040', serverId: 'b', name: 'Dead', stale: true },
    ];
    expect(reachablePeers(peers).map((p) => p.url)).toEqual(['http://alive.local:4040']);
  });

  it('are kept when the server does not say either way', () => {
    // An older server sends no `stale` field at all. Dropping those would shrink the fleet
    // on the phone because of the server's age, not because anything is unreachable.
    const peers: { url: string; serverId: string; name: string; stale?: boolean }[] = [
      { url: 'http://unknown.local:4040', serverId: 'c', name: 'Unknown' },
    ];
    expect(reachablePeers(peers)).toHaveLength(1);
  });
});

describe('every surface that shows a spinner', () => {
  // Components too, not just screens: RemoteLaunchModal owns loading state exactly like a
  // screen does, and a guard that stops at the screens/ directory would have called this
  // set complete while leaving a whole directory of the same pattern unchecked.
  const dirs = ['screens', 'components'].map((d) => path.join(import.meta.dirname, '..', d));
  const screens = dirs.flatMap((dir) =>
    fs.readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => path.join(dir, f)),
  );

  it('finds the files to check, across both directories', () => {
    expect(screens.length).toBeGreaterThan(15);
    expect(screens.some((f) => f.endsWith('RemoteLaunchModal.tsx'))).toBe(true);
    expect(screens.some((f) => f.endsWith('QueueScreen.tsx'))).toBe(true);
  });

  /**
   * An early `return` placed ABOVE the try/finally skips setLoading(false), so the screen
   * renders <ActivityIndicator/> forever. Inside the try it is harmless, so this looks at
   * the load callback only — a bare guard in an action handler like cancel() is fine.
   */
  it('clears its loading flag on the no-server path too', () => {
    const offenders: string[] = [];

    for (const file of screens) {
      const src = fs.readFileSync(file, 'utf8');
      const start = src.indexOf('const load = useCallback');
      if (start === -1) continue;
      const body = src.slice(start, src.indexOf('}, [', start));
      if (!body.includes('setLoading(false)')) continue;

      for (const m of body.matchAll(/if\s*\([^)]*\)\s*return\s*;/g)) {
        if (!body.slice(0, m.index).includes('try {')) {
          const line = src.slice(0, start + (m.index ?? 0)).split('\n').length;
          offenders.push(`${path.basename(file)}:${line} returns before the finally that clears loading`);
        }
      }
    }

    expect(offenders, `\n${offenders.join('\n')}\n`).toEqual([]);
  });
});
