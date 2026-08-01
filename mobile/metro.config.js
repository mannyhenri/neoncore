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
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
  },
});
