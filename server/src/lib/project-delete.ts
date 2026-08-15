import db from '../db.js';

/**
 * Delete a project and everything that only makes sense while it exists.
 *
 * `DELETE /api/projects/:id` used to run a single `DELETE FROM projects`. `project_cartridges`
 * carries no foreign key, so every deletion orphaned that project's repo mappings. The leak was
 * invisible because reach and cost both JOIN through `projects`, so orphans silently drop out of
 * every query — a table quietly filling with rows that point at nothing.
 *
 * WHAT DELIBERATELY SURVIVES:
 *  · workflow runs — `ON DELETE SET NULL`. Run history outlives the project that framed it; a
 *    completed run is evidence, and losing it to a tidy-up would be worse than a dangling link.
 *  · project_knowledge — keyed by repo NAME (`project` is a repo name, not a project id), so it
 *    belongs to the repo and must not follow a project into the grave.
 */
export function deleteProjectCascade(projectId: string): void {
  if (!projectId) return;
  const tx = db.transaction((id: string) => {
    db.prepare('DELETE FROM project_cartridges WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
  tx(projectId);
}
