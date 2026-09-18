/**
 * DEMO MODE MUST NOT TOUCH THE REAL SYSTEM.
 *
 * "It loads fake data and not the live information (everything would still run in the back as
 * if nothing happened) so I can demo the app and interact with it."
 *
 * The second half is the hard part. Reading fake data is easy; INTERACTING is where a demo
 * mode becomes dangerous — pressing Run Workflow during a demo must not launch a real run on a
 * real cartridge, and pressing Delete must not delete anything.
 *
 * SO THE INVARIANT IS DENY-BY-DEFAULT, not a list of faked endpoints. The demo client is built
 * with a `fetchImpl` that never calls the real `fetch`, so an endpoint nobody thought to fake
 * cannot leak: it returns something inert instead of reaching the server. A demo mode built as
 * an allowlist is one forgotten route away from deleting production data during a demo.
 *
 * That is what these tests check first and hardest: for EVERY method and EVERY shape of path,
 * including invented ones, nothing reaches the network.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDemoFetch, demoDataset, isDemoEnabled, setDemoEnabled } from '../demoMode';

/** A fetch that fails loudly if anything reaches it — standing in for the real network. */
function forbiddenFetch(): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    throw new Error(`REAL NETWORK REACHED: ${String(url)}`);
  }) as unknown as typeof fetch;
}

describe('demo mode', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('is OFF unless it was explicitly turned on', () => {
    expect(isDemoEnabled()).toBe(false);
  });

  it('survives a reload, and can be turned back off', () => {
    setDemoEnabled(true);
    expect(isDemoEnabled()).toBe(true);
    setDemoEnabled(false);
    expect(isDemoEnabled()).toBe(false);
  });

  it('a storage failure leaves demo mode OFF, never stuck on', () => {
    // Private windows and blocked site data throw on access. Failing closed matters: a demo
    // flag that cannot be cleared would show fake data to someone who thinks it is live.
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked'); },
    });
    try {
      expect(() => isDemoEnabled()).not.toThrow();
      expect(isDemoEnabled()).toBe(false);
      expect(() => setDemoEnabled(true)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
    }
  });

  // ── the safety property ──────────────────────────────────────────────────────────────

  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

  it('EVERY HTTP method is absorbed — nothing reaches the network', async () => {
    const demoFetch = createDemoFetch(forbiddenFetch());
    const leaked: string[] = [];
    for (const method of METHODS) {
      try {
        await demoFetch('/api/agents', { method });
      } catch (err) {
        leaked.push(`${method}: ${(err as Error).message}`);
      }
    }
    expect(leaked, `a request escaped demo mode:\n  ${leaked.join('\n  ')}`).toEqual([]);
  });

  it('an endpoint the fake has NEVER heard of is still absorbed', async () => {
    // The whole point of deny-by-default. An allowlist would pass every test above and still
    // send this one to the real server.
    const demoFetch = createDemoFetch(forbiddenFetch());
    for (const path of [
      '/api/some/route/invented/later',
      '/api/workflows/v2/abc/start',
      '/api/agents/xyz/focus',
      '/api/heartbeats',
      '/api/tasks/123',
    ]) {
      await expect(demoFetch(path, { method: 'DELETE' }), `${path} escaped`).resolves.toBeDefined();
    }
  });

  it('a destructive call returns success WITHOUT doing anything', async () => {
    const demoFetch = createDemoFetch(forbiddenFetch());
    const res = await demoFetch('/api/workflows/some-real-looking-id', { method: 'DELETE' });
    expect(res.ok, 'the UI would show an error mid-demo').toBe(true);
  });

  it('a launch during a demo does not start a run', async () => {
    const demoFetch = createDemoFetch(forbiddenFetch());
    const res = await demoFetch('/api/workflows/v2/tpl-1/start', {
      method: 'POST', body: JSON.stringify({ agentId: 'cart-1' }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    // It must look like a run so the UI advances, and be entirely local.
    expect(body).toBeTruthy();
  });

  // ── the data itself ──────────────────────────────────────────────────────────────────

  it('returns fake data that is obviously NOT the live fleet', async () => {
    const demoFetch = createDemoFetch(forbiddenFetch());
    const agents = await (await demoFetch('/api/agents')).json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(2);
    // Demo cartridges must not be mistaken for real ones during or after a demo.
    for (const a of agents) {
      expect(a.repoPath ?? '', `demo cartridge points at a real-looking path: ${a.repoPath}`)
        .not.toMatch(/^\/Users\/[^/]+\/code\//);
    }
  });

  it('the dataset covers what the main screens read', () => {
    // A demo that shows three empty screens is not a demo. Enumerated so a screen added later
    // fails here rather than appearing blank in front of an audience.
    for (const key of ['agents', 'workflows', 'tasks', 'projects', 'goals', 'activity'] as const) {
      const rows = demoDataset()[key];
      expect(Array.isArray(rows), `${key} missing from the demo dataset`).toBe(true);
      expect(rows.length, `${key} is empty — that screen would demo as blank`).toBeGreaterThan(0);
    }
  });

  it('interactions persist within the demo, so it behaves like an app', async () => {
    // Clicking things must appear to work — otherwise it is a screenshot, not a demo.
    const demoFetch = createDemoFetch(forbiddenFetch());
    const before = await (await demoFetch('/api/tasks')).json();
    await demoFetch('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Demo task' }) });
    const after = await (await demoFetch('/api/tasks')).json();
    expect(after.length, 'a created item vanished — the demo would look broken')
      .toBe(before.length + 1);
  });

  it('the settings toggle exists and the app builds its client through the demo seam', () => {
    return import('fs').then(({ readFileSync }) => import('path').then(({ resolve }) => {
      const settings = readFileSync(resolve(__dirname, '../../components/SettingsModal.tsx'), 'utf8');
      expect(settings, 'no demo toggle in Settings').toMatch(/setDemoEnabled|Demo mode/i);
      const apiFile = readFileSync(resolve(__dirname, '../api.ts'), 'utf8');
      expect(apiFile, 'the app client does not go through the demo seam')
        .toMatch(/createDemoFetch|isDemoEnabled/);
    }));
  });
});
