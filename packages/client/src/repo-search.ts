import type { Machine } from './types.js';

/**
 * Filtering the launch list by repo, WITHOUT losing which machine each hit is on.
 *
 * "+ Launch" groups folders under the machine that exposes them. At fleet scale that list is
 * too long to scan, but a flat list of matching repo names would answer the wrong question:
 * the same repo is checked out on several machines, and choosing the right copy IS the
 * decision — launching `gridlight` on the Mac Pro when you are sitting at the MacBook puts the
 * cartridge on the wrong box. So this narrows the tree and never flattens it: machines are
 * dropped or kept, and a kept machine carries only its matching folders.
 *
 * Hostname is part of the haystack as well as the grouping, which is what makes
 * "gridlight macbook" resolve the ambiguity in one query instead of two steps.
 *
 * Offline machines are searchable on purpose. Their folders are still registered; the row
 * already explains the runner is not connected, and hiding them mid-search would recreate the
 * "my repos are gone" reading that the offline row exists to prevent.
 */

/** Every term must appear somewhere in the repo's name, its path, or its machine's hostname. */
function matches(repoName: string, repoPath: string, hostname: string, terms: string[]): boolean {
  const haystack = `${repoName} ${repoPath} ${hostname}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/**
 * The machines to render for `query`, each carrying only its matching repos.
 *
 * An empty or whitespace-only query is "no search", not "search for nothing": the fleet comes
 * back untouched, including machines with no folders, so opening the launcher and typing
 * nothing looks exactly as it always has.
 *
 * Never mutates the input — callers hold this straight off React state.
 *
 * GENERIC ON PURPOSE. The web launcher works with `Machine & { origin }`, where `origin` names
 * the server that owns the machine — machines are not gossiped between servers, so a launch
 * has to go back to the one that answered. Returning a bare `Machine` would erase that field
 * and dispatch to whichever server served the page: a launch on the wrong box, silently.
 */
export function filterMachinesByRepo<T extends Machine>(machines: T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return machines;

  const out: T[] = [];
  for (const m of machines) {
    const repos = m.repos.filter((r) => matches(r.name, r.path, m.hostname, terms));
    // A machine with nothing left has nothing to launch, so it is not a row worth a line.
    if (repos.length > 0) out.push({ ...m, repos });
  }
  return out;
}

/** Total folders across a fleet — the "N of M" the search box reports. */
export function countRepos<T extends Machine>(machines: T[]): number {
  return machines.reduce((n, m) => n + m.repos.length, 0);
}
