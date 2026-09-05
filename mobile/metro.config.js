const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro config for the bare React Native app (replaces Expo's metro preset).
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const path = require('path');
const monorepoRoot = path.resolve(__dirname, '..');

/**
 * Metro does not look outside projectRoot by default, so a workspace package symlinked at
 * ../packages/client is invisible to it. mobile was never a workspace member either, which
 * is why @neoncore/client was unresolvable here and this app hand-copied the server's types
 * instead — and that copy is exactly why mobile still declared six engines a day after the
 * removal landed. Nobody updates a copy.
 *
 * WHAT THIS CONFIG DOES AND DOES NOT BUY, measured rather than assumed:
 *   TYPE-ONLY imports work today. `import type` is erased before metro sees anything, so
 *   the shared contract is enforced by tsc with no bundler involvement at all. That is what
 *   src/api.ts uses, and it is sufficient — mobile has its own req() helper and needs the
 *   types, not the runtime.
 *
 *   RUNTIME imports still fail, and this config is what gets metro far enough to say why.
 *   Probed with `import { ApiError } from '@neoncore/client'`:
 *     error Unable to resolve module ./client.js from packages/client/src/index.ts:
 *     None of these files exist:
 *   Metro RESOLVES the package (so watchFolders/nodeModulesPaths are correct and load-
 *   bearing) and then cannot follow the NodeNext '.js' specifiers in its source, because
 *   the real files are '.ts'. tsc and Vite rewrite those; metro does not.
 *
 *   The fix when someone needs a runtime import is to give packages/client a build step
 *   emitting JS + .d.ts and point main at dist — ordinary JavaScript is the boring path RN
 *   monorepos take. Deliberately NOT done here: nothing needs it yet, and shipping an
 *   unused build step is its own dead weight.
 */
/**
 * Packages that MUST be a single instance. Two Reacts is not a bigger bundle — it is two hook
 * dispatchers, and the app dies at launch with "Cannot read property 'useState' of null".
 *
 * THIS HAS SHIPPED TWICE. Build 32: adding mobile to the npm workspaces hoisted most deps to
 * the root while a nested react survived, and nodeModulesPaths below lists both directories.
 * Build 40: the identical crash, caught under lldb —
 *
 *     Unhandled JS Exception: TypeError: Cannot read property 'useState' of null
 *       App@44944:40  renderWithHooks@9808:31
 *
 * ── WHY THE SECOND TIME HAPPENED WITH THIS PIN ALREADY IN PLACE ─────────────────────────
 * The previous version mapped these through `extraNodeModules` and asserted in a comment that
 * it "wins over nodeModulesPaths". IT DOES NOT. extraNodeModules is a FALLBACK, consulted
 * only when normal resolution FAILS. A nested mobile/node_modules/react resolves perfectly
 * well, so the fallback was never reached and the mapping did nothing. The comment was
 * confident, load-bearing and wrong, which is worse than absent — it is why the nested copy
 * was treated as harmless when the version drift reappeared.
 *
 * `resolveRequest` is the hook that actually overrides: metro calls it FIRST for every import,
 * so redirecting there cannot be bypassed by a copy that happens to resolve.
 *
 * Three layers, because two have now failed: npm keeps one copy (aligned versions plus a root
 * `overrides` entry), this redirect guarantees one even if npm re-nests, and
 * src/__tests__/singleton-deps.test.ts fails the MOBILE suite if either slips — the suite an
 * iOS build actually runs.
 */
const SINGLETONS = ['react', 'react-native'];
const pinned = Object.fromEntries(
  SINGLETONS.map((p) => [p, path.resolve(monorepoRoot, 'node_modules', p)]),
);

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    // Kept as the fallback it actually is; resolveRequest below is what enforces.
    extraNodeModules: pinned,

    /**
     * Force every import of a singleton to the ONE copy at the monorepo root.
     *
     * Matches the bare specifier and its subpaths ('react', 'react/jsx-runtime') but not
     * lookalikes ('react-native-svg' must not be redirected to react-native), which is why
     * this tests for an exact name or a name followed by '/'.
     */
    resolveRequest: (context, moduleName, platform) => {
      const hit = SINGLETONS.find((p) => moduleName === p || moduleName.startsWith(`${p}/`));
      if (hit) {
        const rest = moduleName.slice(hit.length);
        return context.resolveRequest(
          context,
          path.resolve(monorepoRoot, 'node_modules', hit) + rest,
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
});
