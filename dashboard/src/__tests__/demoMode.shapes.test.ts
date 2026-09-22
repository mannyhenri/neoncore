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

/**
 * A DEMO WITH AN EMPTY WORKFLOW LIBRARY DEMONSTRATES NOTHING.
 *
 * `/api/workflows` returns templates AND runs in one list — a template is the row whose
 * `templateId` is null. The demo shipped only runs, so the workflow picker came up empty:
 * the single screen a demo most needs to show was the one screen with nothing on it.
 * Asked for as "copy all the workflow templates from our live DB so we can get an idea of
 * what is there", alongside more than one goal.
 */
describe('the demo carries the template library and a real spread of goals', () => {
  const demoFetch = createDemoFetch(globalThis.fetch);
  const get = async (p: string) => (await (demoFetch(`http://x/api/${p}`, { method: 'GET' } as RequestInit) as Promise<Response>)).json();

  it('serves templates, not only runs', async () => {
    const all = await get('workflows');
    const templates = all.filter((w: { templateId: string | null }) => !w.templateId);
    const runs = all.filter((w: { templateId: string | null }) => w.templateId);
    expect(templates.length, 'no templates — the workflow library renders empty').toBeGreaterThan(20);
    expect(runs.length, 'the runs disappeared when templates were added').toBeGreaterThan(0);
  });

  it('every template has a name and its real step sequence', async () => {
    const all = await get('workflows');
    const bad = all
      .filter((w: { templateId: string | null }) => !w.templateId)
      .filter((t: { name: string; stepSummary?: { total: number; stepNames: string[] } }) =>
        !t.name || !t.stepSummary || t.stepSummary.stepNames.length === 0
        || t.stepSummary.total !== t.stepSummary.stepNames.length);
    expect(bad.map((t: { name: string }) => t.name),
      'these templates have no steps, or a total that disagrees with the names').toEqual([]);
  });

  it('carries the templates a demo would be asked about', async () => {
    const names: string[] = (await get('workflows')).map((w: { name: string }) => w.name);
    for (const want of ['Bug Investigation', 'Daily AI Research Digest', 'Confer', 'Deep Research']) {
      expect(names, `"${want}" is missing from the demo library`).toContain(want);
    }
  });

  it('EVERY workflow row carries the array fields the cards dereference', async () => {
    /**
     * The card renders `w.stepSummary` for a run and falls back to `w.phases.length` for
     * anything else — so a row without `phases` blanks the app. That is exactly what adding
     * the template library did the first time: 27 rows, none with `phases`, white screen.
     * Checked over EVERY row rather than a sample, because it was the new rows that broke it.
     */
    const all = await get('workflows');
    const bad = all.filter((w: Record<string, unknown>) =>
      !Array.isArray(w.phases) || !Array.isArray(w.players));
    expect(bad.map((w: { name: string }) => w.name),
      'these rows lack phases/players as arrays; the workflow card reads .length on them').toEqual([]);
  });

  it('shows goals in more than one state', async () => {
    const goals = await get('goals');
    expect(goals.length, 'one goal shows the shape but not the point').toBeGreaterThan(2);
    expect(new Set(goals.map((g: { status: string }) => g.status)).size,
      'every demo goal has the same status, so the screen looks uniform').toBeGreaterThan(1);
    for (const g of goals) {
      expect(g.name, 'a goal with no name').toBeTruthy();
      expect(g.successMetric, `goal "${g.name}" has no success metric`).toBeTruthy();
    }
  });

  it('every goal carries the intent fields the goal screen calls .trim() on', async () => {
    /**
     * GoalsPage INTENT_FIELDS reads description, acceptanceCriteria, invariants, noGos and
     * rabbitHoles and calls `.trim()` on each with no guard, so a goal missing any one of them
     * blanks the Goals screen. The original single demo goal had none of them — the crash was
     * there before the library was added, waiting for anyone who opened a goal.
     */
    const FIELDS = ['description', 'acceptanceCriteria', 'invariants', 'noGos', 'rabbitHoles'];
    const goals = await get('goals');
    const bad: string[] = [];
    for (const g of goals) {
      for (const f of FIELDS) {
        if (typeof g[f] !== 'string') bad.push(`${g.name}.${f}`);
      }
    }
    expect(bad, 'these goal fields are not strings; .trim() on them blanks the screen').toEqual([]);
  });
});

/**
 * A goal's reach is resolved from the PROJECTS that point at it (`project.goalId`), not from
 * anything on the goal. With no project carrying a goalId, every goal rendered "0 projects ·
 * reaches nothing" and the page warned that no project had a goal — a demo showing the empty
 * state of the feature it exists to show.
 */
describe('goals actually reach projects in the demo', () => {
  const demoFetch = createDemoFetch(globalThis.fetch);
  const get = async (p: string) => (await (demoFetch(`http://x/api/${p}`, { method: 'GET' } as RequestInit) as Promise<Response>)).json();

  it('at least one project points at a goal, and every such link resolves', async () => {
    const [projects, goals] = [await get('projects'), await get('goals')];
    const linked = projects.filter((p: { goalId?: string | null }) => p.goalId);
    expect(linked.length, 'no project carries a goalId, so every goal reaches nothing').toBeGreaterThan(0);
    const goalIds = new Set(goals.map((g: { id: string }) => g.id));
    const dangling = linked
      .filter((p: { goalId: string }) => !goalIds.has(p.goalId))
      .map((p: { name: string; goalId: string }) => `${p.name} → ${p.goalId}`);
    expect(dangling, 'these projects point at a goal that does not exist').toEqual([]);
  });
});

/**
 * THE DEMO GOAL MUST CARRY EVERY FIELD THE REAL ROUTE EMITS — DERIVED, NOT LISTED HERE.
 *
 * The fakes were written from the screen rather than from the contract, and drifted in four
 * ways at once: `title` where the API says `name` (so every goal rendered with no heading),
 * `projectIds` — a field the route has never returned — instead of `projectCount`, and none of
 * `reach`, `progress`, `health` or `schedule`, which is why all five goals read "reaches
 * nothing" beside a $0 spend. The first guess at the missing four made them scalars; three of
 * them are objects or null.
 *
 * Hard-coding the key list here would just be a fifth copy to drift. Instead this reads
 * `normalizeGoal` in the server route — the one place that decides a goal's shape — and
 * requires the demo to answer for every key it emits. Add a field there and this fails until
 * the demo has it too.
 */
describe('demo goals match the server goal contract', () => {
  const demoFetch = createDemoFetch(globalThis.fetch);
  const get = async (p: string) => (await (demoFetch(`http://x/api/${p}`, { method: 'GET' } as RequestInit) as Promise<Response>)).json();

  /** Keys of the object literal normalizeGoal() returns, read from the route itself. */
  const contractKeys = async (): Promise<string[]> => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../../server/src/routes/goals.ts'), 'utf8');
    const body = src.match(/function normalizeGoal[\s\S]*?\n  return \{([\s\S]*?)\n  \};/);
    if (!body) throw new Error('normalizeGoal() not found — this test is no longer reading the contract');
    return [...body[1].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  };

  it('every key normalizeGoal returns is present on every demo goal', async () => {
    const keys = await contractKeys();
    expect(keys.length, 'parsed no keys out of normalizeGoal').toBeGreaterThan(10);
    expect(keys, 'the route stopped emitting `name`; this test is reading the wrong thing').toContain('name');
    const goals = await get('goals');
    const missing: string[] = [];
    for (const g of goals) {
      for (const k of keys) if (!(k in g)) missing.push(`${g.id}.${k}`);
    }
    expect(missing, 'the demo goal is missing fields the real API always returns').toEqual([]);
  });

  it('carries the four PM fields, in the shapes the route returns', async () => {
    const goals = await get('goals');
    for (const g of goals) {
      expect(typeof g.reach, `${g.id}.reach`).toBe('number');
      expect(typeof g.projectCount, `${g.id}.projectCount`).toBe('number');
      // progress is always an object; fraction is number|null and null is NOT 0.
      expect(g.progress, `${g.id}.progress`).toBeTypeOf('object');
      expect(g.progress).not.toBeNull();
      expect(['number', 'object'], `${g.id}.progress.fraction`).toContain(typeof g.progress.fraction);
      // health and schedule are object-or-null — never a bare string.
      for (const f of ['health', 'schedule'] as const) {
        if (g[f] !== null) expect(g[f], `${g.id}.${f} must be an object or null`).toBeTypeOf('object');
      }
    }
  });

  /**
   * reach counts the cartridges the goal resolves to THROUGH ITS PROJECTS. A hand-written reach
   * that disagrees with the projects is the "confident lie" goal-reach.ts was written to avoid.
   */
  it('reach and projectCount agree with the demo projects', async () => {
    const [projects, goals] = [await get('projects'), await get('goals')];
    const wrong: string[] = [];
    for (const g of goals) {
      const mine = projects.filter((p: { goalId?: string }) => p.goalId === g.id);
      const reach = new Set(mine.flatMap((p: { cartridges?: string[] }) => p.cartridges ?? [])).size;
      if (g.projectCount !== mine.length) wrong.push(`${g.id}: projectCount ${g.projectCount} but ${mine.length} projects link to it`);
      if (g.reach !== reach) wrong.push(`${g.id}: reach ${g.reach} but its projects hold ${reach} cartridges`);
    }
    expect(wrong, 'a goal claims reach its projects do not back').toEqual([]);
  });
});

/**
 * A STATUS THE BADGE MAP HAS NO ENTRY FOR WHITES OUT THE SCREEN.
 *
 * `statusBadge()` does `const { label, cls } = map[status]` with no fallback, so a goal whose
 * status is outside the union destructures undefined and unmounts the app. The demo invented
 * `blocked` and `completed` — plausible English, neither in `'active' | 'achieved' | 'paused'`
 * — and the goal opened to a blank page. The other shape tests all passed, because the value
 * was a perfectly good string; only the LOOKUP rejected it.
 *
 * Read from GoalsPage's own map so the accepted set can never be a second list to drift.
 */
describe('demo goal statuses are ones the badge map can render', () => {
  const demoFetch = createDemoFetch(globalThis.fetch);

  it('every demo goal status has an entry in statusBadge()', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../components/GoalsPage.tsx'), 'utf8');
    const body = src.match(/function statusBadge[\s\S]*?\{([\s\S]*?)\n  \};/);
    if (!body) throw new Error('statusBadge() map not found — this test is no longer reading the contract');
    const known = new Set([...body[1].matchAll(/^\s{4}(\w+):\s*\{/gm)].map((m) => m[1]));
    expect(known.size, 'parsed no statuses out of statusBadge()').toBeGreaterThan(1);

    const res = await (demoFetch('http://x/api/goals', { method: 'GET' } as RequestInit) as Promise<Response>);
    const goals = await res.json();
    const unrenderable = goals
      .filter((g: { status: string }) => !known.has(g.status))
      .map((g: { id: string; status: string }) => `${g.id} is "${g.status}"`);
    expect(unrenderable, `statusBadge() only handles ${[...known].join(', ')}; these blank the page`).toEqual([]);
  });
});
