/**
 * The app's types now live in the shared client package, so the web app and the iOS app
 * describe the same server with the same shapes instead of two drifting copies.
 *
 * This re-export is deliberate: every existing `import type { Agent } from '../types'`
 * keeps working untouched, so the move cost the app nothing at the call sites.
 */
export * from '@neoncore/client';
