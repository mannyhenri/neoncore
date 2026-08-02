/**
 * React must exist exactly ONCE from the app's point of view.
 *
 * Build 32 crashed at launch with `TypeError: Cannot read property 'useState' of null`, which
 * is what React says when two copies are loaded: one module gets copy A's hook dispatcher and
 * renders against copy B, whose internal state is null.
 *
 * The cause was mine. Adding `mobile` to the npm workspaces hoisted most dependencies to the
 * root, but a second React stayed in mobile/node_modules (19.2.3 against the root's 19.2.4),
 * and the metro config I added lists BOTH directories in nodeModulesPaths. Metro then resolved
 * some imports to each.
 *
 * Set-based over the packages that must be singletons rather than asserting "react is fine":
 * react-native and the renderer break the same way, and a check that names only the one that
 * bit us would pass while the next duplicate ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');

/**
 * Packages where two copies is a crash, not a waste. Each holds process-wide mutable state —
 * React's hook dispatcher, the RN module registry — so a second copy is not a bigger bundle,
 * it is a different runtime silently in play.
 */
const SINGLETONS = ['react', 'react-native'];

function versionAt(dir: string, pkg: string): string | null {
  const p = path.join(ROOT, dir, 'node_modules', pkg, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).version as string; } catch { return null; }
}

test('the singleton list is non-empty — an empty list would pass vacuously', () => {
  assert.ok(SINGLETONS.length >= 2);
});

test('EVERY singleton resolves to exactly one copy for the mobile app', () => {
  const dupes: string[] = [];
  for (const pkg of SINGLETONS) {
    const inMobile = versionAt('mobile', pkg);
    const inRoot = versionAt('.', pkg);
    if (inMobile && inRoot) {
      dupes.push(`${pkg}: mobile has ${inMobile}, root has ${inRoot} — metro can load both`);
    }
    assert.ok(inMobile || inRoot, `${pkg} is not installed anywhere — the app cannot build`);
  }
  assert.deepEqual(
    dupes, [],
    `two copies loaded at once is the "Cannot read property 'useState' of null" crash:\n  ${dupes.join('\n  ')}`,
  );
});

test('metro pins the singletons so hoisting cannot reintroduce a second copy', () => {
  // Deduping node_modules fixes today; a pin fixes every future `npm install` that re-adds a
  // nested copy. Without it this test would go red again on the next dependency change and the
  // app would crash before anyone ran it.
  const cfg = fs.readFileSync(path.join(ROOT, 'mobile/metro.config.js'), 'utf8');
  const unpinned = SINGLETONS.filter((p) => !new RegExp(`['"]${p}['"]`).test(cfg));
  assert.deepEqual(
    unpinned, [],
    `metro.config.js does not pin: ${unpinned.join(', ')} — a nested copy would be resolvable again`,
  );
});
