import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A periodic refresh must never hide data that is already on screen.
 *
 * REPORTED: "the list of repos on launch button keeps showing then disappearing then showing".
 *
 * MachineLauncher polls every 20s and renders `loading ? <Loading…> : <the list>`, so for the
 * whole duration of each poll the list is REPLACED. Two things made that visible rather than
 * instantaneous:
 *
 *   1. `setLoading((prev) => (machines.length === 0 ? true : prev))` closes over `machines`
 *      from the render that created the effect, and the effect's deps are [open, baseKey] with
 *      exhaustive-deps disabled. So `machines.length` is ALWAYS the initial 0 and the guard
 *      that was supposed to limit the spinner to the first load fires on every poll.
 *   2. Each poll fans out to a peer that has been unreachable since yesterday
 *      (7,284 consecutive failures) and takes 4.84s to fail — measured, not assumed.
 *
 *   -> list visible ~15s, gone ~5s, forever.
 *
 * TokensPage in this same codebase already has the right idiom: `loading && !points.length`.
 * It keeps showing yesterday's chart while today's is fetched. This asserts that idiom across
 * every polling component, because the failure is invisible in development — one fast local
 * server makes the blank last milliseconds.
 */

const SRC = path.join(import.meta.dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Files that refresh on a timer. Discovered, not remembered. */
function pollingFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === '__tests__') continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.test\./.test(e.name)) continue;
      if (/setInterval\(/.test(read(rel))) out.push(rel);
    }
  };
  walk('components');
  walk('hooks');
  return out.sort();
}

describe('a refresh keeps what is already rendered', () => {
  it('finds the polling components (an empty scan would assert nothing)', () => {
    expect(pollingFiles().length, 'no polling components found — scanner broken')
      .toBeGreaterThanOrEqual(2);
  });

  it('no polling component hides loaded data behind a spinner', () => {
    const offenders: string[] = [];
    for (const rel of pollingFiles()) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // Only components that BOTH poll and gate their render on `loading` can do this.
      const gates = [...src.matchAll(/\{\s*loading\s*(&&|\?)/g)];
      if (gates.length === 0) continue;
      for (const g of gates) {
        // The gate must be conjoined with an emptiness check — "show the spinner ONLY when
        // there is nothing to show". `{loading ? …` on its own replaces live content.
        const around = src.slice(g.index!, g.index! + 90);
        const guarded = /loading\s*&&\s*!/.test(around) || /loading\s*&&\s*\w+\.length\s*===\s*0/.test(around);
        if (!guarded) offenders.push(`${rel}: ${around.split('\n')[0].trim()}`);
      }
    }
    expect(offenders, 'these blank already-rendered data on every poll:\n  ' + offenders.join('\n  '))
      .toEqual([]);
  });

  it('no polling effect reads state it does not depend on', () => {
    // The stale-closure half. An effect that disables exhaustive-deps and then READS a state
    // variable inside its interval callback is reading the value from when the effect was
    // created — which is what made the spinner fire on every poll instead of the first.
    const offenders: string[] = [];
    for (const rel of pollingFiles()) {
      const src = read(rel);
      if (!/eslint-disable-line react-hooks\/exhaustive-deps/.test(src)) continue;
      // The specific shape that bit us: a setState updater that reads another state array's
      // length to decide. Inside a stale effect that is always the initial value.
      if (/setLoading\(\([^)]*\)\s*=>\s*\(?\s*\w+\.length/.test(src)) {
        offenders.push(`${rel}: setLoading reads a captured state array's length`);
      }
    }
    expect(offenders, 'stale closure over state in a polling effect:\n  ' + offenders.join('\n  '))
      .toEqual([]);
  });
});

/**
 * The third half of the same bug, one layer in.
 *
 * `Promise.allSettled` stops one unreachable server from THROWING, and the comment in
 * MachineLauncher says exactly that. But the merge still yields `[]` when nothing answers, and
 * assigning that over a good list blanks the menu for a different reason — a network hiccup
 * rather than a spinner. The symptom is identical and the cause is not, so it needs its own
 * assertion or fixing one would look like fixing both.
 */
describe('a failed round keeps the last good answer', () => {
  it('MachineLauncher does not overwrite a populated list with an empty result', () => {
    const src = read('components/MachineLauncher.tsx');
    expect(
      /setMachines\(\(current\) =>\s*\(?\s*next\.length === 0 && current\.length > 0 \? current : next/.test(src),
      'a round where every server failed replaces the machines with [] — allSettled prevents ' +
      'the throw, not the blank',
    ).toBe(true);
  });
});
