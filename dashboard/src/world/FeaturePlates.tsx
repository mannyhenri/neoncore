/**
 * FEATURES ON THE MAP — what the map needs to know about the features being built.
 *
 * An agent working in a feature's worktree stands at its REAL repo's building (worktreeRepos). The
 * features themselves are not drawn on the map — they are listed in the HUD along its bottom
 * (FeatureHud.tsx), in this order (plateOrder).
 */
import type { ActiveFeature } from '../types';

/** Every worktree a feature runs in → the real repo it is a worktree of (paths normalised by the caller). */
export function worktreeRepos(features: readonly ActiveFeature[], norm: (p: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of features) for (const w of f.worktrees) out.set(norm(w.worktreePath), w.repoPath);
  return out;
}

/** Which features come first: those that need you, then the furthest along, then by name. */
export function plateOrder<T extends Pick<ActiveFeature, 'needsYou' | 'stage' | 'name'>>(features: readonly T[]): T[] {
  const along = (f: T) => (f.stage ? f.stage.position / Math.max(1, f.stage.total) : 0);
  return [...features].sort((a, b) => Number(!!b.needsYou) - Number(!!a.needsYou) || along(b) - along(a) || a.name.localeCompare(b.name));
}
