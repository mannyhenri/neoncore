import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * "Add a version in the bottom-left menu as V2.0 … and update the package.json too" (2026-11-18).
 * The label is DERIVED from the root package.json at build time, so the two cannot disagree.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_PKG = JSON.parse(readFileSync(resolve(HERE, '../../../package.json'), 'utf8'));
const APP = readFileSync(resolve(HERE, '../App.tsx'), 'utf8');

describe('the release label', () => {
  it('the app, dashboard and server packages are on 2.0', () => {
    for (const p of ['../../../package.json', '../../package.json', '../../../server/package.json']) {
      expect(JSON.parse(readFileSync(resolve(HERE, p), 'utf8')).version, p).toMatch(/^2\.0\./);
    }
  });

  it('the build injects the root version, and the test run sees the same value', () => {
    expect(__APP_VERSION__).toBe(ROOT_PKG.version);
  });

  it('the label renders in the view bar, at its foot, as V<major>.<minor>', () => {
    const nav = APP.slice(APP.indexOf('<nav'), APP.indexOf('</nav>'));
    const at = nav.indexOf('V{__APP_VERSION__');
    expect(at, 'no version label in the view bar').toBeGreaterThan(-1);
    expect(at, 'the label is above Settings — it belongs at the foot').toBeGreaterThan(nav.indexOf('setSettingsOpen(true)'));
    expect(`V${ROOT_PKG.version.split('.').slice(0, 2).join('.')}`).toBe('V2.0');
  });
});
