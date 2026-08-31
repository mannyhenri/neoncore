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

/** Tab names as the bar actually declares them, not as this test remembers them. */
function declaredTabs(): string[] {
  const block = TABBAR.slice(TABBAR.indexOf('const TABS'), TABBAR.indexOf('];', TABBAR.indexOf('const TABS')));
  return [...block.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('the tab bar and the router agree', () => {
  const tabs = declaredTabs();

  it('finds the tabs (a parse failure here would assert nothing)', () => {
    expect(tabs.length).toBeGreaterThanOrEqual(6);
    expect(tabs).toContain('goals');
    expect(tabs).toContain('tasks');
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
