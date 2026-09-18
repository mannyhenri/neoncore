/**
 * MOUNT THE REAL APP IN DEMO MODE.
 *
 * Demo mode shipped and showed a blank screen — `Cannot read properties of undefined (reading
 * 'serverId')` — while every test I had written passed. They exercised the transport (nothing
 * escapes to the network) and the response shapes (arrays are arrays), and NONE of them
 * rendered a single component. Both of those checks were right and neither could see a
 * component reading a field off an object that came back the wrong shape.
 *
 * This is the one that would have caught it: the real App, the real api module, the real demo
 * transport, mounted. No mock of lib/api — mocking the thing under test is how the first three
 * test files all passed against a broken build.
 *
 * TWO THINGS MAKE IT WORK:
 *  · localStorage is set BEFORE the dynamic import. `IS_DEMO` is read once at module load in
 *    lib/api.ts, so a static import would capture demo-mode-off and test nothing.
 *  · React logs render errors through console.error rather than throwing them at the test, so
 *    console.error is captured and asserted on. Without that a component can die inside an
 *    error boundary and the test still "passes" against a blank screen — which is precisely
 *    the failure being prevented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

/** jsdom has neither, and React components that measure or query media need both. */
function installJsdomGaps() {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
  }
  if (!globalThis.scrollTo) globalThis.scrollTo = (() => {}) as typeof globalThis.scrollTo;
}

describe('App mounts in demo mode', () => {
  let errors: string[] = [];
  let networkHits: string[] = [];
  let realFetch: typeof fetch;

  beforeEach(() => {
    installJsdomGaps();
    errors = [];
    networkHits = [];
    vi.resetModules();                 // force lib/api to re-read IS_DEMO
    localStorage.setItem('neoncore.demoMode', '1');

    /**
     * A tripwire in place of the real network. Demo mode must never reach it — and if it does,
     * the test says which URL rather than hanging on a request jsdom cannot make.
     *
     * IT RECORDS AND FAILS THE RESPONSE; IT DOES NOT THROW. Throwing here produced a 1-in-5
     * flake in the FULL suite that never reproduced in isolation: the last test deliberately
     * runs with demo mode off, so the app really does fetch, and a request still in flight when
     * `cleanup()` unmounts its component has nobody left to catch the rejection. Vitest counts
     * that as an unhandled error and fails the whole FILE, attributing it to whichever test
     * happened to be running — which is why the name in the failure kept moving.
     *
     * A resolved not-ok response is also the more faithful stand-in: a real unreachable server
     * is an error the client handles, not an exception thrown out of `fetch` itself. The
     * assertions are on `networkHits`, so nothing is lost by not throwing.
     */
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      networkHits.push(String(url));
      return {
        ok: false, status: 503, statusText: 'demo tripwire: the network is not available in this test',
        headers: new Headers(), redirected: false, type: 'basic' as ResponseType, url: String(url),
        json: async () => ({}), text: async () => '', clone() { return this; },
      } as unknown as Response;
    }) as typeof fetch;

    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders without the crash that produced a blank screen', async () => {
    const { default: App } = await import('../App');
    render(<App />);

    // Everything the app boots with is async, so let the effects settle before judging.
    await waitFor(() => {
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
    }, { timeout: 4000 });

    const fatal = errors.filter((e) =>
      /Cannot read propert|is not a function|is not iterable|undefined is not|Minified React error/i.test(e));
    expect(fatal, `the app threw while rendering in demo mode:\n  ${fatal.join('\n  ')}`).toEqual([]);
  });

  it('shows the demo banner, so nobody mistakes it for live', async () => {
    const { default: App } = await import('../App');
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Demo mode/i)).toBeTruthy();
    }, { timeout: 4000 });
  });

  it('renders DEMO data, not an empty shell', async () => {
    // A blank screen and a screen that rendered nothing-yet look identical to a crash test.
    // This asserts the fake fleet actually reached the DOM.
    const { default: App } = await import('../App');
    render(<App />);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/atlas-api|ledger-svc|pulse-mobile/);
    }, { timeout: 4000 });
  });

  it('reaches the network ZERO times while rendering', async () => {
    const { default: App } = await import('../App');
    render(<App />);
    await waitFor(() => {
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
    }, { timeout: 4000 });
    // Belt and braces at the render level: the unit tests prove the transport absorbs
    // requests, this proves the assembled app never opens one.
    expect(networkHits, `demo mode hit the network:\n  ${networkHits.join('\n  ')}`).toEqual([]);
  });

  it('with demo mode OFF the app does NOT silently show fake data', async () => {
    // The inverse property, and the one that matters after a demo ends: turning it off must
    // actually turn it off. With the real fetch tripwired, a live app tries to reach the
    // server — which is the correct behaviour here, not a failure.
    localStorage.removeItem('neoncore.demoMode');
    vi.resetModules();
    const { default: App } = await import('../App');
    render(<App />);
    await waitFor(() => {
      expect(networkHits.length).toBeGreaterThan(0);
    }, { timeout: 4000 });
    expect(document.body.textContent).not.toMatch(/atlas-api|ledger-svc/);
  });
});
