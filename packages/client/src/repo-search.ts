import type { Machine } from './types.js';

/**
 * Filtering the launch list by repo, WITHOUT losing which machine each hit is on.
 *
 * "+ Launch" groups folders under the machine that exposes them. At fleet scale that list is
 * too long to scan, but a flat list of matching repo names would answer the wrong question:
 * the same repo is checked out on several machines, and choosing the right copy IS the
 * decision — launching `atlas` on the Mac Pro when you are sitting at the MacBook puts the
 * cartridge on the wrong box. So this narrows the tree and never flattens it: machines are
 * dropped or kept, and a kept machine carries only its matching folders.
 *
 * Hostname is part of the haystack as well as the grouping, which is what makes
 * "atlas macbook" resolve the ambiguity in one query instead of two steps.
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

/**
 * Path identity across machines: backslashes, a Windows drive letter, a trailing slash and case
 * are spelling, not a different folder. Mirrors the server's normalizeRepoPath so a project repo
 * recorded from a cartridge still finds the runner folder it came from.
 */
export function sameRepoPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([a-zA-Z]):\//, '/$1/').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/** One of a project's repos, and every online machine that could launch a cartridge in it. */
export interface RepoLaunchPlan<T extends Machine> {
  repoPath: string;
  name: string;
  /**
   * The online machines exposing this folder, BEST FIRST, each with the path as THAT runner
   * spells it — the launch route checks its allowlist by exact string, so the project's own
   * spelling would be refused on a case or slash difference. [] = nowhere to launch it.
   */
  targets: { machine: T; path: string }[];
}

/**
 * "Launch all" for a project: the same launch the + Launch menu makes, once per repo — so each
 * repo needs a machine. Only online machines count; an offline runner cannot take a launch.
 *
 * When a repo is checked out on several machines, the default is the machine that holds the
 * MOST of this project's repos (ties keep fleet order). That keeps a project's cartridges on one
 * box instead of scattering them across whichever machine happened to be listed first.
 */
export function planProjectLaunch<T extends Machine>(repoPaths: string[], machines: T[]): RepoLaunchPlan<T>[] {
  const online = machines.filter((m) => m.status === 'online');
  const hits = repoPaths.map((repoPath) => ({
    repoPath,
    name: repoPath.split(/[\\/]/).filter(Boolean).pop() || repoPath,
    targets: online.flatMap((machine) => {
      const r = machine.repos.find((x) => sameRepoPath(x.path, repoPath));
      return r ? [{ machine, path: r.path }] : [];
    }),
  }));
  const coverage = new Map<T, number>();
  for (const h of hits) for (const t of h.targets) coverage.set(t.machine, (coverage.get(t.machine) ?? 0) + 1);
  return hits.map((h) => ({
    ...h,
    // Array.prototype.sort is stable, so equal coverage keeps fleet order.
    targets: [...h.targets].sort((a, b) => (coverage.get(b.machine) ?? 0) - (coverage.get(a.machine) ?? 0)),
  }));
}
