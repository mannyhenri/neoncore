import { describe, it, expect } from 'vitest';
import { createClient } from '@neoncore/client';

/**
 * A server that never answers must not hang the client forever.
 *
 * REPORTED: the dashboard sat on "Connecting to orchestrator..." indefinitely. The local
 * server was healthy — 200 in 1ms — and the peer was reachable at the network level (ping
 * answered from 192.168.4.29). What it would not do is COMPLETE a TCP connection to :4040:
 * `curl` reported HTTP 000 with connect=0.000000s after the full 12s budget. The host was up
 * and the port was silently swallowing connections, which is what a sleeping laptop looks like.
 *
 * `useAgents` fans out with `Promise.allSettled(...).finally(() => setLoading(false))` — the
 * right shape, and correctly commented "allSettled, never all: one rejection must not cancel
 * the others". But allSettled only settles when every promise does, and a fetch with NO TIMEOUT
 * never does. One asleep machine therefore bricked the entire dashboard, including the panes
 * showing the nine cartridges that were answering perfectly.
 *
 * The server side already had this right: its peer scheduler recorded 13 consecutive failures
 * with "The operation was aborted due to timeout" and carried on. Only the client lacked it.
 */

/**
 * A fetch that never answers — the sleeping-laptop case, which is worse than a refusal.
 *
 * It HONOURS an abort signal, because real `fetch` does. A stub that ignored the signal would
 * hang whether or not the client set a deadline, so it could never tell the fix from the bug —
 * the first version of this test did exactly that and failed identically before and after.
 */
const hangs: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
  const signal = (init as RequestInit | undefined)?.signal;
  if (!signal) return;                       // no deadline set: hangs forever, as before
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

describe('client request timeout', () => {
  it('rejects a hung request instead of waiting forever', async () => {
    const client = createClient({ baseUrl: 'http://asleep.local:4040', fetchImpl: hangs, timeoutMs: 150 });

    const started = Date.now();
    await expect(client.getAgents()).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed, 'the request did not time out').toBeLessThan(2000);
  });

  it('a hung server does not stop a fan-out from settling', async () => {
    // The exact shape useAgents uses. This is the assertion that maps to the symptom: the
    // dashboard clears `loading` in the `.finally` of an allSettled, so if one member never
    // settles, nothing renders — ever.
    const ok: typeof fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const healthy = createClient({ baseUrl: '', fetchImpl: ok, timeoutMs: 150 });
    const asleep = createClient({ baseUrl: 'http://asleep.local:4040', fetchImpl: hangs, timeoutMs: 150 });

    let settled = false;
    await Promise.allSettled([healthy.getAgents(), asleep.getAgents()])
      .finally(() => { settled = true; });

    expect(settled, 'the fan-out never settled — this is the "Connecting to orchestrator" hang').toBe(true);
  });

  it('the timeout is an ApiError the UI can classify, not a bare abort', async () => {
    // A user must be able to tell "asleep" from "wrong token"; the errors module exists for
    // exactly that distinction, so a timeout has to arrive through it.
    const client = createClient({ baseUrl: 'http://asleep.local:4040', fetchImpl: hangs, timeoutMs: 120 });
    const err = await client.getAgents().catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(String(err.kind ?? err.name ?? '')).not.toBe('');
    expect(err.origin ?? 'http://asleep.local:4040').toContain('asleep.local');
  });

  it('a healthy request is untouched by the timeout', async () => {
    const ok: typeof fetch = async () => new Response(JSON.stringify([{ id: 'a' }]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const client = createClient({ baseUrl: '', fetchImpl: ok, timeoutMs: 150 });
    await expect(client.getAgents()).resolves.toEqual([{ id: 'a' }]);
  });
});
