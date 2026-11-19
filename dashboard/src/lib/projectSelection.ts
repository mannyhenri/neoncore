/**
 * Which project — and which of its features — the Projects view is showing.
 *
 * The view is master–detail across two regions App owns separately (the rail and the working
 * surface), so the selection is one value both read, kept in the URL so a project or a feature is
 * addressable and survives a refresh:
 *
 *   #project/<projectId>                      a project and its feature list
 *   #project/<projectId>/feature/<featureId>  one feature and its pipeline
 *   #project/unfiled                          features not filed under any project (old goals)
 *
 * Links from before the project → features change keep working: `#goal/<id>` (the old deep link)
 * and `#goal=<id>` (what desktop notifications send) name a feature, and are resolved to it.
 *
 * `requested` is what the URL asked for; `resolveProjectSelection` returns what can actually be
 * SHOWN. An id can be deleted mid-session or arrive from a week-old notification — the workspace
 * falls back rather than rendering a blank pane beside a full rail.
 */

/** The bucket for features that belong to no project. Never a project id. */
export const UNFILED = 'unfiled';

export interface ProjectRequest {
  projectId: string | null;
  featureId: string | null;
}

function decode(raw: string): string | null {
  if (!raw) return null;
  try { return decodeURIComponent(raw) || null; } catch { return null; }
}

/** Read a selection out of `location.hash`. Null for anything that is not a projects link. */
export function parseProjectHash(hash: string): ProjectRequest | null {
  const goal = hash.match(/^#goal[/=]([^/?&#]+)/);
  if (goal) {
    const id = decode(goal[1]);
    return id ? { projectId: null, featureId: id } : null;
  }
  const m = hash.match(/^#project\/([^/]+)(?:\/feature\/([^/]+))?\/?$/);
  if (!m) return null;
  const projectId = decode(m[1]);
  if (!projectId) return null;
  return { projectId, featureId: m[2] ? decode(m[2]) : null };
}

/** The addressable form of a selection. */
export function projectHash(projectId: string, featureId?: string | null): string {
  return `#project/${encodeURIComponent(projectId)}${featureId ? `/feature/${encodeURIComponent(featureId)}` : ''}`;
}

/** Is this hash something the Projects view answers? (App switches to the view for it.) */
export function isProjectsHash(hash: string): boolean {
  return parseProjectHash(hash) !== null;
}

/**
 * What the workspace can show, given what was asked for.
 *
 * A feature asked for on its own (an old goal link) is shown in its project. An explicit, still-
 * valid request always wins; everything after that is the never-blank guarantee.
 */
export function resolveProjectSelection({
  projectIds, features, hasUnfiled, requested,
}: {
  projectIds: string[];
  features: { id: string; projectId?: string | null }[];
  hasUnfiled: boolean;
  requested: ProjectRequest | null;
}): ProjectRequest {
  const feature = requested?.featureId ? features.find((f) => f.id === requested.featureId) : undefined;
  if (feature) {
    const home = feature.projectId && projectIds.includes(feature.projectId) ? feature.projectId : UNFILED;
    return { projectId: home, featureId: feature.id };
  }
  const asked = requested?.projectId ?? null;
  if (asked && projectIds.includes(asked)) return { projectId: asked, featureId: null };
  if (asked === UNFILED && hasUnfiled) return { projectId: UNFILED, featureId: null };
  if (projectIds.length > 0) return { projectId: projectIds[0], featureId: null };
  if (hasUnfiled) return { projectId: UNFILED, featureId: null };
  return { projectId: null, featureId: null };
}
