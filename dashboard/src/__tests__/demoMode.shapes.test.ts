import { describe, it, expect } from 'vitest';
import { createDemoFetch } from '../lib/demoMode';

/**
 * THE DEMO'S OBJECT SHAPES MUST MATCH WHAT THE COMPONENTS READ.
 *
 * Demo mode has now produced a blank screen twice, both times the same way: a faked response
 * was the right TYPE but missing a field a component reads without guarding.
 *
 *   first  — /peers had no `self`, and the header read `self.serverId`
 *   second — /workflows/v2/:id/autonomy had no `resolutions`, and AutonomyControl reads
 *            `state.resolutions.length` three times (lines 95, 99, 100). The real route
 *            returns `{ ...effectiveAutonomy(id), resolutions: [...] }`; the fake returned
 *            only level/source/expiresAt. One undefined `.length` unmounts the whole app,
 *            and the screen goes white with no way back except the ?demo=off escape hatch.
 *
 * The existing App.demoMode smoke test did not catch either, because it renders the landing
 * view and AutonomyControl only appears on a run. So this tests the TRANSPORT directly: every
 * object-shaped route, checked for the fields its consumer dereferences. That is cheap, it
 * needs no rendering, and it fails on the exact thing that whites out the screen.
 */
const REQUIRED: { route: string; fields: [string, 'array' | 'object' | 'scalar'][] }[] = [
  // AutonomyControl.tsx:36 declares resolutions as a required array and reads .length.
  ['workflows/v2/demo-run-1/autonomy', [['level', 'scalar'], ['source', 'scalar'], ['resolutions', 'array']]],
  // The header reads self.serverId — the first blank screen.
  ['peers', [['self', 'object'], ['peers', 'array']]],
  ['queue', [['items', 'array'], ['lanes', 'array']]],
  ['repos/browse', [['entries', 'array']]],
  ['activity/burn-rate', [['samples', 'array']]],
  ['activity/usage-series', [['series', 'array'], ['byCartridge', 'array']]],
  ['epics/scan', [['epics', 'array'], ['tasks', 'array']]],
  ['journal/search', [['sessions', 'array'], ['knowledge', 'array']]],
].map(([route, fields]) => ({ route: route as string, fields: fields as [string, 'array' | 'object' | 'scalar'][] }));

describe('every object-shaped demo response carries the fields its consumer reads', () => {
  const demoFetch = createDemoFetch(globalThis.fetch);

  for (const { route, fields } of REQUIRED) {
    it(`/${route}`, async () => {
      const res = await demoFetch(`http://x/api/${route}`, { method: 'GET' } as RequestInit);
      const body = await (res as Response).json();
      expect(body, `/${route} returned nothing`).toBeTruthy();
      for (const [key, kind] of fields) {
        expect(body[key], `/${route} is missing "${key}" — a component dereferences it`).toBeDefined();
        if (kind === 'array') {
          expect(Array.isArray(body[key]), `/${route}.${key} must be an array; a .length on undefined blanks the app`).toBe(true);
        }
        if (kind === 'object') expect(typeof body[key]).toBe('object');
      }
    });
  }

  it('an unknown route still returns something JSON-parseable, never undefined', async () => {
    // The default is `[]`. A bare undefined would crash any caller that maps over it.
    const res = await demoFetch('http://x/api/some-route-nobody-faked', { method: 'GET' } as RequestInit);
    const body = await (res as Response).json();
    expect(body).toBeDefined();
  });
});
