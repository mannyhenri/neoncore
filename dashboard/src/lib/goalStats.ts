import type { Project } from '@neoncore/client';

/**
 * Projects that belong to no goal.
 *
 * Legal by design — the user chose (2026-08-13) not to require a goal on project creation:
 * *"shouldn't require a goal on every project just in case we just need to work quickly on
 * something."* That decision is only safe if the consequence stays visible, otherwise
 * unattached work accumulates silently and its cost never rolls up to anything — which is the
 * exact failure this whole phase exists to end.
 *
 * Deliberately a filter over the projects the page already holds, not a second server call:
 * one list, one count, nothing that can disagree with what is rendered beside it.
 */
export function unassignedProjects(projects: Project[]): Project[] {
  return projects.filter((p) => !p.goalId);
}

/** Copy for the banner. Null when there is nothing to say — silence is correct at zero. */
export function unassignedNotice(projects: Project[]): string | null {
  const n = unassignedProjects(projects).length;
  if (n === 0) return null;
  return n === 1
    ? '1 project has no goal — its cost and intent roll up to nothing'
    : `${n} projects have no goal — their cost and intent roll up to nothing`;
}
