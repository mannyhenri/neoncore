import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Two copies of React is a crash at launch, and this app has now shipped it TWICE.
 *
 * Build 32: `TypeError: Cannot read property 'useState' of null`. Build 40: the same error,
 * same cause, caught in the simulator under lldb —
 *
 *     Unhandled JS Exception: TypeError: Cannot read property 'useState' of null
 *       App@44944:40
 *       renderWithHooks@9808:31
 *
 * That is what React says when the renderer holds copy A's hook dispatcher and the component
 * reads `useState` off copy B, whose dispatcher is null.
 *
 * ── WHY A GUARD ALREADY EXISTED AND THE APP SHIPPED ANYWAY ──────────────────────────────
 * server/test/mobile-singleton-deps.test.ts has guarded this since build 32, and it WAS red.
 * It lives in the SERVER's suite. Building the iOS app runs `npm test -w @neoncore/mobile`,
 * which was 74/74 green while the archive being signed was guaranteed to crash on launch. A
 * guard in a package nobody runs before the risky action is a guard that only produces a
 * post-mortem. So it lives here now: red here stops an iOS build.
 *
 * ── WHY THE METRO PIN DID NOT SAVE US ───────────────────────────────────────────────────
 * metro.config.js maps the singletons through `extraNodeModules` and its comment claimed that
 * "wins over nodeModulesPaths". It does not — extraNodeModules is a FALLBACK consulted when
 * normal resolution fails, so a nested copy that resolves successfully is used and the mapping
 * never applies. `resolveRequest` is the hook that actually overrides, and that is what the
 * config uses now. Asserted below, because the previous belief was written down and believed.
 *
 * SET-BASED over every package resolvable from BOTH trees, derived from the filesystem rather
 * than a hand-written pair. The list of two was correct about react and would not have caught
 * a third duplicate; this fails on anything duplicated that is not explicitly exempt.
 */

const MOBILE = path.join(import.meta.dirname, '..', '..');
const ROOT = path.join(MOBILE, '..');

/**
 * Duplicates that cannot reach the bundle. Metro bundles what the app IMPORTS; a compiler
 * invoked by tsc is never required at runtime. Exempting by name with a reason keeps this an
 * accepted duplicate rather than an unnoticed one — and the test below proves each exemption
 * is still real, so the list cannot silently widen.
 */
const BUILD_ONLY: Record<string, string> = {
  typescript: 'compiler, invoked by tsc — never imported by app code, never bundled',
};

function versionAt(tree: string, pkg: string): string | null {
  const p = path.join(tree, 'node_modules', pkg, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).version as string; } catch { return null; }
}

/** Every package present in BOTH trees — the real duplication set, not a remembered one. */
function duplicates(): { pkg: string; mobile: string; root: string }[] {
  const dir = path.join(MOBILE, 'node_modules');
  if (!fs.existsSync(dir)) return [];
  const out: { pkg: string; mobile: string; root: string }[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const names = entry.startsWith('@')
      ? fs.readdirSync(path.join(dir, entry)).map((s) => `${entry}/${s}`)
      : [entry];
    for (const pkg of names) {
      const m = versionAt(MOBILE, pkg);
      const r = versionAt(ROOT, pkg);
      if (m && r) out.push({ pkg, mobile: m, root: r });
    }
  }
  return out;
}

describe('singleton dependencies', () => {
  it('can see both trees (a scan that finds nothing would pass vacuously)', () => {
    expect(fs.existsSync(path.join(ROOT, 'node_modules', 'react-native')), 'root tree not found').toBe(true);
    expect(versionAt(ROOT, 'react'), 'react not installed at the root').toBeTruthy();
  });

  it('has no duplicate that metro could bundle twice', () => {
    const offenders = duplicates()
      .filter((d) => !(d.pkg in BUILD_ONLY))
      .map((d) => `${d.pkg}: mobile has ${d.mobile}, root has ${d.root} — metro can load both`);
    expect(
      offenders,
      `two copies at once is the "Cannot read property 'useState' of null" launch crash:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps every BUILD_ONLY exemption honest — none may name a package that is not duplicated', () => {
    // An exemption for something no longer duplicated is dead text that widens the next time
    // that name reappears for a different reason.
    const dupNames = new Set(duplicates().map((d) => d.pkg));
    const stale = Object.keys(BUILD_ONLY).filter((p) => !dupNames.has(p));
    expect(stale, `BUILD_ONLY exempts packages that are not duplicated: ${stale.join(', ')}`).toEqual([]);
  });

  it('forces singleton resolution through resolveRequest, not extraNodeModules alone', async () => {
    // EXERCISED, not grepped. The first version of this asserted the config merely CONTAINED
    // "resolveRequest" — which every passthrough does, via `context.resolveRequest`. A mutation
    // that disabled the redirect passed it. So the redirect is now actually called.
    const cfg = (await import('../../metro.config.js')).default as {
      resolver: { resolveRequest: (c: unknown, n: string, p: string | null) => unknown };
    };
    const seen: string[] = [];
    const context = {
      resolveRequest: (_c: unknown, name: string) => { seen.push(name); return { type: 'sourceFile', filePath: name }; },
    };

    // Singletons and their subpaths redirect to the ONE copy at the monorepo root.
    for (const spec of ['react', 'react/jsx-runtime', 'react-native']) {
      seen.length = 0;
      cfg.resolver.resolveRequest(context, spec, 'ios');
      expect(seen[0], `${spec} was not redirected to the root copy`).toMatch(
        new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/node_modules/`),
      );
      expect(seen[0], `${spec} lost its subpath in the redirect`).toContain(spec.split('/')[0]);
    }

    // A lookalike must NOT be rewritten: react-native-svg starts with "react-native".
    seen.length = 0;
    cfg.resolver.resolveRequest(context, 'react-native-svg', 'ios');
    expect(seen[0], 'react-native-svg was wrongly redirected as if it were react-native')
      .toBe('react-native-svg');
  });
});
