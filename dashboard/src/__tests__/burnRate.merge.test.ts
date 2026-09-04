import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  mergeBurnRates, SUMMED_KEYS, WINDOW_KEYS,
  type ServerBurnRate,
} from '../lib/burnRate';
import type { ServerAnswer } from '../lib/serverAnswer';

/** A labelled answer, the shape the merge now takes. */
const from = (label: string, result: ServerBurnRate | null): ServerAnswer<ServerBurnRate> =>
  ({ label, result });

/**
 * The header says "the fleet". It has to MEAN the fleet.
 *
 * Every NeonCore server owns its own database, so a burn rate read from one server describes
 * one machine. The first version of this readout did exactly that — `api.getBurnRate()`,
 * same-origin — and would have printed a confident fleet-wide number for whichever machine
 * happened to serve the page, with the other computer's cartridges missing and nothing on
 * screen to say so.
 *
 * SET-BASED OVER THE RESPONSE SHAPE, not over an example pair of servers. The failure mode
 * that survives an example test is a FORGOTTEN FIELD: someone adds `cacheHitRate` to the
 * endpoint, the merge does not know about it, and it silently reports whatever the first
 * server said. So the set is "every numeric key the endpoint returns", derived from the
 * server route + lib rather than retyped here, and each one must be classified as either
 * summed or window-carried.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** THE SET: every numeric field the burn-rate endpoint actually returns. */
function responseFieldsFromServerSource(): string[] {
  const lib = readFileSync(resolve(HERE, '../../../server/src/lib/burn-rate.ts'), 'utf8');
  const route = readFileSync(resolve(HERE, '../../../server/src/routes/activity.ts'), 'utf8');

  // Fields off the BurnRate interface...
  const ifaceStart = lib.indexOf('export interface BurnRate {');
  expect(ifaceStart, 'server lib no longer exports interface BurnRate').toBeGreaterThan(-1);
  const iface = lib.slice(ifaceStart, lib.indexOf('}', ifaceStart));
  const fields = new Set([...iface.matchAll(/^\s*(\w+):\s*number;/gm)].map((m) => m[1]));

  // ...plus whatever the route spreads in alongside it.
  const resAt = route.indexOf('res.json({ ...computeBurnRate(');
  expect(resAt, 'burn-rate route no longer spreads computeBurnRate').toBeGreaterThan(-1);
  const call = route.slice(resAt, route.indexOf('});', resAt));
  for (const m of call.matchAll(/,\s*(\w+)(?:[,:}])/g)) fields.add(m[1]);
  fields.delete('since'); // a timestamp string, not a quantity

  expect(fields.size).toBeGreaterThanOrEqual(9);
  return [...fields];
}

const RESPONSE_FIELDS = responseFieldsFromServerSource();

function sample(overrides: Partial<ServerBurnRate> = {}): ServerBurnRate {
  return {
    windowHours: 168, days: 7,
    tokens: 1000, tokensPerHour: 10, tokensPerDay: 240,
    costUsd: 50, costPerDay: 7, samples: 100, activeCartridges: 3,
    ...overrides,
  };
}

describe('federated burn rate', () => {
  it('classifies every numeric field the endpoint returns', () => {
    // The guard against a forgotten field: an unclassified key is one that would be
    // dropped or double-counted the moment a second server appears.
    const classified = new Set<string>([...SUMMED_KEYS, ...WINDOW_KEYS]);
    const unclassified = RESPONSE_FIELDS.filter((f) => !classified.has(f));

    expect(unclassified, `unclassified burn-rate fields: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('adds every extensive quantity across servers', () => {
    const a = sample();
    const b = sample({ tokens: 500, tokensPerHour: 5, tokensPerDay: 120, costUsd: 25, costPerDay: 3.5, samples: 40, activeCartridges: 2 });
    const merged = mergeBurnRates([from('alpha', a), from('beta', b)], 7) as unknown as Record<string, number>;

    for (const k of SUMMED_KEYS) {
      const want = (a as unknown as Record<string, number>)[k] + (b as unknown as Record<string, number>)[k];
      expect(merged[k], `${k} did not add across servers`).toBe(want);
    }
  });

  it('carries the window through instead of adding it', () => {
    const merged = mergeBurnRates([from('alpha', sample()), from('beta', sample())], 7);
    for (const k of WINDOW_KEYS) {
      expect(merged[k], `${k} was summed — two servers asked for 7 days is still 7 days`).toBe(sample()[k]);
    }
  });

  it('a server that fails contributes nothing but is still counted as asked', () => {
    const merged = mergeBurnRates([from('alpha', sample()), from('beta', null)], 7);
    expect(merged.tokensPerDay).toBe(240);
    expect(merged.serversReporting).toBe(1);
    expect(merged.serversAsked).toBe(2);
  });

  it('a server running older code answers [] — that is a non-report, not a zero', () => {
    // The live shape today: before this endpoint existed, `/activity/burn-rate` fell through
    // to `/activity/:agentId` and returned an empty array. It is truthy, it is not an error,
    // and every field on it is undefined — so a merge that only checked for null would add
    // NaN into the fleet total and print "NaN tok/day" in the header.
    const merged = mergeBurnRates([from('alpha', sample()), from('studio.local', [] as unknown as ServerBurnRate)], 7);
    expect(merged.tokensPerDay).toBe(240);
    expect(Number.isFinite(merged.tokens)).toBe(true);
    expect(merged.serversReporting).toBe(1);
    expect(merged.serversAsked).toBe(2);
  });

  it('is finite when every server fails', () => {
    const merged = mergeBurnRates([from('alpha', null), from('beta', null)], 7) as unknown as Record<string, number>;
    for (const k of SUMMED_KEYS) expect(Number.isFinite(merged[k]), `${k} was ${merged[k]}`).toBe(true);
    expect(merged.days).toBe(7);
  });
});

/**
 * WHY a server is missing, not just THAT one is.
 *
 * REPORTED: "both servers are reachable why am I still seeing the warning". They were right —
 * both answered HTTP 200. The second was on an older build where `/activity/:agentId` swallows
 * the new route and returns `[]`, so it responded successfully with the wrong thing. The banner
 * led with "a server is unreachable" while the header showed 2/2 green, and the two disagreed.
 *
 * SET-BASED over the failure KINDS rather than the one that was reported, because the two have
 * opposite remedies — one machine needs looking at, the other needs a deploy — and a message
 * that cannot tell them apart sends you to the wrong one.
 */
describe('why a server is missing from the total', () => {
  const KINDS: { label: string; answer: ServerBurnRate | null; reason: string | null }[] = [
    { label: 'a healthy server', answer: sample(), reason: null },
    { label: 'a server that did not respond', answer: null, reason: 'unreachable' },
    // Each of these is what an older build actually returns: truthy, HTTP 200, wrong shape.
    { label: 'an old build returning []', answer: [] as unknown as ServerBurnRate, reason: 'outdated' },
    { label: 'an old build returning {}', answer: {} as unknown as ServerBurnRate, reason: 'outdated' },
  ];

  it('classifies every kind of answer, and names the server', () => {
    const failures: string[] = [];

    for (const k of KINDS) {
      const merged = mergeBurnRates([from('studio.local', k.answer)], 7);
      const got = merged.problems[0]?.reason ?? null;
      if (got !== k.reason) failures.push(`${k.label}: classified as ${got}, expected ${k.reason}`);
      if (k.reason && merged.problems[0]?.label !== 'studio.local') {
        failures.push(`${k.label}: problem is not attributed to the server that caused it`);
      }
    }

    expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
  });

  it('a healthy fleet reports no problems at all', () => {
    const merged = mergeBurnRates([from('a', sample()), from('b', sample())], 7);
    expect(merged.problems).toEqual([]);
    expect(merged.serversReporting).toBe(2);
  });

  it('an outdated server still counts as asked, so the total is known to be partial', () => {
    const merged = mergeBurnRates(
      [from('this', sample()), from('studio.local', [] as unknown as ServerBurnRate)], 7,
    );
    expect(merged.serversReporting).toBe(1);
    expect(merged.serversAsked).toBe(2);
    expect(merged.problems).toEqual([{ label: 'studio.local', reason: 'outdated' }]);
  });
});
