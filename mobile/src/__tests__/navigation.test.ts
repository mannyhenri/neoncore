import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every destination in the tab bar must actually render something.
 *
 * This is the gap class that started all of this: the phone had no Goals or Tasks surface
 * at all while the web did, and nothing failed — a missing screen is silence, not an
 * error. A tab wired to no route is the same silence one step later, and it is the exact
 * mistake that adding six tabs by hand invites.
 *
 * The TabBar's own comment records the earlier version of this bug: destinations that
 * existed but could not be seen went unused.
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
const TABBAR = fs.readFileSync(path.join(ROOT, 'src/components/TabBar.tsx'), 'utf8');
const SHEET = fs.readFileSync(path.join(ROOT, 'src/components/MoreSheet.tsx'), 'utf8');

/** Names from one declaration block, as the source declares them — not as this test remembers. */
function namesIn(marker: string): string[] {
  const start = TABBAR.indexOf(marker);
  if (start < 0) return [];
  const block = TABBAR.slice(start, TABBAR.indexOf('];', start));
  return [...block.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * The bar is TWO TIERS now: five primary tabs, the fifth of which opens a sheet holding the
 * rest. `more` is the one entry that is NOT a destination — it opens the sheet — so every
 * check below reasons about the union of real destinations rather than about one array.
 *
 * The original gap this file guards is unchanged: a destination that renders nothing is
 * silence, not an error. The regroup adds a second way to be silent — a destination that is
 * in neither tier, reachable from nowhere — so that is now asserted too.
 */
const primary = namesIn('const TABS');
const more = namesIn('export const MORE_TABS');
const destinations = [...primary.filter((t) => t !== 'more'), ...more];

describe('the tab bar and the router agree', () => {
  const tabs = destinations;

  it('finds both tiers (a parse failure here would assert nothing)', () => {
    expect(primary.length, 'no primary tabs parsed').toBeGreaterThanOrEqual(4);
    expect(more.length, 'no More entries parsed').toBeGreaterThanOrEqual(2);
    expect(tabs).toContain('goals');
    expect(tabs).toContain('tasks');
    expect(tabs).toContain('tokens');
  });

  it('keeps the bar to five — the reason the More pile exists at all', () => {
    // Each tab is flex:1. Six was already shrinking "Cartridges" to fit on a 320pt phone;
    // seven would make every label illegible to save one tap on a reference surface.
    expect(primary.length, `the bar declares ${primary.length} tabs: ${primary.join(', ')}`).toBeLessThanOrEqual(5);
    expect(primary, 'the bar must offer a way to reach the rest').toContain('more');
  });

  it('routes nothing to `more` — it opens a sheet, it is not a destination', () => {
    expect(APP.includes("route.name === 'more'"), '`more` must not be a route').toBe(false);
  });

  it('renders every More entry in the sheet, so none is reachable from nowhere', () => {
    // MORE_TABS is passed to MoreSheet as `items` and mapped; the sheet must actually map them.
    expect(APP, 'App.tsx must hand MORE_TABS to the sheet').toContain('MORE_TABS');
    expect(SHEET, 'the sheet must render its items').toMatch(/items\.map\(/);
  });

  it('renders a screen for every tab', () => {
    const missing = tabs.filter((t) => !APP.includes(`route.name === '${t}'`));
    expect(missing, `tabs with no route in App.tsx: ${missing.join(', ')}`).toEqual([]);
  });

  it('declares every tab in the Route union, so a typo cannot compile', () => {
    const missing = tabs.filter((t) => !APP.includes(`{ name: '${t}'`));
    expect(missing, `tabs missing from the Route union: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps every tab name in TabName', () => {
    const union = TABBAR.slice(TABBAR.indexOf('export type TabName'), TABBAR.indexOf(';', TABBAR.indexOf('export type TabName')));
    const missing = tabs.filter((t) => !union.includes(`'${t}'`));
    expect(missing, `tabs missing from TabName: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('pushed screens', () => {
  /**
   * A pushed screen draws its own back control and must not also get a tab bar — two ways
   * back, one of which silently drops the thing you were looking at.
   */
  it('hide the chrome, and every screen with a back button is listed as pushed', () => {
    const pushed = APP.slice(APP.indexOf('const PUSHED'), APP.indexOf('];', APP.indexOf('const PUSHED')));
    for (const name of ['detail', 'workflowRun', 'goalDetail']) {
      expect(pushed, `${name} should be a pushed screen`).toContain(`'${name}'`);
    }
  });

  it('gate both the header and the tab bar on the same list', () => {
    // Two call sites that must agree; they previously did so by repeating a comparison.
    expect(APP.match(/!PUSHED\.includes\(route\.name\)/g) ?? []).toHaveLength(2);
  });
});
