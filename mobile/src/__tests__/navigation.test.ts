import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every destination in the tab bar must actually render something, and every pushed screen
 * must hide the chrome and have a way back.
 *
 * The phone's role is to keep the ball rolling on projects under way, so its bar is four
 * destinations — Needs you (the home), Projects, In progress, Settings — and the rest opens on
 * top of them: a project (Board · Route), a feature, a run, a cartridge. A missing screen is
 * silence, not an error, which is why this is pinned here.
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
const TABBAR = fs.readFileSync(path.join(ROOT, 'src/components/TabBar.tsx'), 'utf8');

const tabs = (() => {
  const start = TABBAR.indexOf('export const TABS');
  return [...TABBAR.slice(start, TABBAR.indexOf('];', start)).matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
})();

describe('the tab bar and the router agree', () => {
  it('is the five destinations the phone is for, Needs you first', () => {
    expect(tabs).toEqual(['needs', 'projects', 'agents', 'progress', 'settings']);
  });

  it('opens on Needs you', () => {
    expect(APP).toMatch(/useState<Route>\(\{ name: 'needs' \}\)/);
  });

  it('renders a screen for every tab', () => {
    const missing = tabs.filter((t) => !APP.includes(`route.name === '${t}'`));
    expect(missing, `tabs with no route in App.tsx: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps every tab name in TabName', () => {
    const at = TABBAR.indexOf('export type TabName');
    const union = TABBAR.slice(at, TABBAR.indexOf(';', at));
    expect(tabs.filter((t) => !union.includes(`'${t}'`))).toEqual([]);
  });

  it('has no More pile: nothing hides behind a fifth tab', () => {
    expect(TABBAR).not.toMatch(/MORE_TABS|'more'/);
    expect(APP).not.toMatch(/MoreSheet/);
  });

  it('does not offer the retired destinations', () => {
    for (const gone of ['QueueScreen', 'WorkflowsScreen', 'TasksScreen', 'TokensScreen', 'GoalsScreen', 'CartridgeListScreen', 'ApprovalsScreen']) {
      expect(APP, `${gone} is retired`).not.toContain(gone);
    }
  });
});

describe('pushed screens', () => {
  const pushed = APP.slice(APP.indexOf('const PUSHED'), APP.indexOf('];', APP.indexOf('const PUSHED')));

  it('lists every screen with its own back control as pushed, and renders each', () => {
    for (const name of ['project', 'feature', 'workflowRun', 'agent', 'memory']) {
      expect(pushed, `${name} should be a pushed screen`).toContain(`'${name}'`);
      expect(APP, `${name} has no route`).toContain(`route.name === '${name}'`);
    }
  });

  it('remembers where it came from, so Back returns there', () => {
    const union = APP.slice(APP.indexOf('type Route ='), APP.indexOf('const PUSHED'));
    expect(union.match(/; from: Route \}/g)?.length, 'every pushed route carries `from`').toBe(5);
    expect(APP).toMatch(/const back = /);
    expect(APP.match(/onBack=\{back\}/g)?.length).toBe(5);
  });

  it('gates both the header and the tab bar on the same rule', () => {
    expect(APP.match(/\{isTab\(route\) && </g) ?? []).toHaveLength(2);
  });

  it('sends an approval push to Needs you, where permission requests now live', () => {
    expect(APP).toMatch(/onOpenApprovals: \(\) => setRoute\(\{ name: 'needs' \}\)/);
  });

  it('wires over-the-air updates to the primary server', () => {
    expect(APP).toMatch(/useUpdates\(serverUrl, serverToken\)/);
  });
});
