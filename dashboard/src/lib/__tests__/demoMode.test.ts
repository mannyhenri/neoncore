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

/**
 * DEMO RESPONSES MUST BE THE SHAPE THE APP EXPECTS.
 *
 * Demo mode shipped and showed a blank screen:
 *   Uncaught TypeError: Cannot read properties of undefined (reading 'serverId')
 *
 * `useAgents` reads `roster.self.serverId` from GET /peers, which returns an OBJECT. The demo
 * fetch answered every unknown GET with `[]` — a fine "nothing" for a collection and garbage
 * for an object, so `.self` was undefined and the app died on boot.
 *
 * The tests above all passed, because they exercised the TRANSPORT and never the app. Absorbing
 * a request safely is only half the job; the answer has to be usable.
 *
 * SO THE SHAPE IS DERIVED FROM THE CLIENT ITSELF. Every `request<…>('/path')` in client.ts
 * declares whether it returns an array or an object, and this reads that declaration and checks
 * the demo answer against it. An endpoint added to the client later is covered without anyone
 * remembering this file.
 */
describe('demo responses match the shapes the client declares', () => {
  const CLIENT = '../../../../packages/client/src/client.ts';

  /** Every GET the client declares, with whether its return type is an array. */
  async function declaredGets(): Promise<{ path: string; isArray: boolean }[]> {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve(__dirname, CLIENT), 'utf8');
    const out: { path: string; isArray: boolean }[] = [];
    // request<TYPE>('/path')  — with no `{ method: … }`, i.e. a GET.
    //
    // The WHOLE path template is captured, interpolations included, and each `${…}` becomes a
    // placeholder segment. Truncating at the first `$` gave `/goals/` for `/goals/${id}/tasks`
    // and then asserted a shape for a request the app never makes — the scan has to produce
    // the paths that are actually called or it tests fiction.
    for (const m of src.matchAll(/request<([\s\S]*?)>\(\s*(['`])((?:\\.|(?!\2)[\s\S])*)\2/g)) {
      const [, type, , rawPath] = m;
      const tail = src.slice(m.index ?? 0, (m.index ?? 0) + 400);
      if (/method:\s*'(POST|PUT|DELETE|PATCH)'/.test(tail)) continue;   // not a GET
      // A simple `${id}` is one path segment. Anything more elaborate — `${days ? `?d=${days}`
      // : ''}` — is a conditional QUERY suffix, and a query never changes which route answers,
      // so the path is cut there rather than mangled into a fake segment.
      const path = rawPath
        .replace(/\$\{\s*[A-Za-z_$][\w$]*\s*\}/g, 'demo-id')
        .split('${')[0]
        .split('?')[0];
      if (!path.startsWith('/')) continue;
      out.push({ path, isArray: /\[\]\s*$/.test(type.trim()) });
    }
    return out;
  }

  it('the scan finds the client surface — an empty list would pass vacuously', async () => {
    const gets = await declaredGets();
    expect(gets.length, 'no GET endpoints parsed out of client.ts').toBeGreaterThan(15);
  });

  it('EVERY declared GET returns the declared shape — array vs object', async () => {
    const demoFetch = createDemoFetch();
    const wrong: string[] = [];
    for (const { path, isArray } of await declaredGets()) {
      const res = await demoFetch(`/api${path}`);
      const body = await res.json();
      const gotArray = Array.isArray(body);
      if (isArray && !gotArray) wrong.push(`${path}: client expects an array, demo returned ${typeof body}`);
      // An object-shaped endpoint answered with [] is the serverId crash exactly.
      if (!isArray && gotArray) wrong.push(`${path}: client expects an object, demo returned an array`);
    }
    expect(wrong, `demo answers do not match the client's declared shapes:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('/peers carries the identity useAgents reads on boot', async () => {
    // The exact crash: roster.self.serverId, on the app's first render.
    const body = await (await createDemoFetch()('/api/peers')).json();
    expect(body.self, 'GET /peers has no `self` — this is the blank screen').toBeTruthy();
    expect(typeof body.self.serverId).toBe('string');
    expect(typeof body.self.name).toBe('string');
    expect(Array.isArray(body.peers)).toBe(true);
  });
});

/**
 * GETTING OUT WITHOUT THE APP.
 *
 * "I'm unable to restore it." Demo mode's only exits were the banner button and the Settings
 * checkbox, both inside the app — so when a bad demo response crashed the first render, every
 * exit went blank with it. A recovery control that lives inside the thing it recovers is not a
 * recovery control.
 */
describe('escaping demo mode without a working app', () => {
  it('main.tsx applies ?demo=off BEFORE the module that READS the flag is evaluated', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve(__dirname, '../../main.tsx'), 'utf8');

    expect(src, 'no URL override in main.tsx').toMatch(/applyDemoOverrideFromUrl\(\)/);
    expect(src, '?demo=off does not clear the flag').toMatch(/removeItem\(['"]neoncore\.demoMode/);
    expect(src, 'the query string is not cleaned up, so a refresh re-applies it').toMatch(/replaceState/);

    // THE ASSERTION THAT MATTERS, and the one the first version got wrong. It compared the
    // override's position against `createRoot` — which passed while the override was useless,
    // because ES module imports are HOISTED: `import App from './App'` pulled in lib/api and
    // read the demo flag before a single statement in this file ran. Position against a later
    // statement proves nothing; what matters is that App is NOT statically imported.
    expect(src, 'App is statically imported, so lib/api reads the demo flag before the '
      + 'override can run — ?demo=off would clear storage after the decision was made')
      .not.toMatch(/^import\s+App\s+from/m);
    // Dynamic, however it is spelled — `await import(…)` or `import(…).then(…)`. The build
    // target has no top-level await, so the .then form is the one that ships.
    expect(src, 'App must be imported dynamically, after the override')
      .toMatch(/import\(['"]\.\/App['"]\)/);
  });

  it('lib/api reads the flag at module load — which is WHY the ordering matters', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const api = readFileSync(resolve(__dirname, '../api.ts'), 'utf8');
    // If this ever stops being true the hoisting hazard goes away, and this test should be
    // revisited rather than left asserting a constraint that no longer exists.
    expect(api, 'lib/api no longer reads the flag at module load')
      .toMatch(/const DEMO = isDemoEnabled\(\)/);
  });

  it('the flag it clears is the one demo mode reads', () => {
    // Two different key strings would look correct in both files and fix nothing.
    setDemoEnabled(true);
    expect(localStorage.getItem('neoncore.demoMode')).toBe('1');
    localStorage.removeItem('neoncore.demoMode');   // what ?demo=off does
    expect(isDemoEnabled()).toBe(false);
  });
});
