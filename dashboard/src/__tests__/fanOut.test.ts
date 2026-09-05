import { describe, it, expect } from 'vitest';
import { fanOut } from '../lib/fanOut';
import type { ServerEntry } from '@neoncore/client';

/**
 * A page must not wait for the slowest machine in the fleet.
 *
 * This is the second half of the "Connecting to orchestrator" bug. Adding a request deadline
 * stopped the dashboard hanging forever, but every fan-out still awaited ALL servers, so a
 * sleeping laptop turned a 2ms read into a 15-second one — reported as "each page load has a
 * delay". Rendering is gated on the first answer now, not the last.
 *
 * The assertions are about ORDERING, not elapsed time: a timing test on a fast machine passes
 * whether or not the fix is present.
 */

/**
 * Let every settled promise's continuations run.
 *
 * Counting microtask hops by hand is how the last case in this file failed: `.then().catch()
 * .finally()` is three of them, and the test awaited two. A macrotask drains all pending
 * microtasks and does not need updating when the chain changes shape.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

const srv = (url: string, name: string): ServerEntry =>
  ({ url, name, serverId: '', token: null, manual: true }) as ServerEntry;

describe('fanOut', () => {
  it('reports the fast server BEFORE the slow one settles', async () => {
    let releaseSlow: (v: string) => void = () => {};
    const slow = new Promise<string>((r) => { releaseSlow = r; });

    const updates: { settled: number; results: (string | null)[] }[] = [];

    fanOut<string>(
      [srv('', 'This machine'), srv('http://asleep.local:4040', 'Asleep')],
      (s) => (s.url ? slow : Promise.resolve('local-data')),
      (answers, settled) => updates.push({ settled, results: answers.map((a) => a.result) }),
    );

    // Drain the fast server's continuations without releasing the slow one.
    await flush();

    expect(updates.length, 'nothing was reported until every server answered').toBeGreaterThan(0);
    expect(updates[0].settled).toBe(1);
    expect(updates[0].results[0]).toBe('local-data');
    expect(updates[0].results[1]).toBe(null);

    releaseSlow('remote-data');
    await flush();

    const last = updates[updates.length - 1];
    expect(last.settled).toBe(2);
    expect(last.results).toEqual(['local-data', 'remote-data']);
  });

  it('a rejecting server yields null and never throws to the caller', async () => {
    const updates: (string | null)[][] = [];
    fanOut<string>(
      [srv('', 'This machine'), srv('http://down.local:4040', 'Down')],
      (s) => (s.url ? Promise.reject(new Error('refused')) : Promise.resolve('ok')),
      (answers) => updates.push(answers.map((a) => a.result)),
    );
    await flush();

    expect(updates[updates.length - 1]).toEqual(['ok', null]);
  });

  it('hands out a NEW array each time, or React state never updates', async () => {
    // Mutating and re-emitting one array is the classic version of this: every value is
    // correct and the screen never changes, because the reference did not.
    const seen: unknown[] = [];
    fanOut<string>(
      [srv('', 'a'), srv('http://b', 'b')],
      () => Promise.resolve('x'),
      (answers) => seen.push(answers),
    );
    await flush();

    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('an empty fleet reports once rather than never', async () => {
    const seen: number[] = [];
    fanOut<string>([], () => Promise.resolve('x'), (_a, settled) => seen.push(settled));
    expect(seen).toEqual([0]);
  });

  it('labels a server for a person, falling back to its host', async () => {
    const labels: string[][] = [];
    fanOut<string>(
      [srv('', ''), srv('http://studio.local:4040', '')],
      () => Promise.resolve('x'),
      (answers) => labels.push(answers.map((a) => a.label)),
    );
    await flush();
    expect(labels[0]).toEqual(['This machine', 'studio.local']);
  });
});
