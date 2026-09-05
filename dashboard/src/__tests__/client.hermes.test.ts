import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@neoncore/client';

/**
 * The request deadline must work on Hermes, not only on Node and the browser.
 *
 * mobile/src/api.ts documents the trap, having already been bitten by it:
 *
 *   "Built from AbortController rather than AbortSignal.timeout/any: those are Node and
 *    browser statics, and this runs on Hermes, whose AbortController comes from a polyfill
 *    that has the constructor but not the statics. Reaching for them here would throw a
 *    TypeError on device while every test on Node passed."
 *
 * packages/client's deadline uses AbortSignal.timeout, guarded by `'timeout' in AbortSignal`.
 * The guard prevents the TypeError — and replaces it with something quieter: on Hermes the
 * function returns undefined, so there is NO deadline at all. That is the precise failure the
 * deadline was added to fix (a sleeping machine hanging the app forever), reintroduced on the
 * one runtime where nobody would see it, because every test here runs on Node where the static
 * exists.
 *
 * So this simulates the Hermes SHAPE — AbortSignal present, AbortSignal.timeout absent — which
 * is the only condition under which the current implementation is silently wrong.
 */

const realTimeout = (AbortSignal as unknown as { timeout?: unknown }).timeout;

afterEach(() => {
  if (realTimeout) (AbortSignal as unknown as { timeout: unknown }).timeout = realTimeout;
});

/** Hermes: the constructor exists, the statics do not. */
function makeHermesShaped(): void {
  delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
}

/** A fetch that never answers unless aborted — the sleeping-laptop case. */
const hangs: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
  const signal = (init as RequestInit | undefined)?.signal;
  if (!signal) return;                       // no deadline was set: hangs forever
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

describe('request deadline under a Hermes-shaped runtime', () => {
  it('AbortController exists there even when the statics do not — the premise', () => {
    makeHermesShaped();
    expect(typeof AbortController).toBe('function');
    expect('timeout' in AbortSignal).toBe(false);
  });

  it('a hung request still rejects when AbortSignal.timeout is absent', async () => {
    makeHermesShaped();
    const client = createClient({ baseUrl: 'http://asleep.local:4040', fetchImpl: hangs, timeoutMs: 150 });

    const started = Date.now();
    await expect(client.getAgents()).rejects.toThrow();
    expect(Date.now() - started, 'the request did not time out on a Hermes-shaped runtime').toBeLessThan(2000);
  });

  it('a fan-out still settles when one server is asleep', async () => {
    // The shape useAgents and fanOut both use. If a member never settles, nothing renders —
    // which on iOS would be a permanently blank app rather than a slow one.
    makeHermesShaped();
    const ok: typeof fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const healthy = createClient({ baseUrl: '', fetchImpl: ok, timeoutMs: 150 });
    const asleep = createClient({ baseUrl: 'http://asleep.local:4040', fetchImpl: hangs, timeoutMs: 150 });

    let settled = false;
    await Promise.allSettled([healthy.getAgents(), asleep.getAgents()]).finally(() => { settled = true; });
    expect(settled).toBe(true);
  });

  it('the healthy path is unaffected on that runtime', async () => {
    makeHermesShaped();
    const ok: typeof fetch = async () => new Response(JSON.stringify([{ id: 'a' }]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    await expect(createClient({ baseUrl: '', fetchImpl: ok, timeoutMs: 150 }).getAgents())
      .resolves.toEqual([{ id: 'a' }]);
  });

  it('the timeout timer is CLEARED when a request succeeds', async () => {
    /*
     * Case 1.5. Without this every request leaves a pending timer behind. On Node the process
     * simply holds it; on Hermes, React Native will not tear a screen down cleanly while timers
     * are outstanding, and the leak is invisible because Node never complains. mobile/src/api.ts
     * clears it in a `finally` — the shared client must too.
     */
    makeHermesShaped();
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const ok: typeof fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });

    await createClient({ baseUrl: '', fetchImpl: ok, timeoutMs: 5000 }).getAgents();

    expect(cleared, 'a successful request left its timeout timer pending').toHaveBeenCalled();
    cleared.mockRestore();
  });

  it("a caller's own signal is ADDED to the deadline, not substituted for it", async () => {
    /*
     * Case 1.6 — asserted STRUCTURALLY, and the reason is worth recording.
     *
     * The defect is real: `signal: options?.signal ?? deadline()` means passing your own signal
     * silently disables the timeout, so a caller that wants to be able to cancel gives up its
     * protection against a server that never answers. mobile/src/api.ts adds the timeout TO the
     * caller's signal rather than replacing it.
     *
     * But it CANNOT be reached behaviourally today: every public method is `() => request(path)`
     * and forwards no RequestInit, so a signal handed to one is simply ignored. The first version
     * of this case passed an options object through a cast and asserted a timing bound — and it
     * passed with the defect reinstated, because the signal never reached request() at all. A
     * vacuous test is worse than none: it reports the property as protected while protecting
     * nothing.
     *
     * So this reads the source. Weaker than a behavioural assertion, and honest about being the
     * strongest available until a method forwards options — at which point this should become a
     * real request test.
     */
    // Comments stripped first. The implementation's own header QUOTES the defective pattern in
    // order to explain it, so a scanner that reads prose flags the documentation as the defect —
    // which is exactly what happened on the first run of this assertion.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/client/src/client.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    expect(src, 'the deadline is substituted by a caller signal rather than added to it')
      .not.toMatch(/signal:\s*options\?\.signal\s*\?\?/);
    expect(src, 'request() no longer passes the deadline signal').toMatch(/signal:\s*gate\.signal/);
    expect(src, "the caller's signal is not forwarded into the deadline").toMatch(/deadline\(options\?\.signal\)/);
  });
});
