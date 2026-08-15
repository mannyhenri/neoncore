/**
 * Deleting a project must not leave its cartridge mappings behind.
 *
 * `DELETE /api/projects/:id` ran a single `DELETE FROM projects` — `project_cartridges` has no
 * foreign key and was never touched, so every deleted project left its repo mappings orphaned.
 * They are invisible (the reach/cost queries join through `projects`, so orphans drop out) which
 * is exactly why this accumulated unnoticed: a silent leak that only shows up as a table full of
 * rows pointing at projects that no longer exist.
 *
 * Found while measuring the blast radius of a deliberate clean-up, which is the moment it would
 * have done the most damage: delete three projects, recreate them, and the old rows remain.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { deleteProjectCascade } from '../src/lib/project-delete.ts';

installStubIO();
const ISO = new Date().toISOString();
let n = 0;

function project(): string {
  const id = `pd-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,NULL,?,'','','#fff',?,?)`).run(id, `proj ${id}`, ISO, ISO);
  return id;
}

test('deleting a project removes its cartridge mappings', () => {
  const p = project();
  db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(p, '/r/a');
  db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(p, '/r/b');

  deleteProjectCascade(p);

  const left = db.prepare('SELECT COUNT(*) AS n FROM project_cartridges WHERE project_id = ?')
    .get(p) as { n: number };
  assert.equal(left.n, 0, 'cartridge mappings outlived the project that owned them');
  const gone = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(p) as { n: number };
  assert.equal(gone.n, 0);
});

test('it never touches another project\'s mappings', () => {
  const a = project();
  const b = project();
  db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(a, '/r/mine');
  db.prepare('INSERT INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(b, '/r/theirs');

  deleteProjectCascade(a);

  const survivor = db.prepare('SELECT COUNT(*) AS n FROM project_cartridges WHERE project_id = ?')
    .get(b) as { n: number };
  assert.equal(survivor.n, 1, 'deleting one project took another project\'s mappings with it');
});

test('workflow runs survive, losing only their project attribution', () => {
  // ON DELETE SET NULL is deliberate: run history is worth more than the link. Asserted so a
  // future cascade cannot quietly start deleting completed runs.
  const p = project();
  db.prepare(`INSERT INTO workflows (id, name, status, created_at, template_id, project_id, run_number)
              VALUES ('wf-pd','r','completed',?,'tpl',?,1)`).run(ISO, p);

  deleteProjectCascade(p);

  const wf = db.prepare("SELECT project_id FROM workflows WHERE id = 'wf-pd'").get() as
    { project_id: string | null } | undefined;
  assert.ok(wf, 'the run was deleted along with its project — history must survive');
  assert.equal(wf.project_id, null, 'the dangling project_id was left in place');
});

test('project knowledge is untouched — it is keyed by repo name, not project id', () => {
  // 24 rows live in project_knowledge keyed by `project` (a repo NAME). A cascade that matched
  // on the wrong column would delete accumulated knowledge for a repo that still exists.
  const p = project();
  db.prepare(`INSERT INTO project_knowledge (id, project, filename, content, updated_at)
              VALUES (?,?,?,?,?)`).run(`k-${++n}`, 'gridlight', 'notes.md', 'x', ISO);
  const before = (db.prepare('SELECT COUNT(*) AS n FROM project_knowledge').get() as { n: number }).n;

  deleteProjectCascade(p);

  const after = (db.prepare('SELECT COUNT(*) AS n FROM project_knowledge').get() as { n: number }).n;
  assert.equal(after, before, 'repo-scoped knowledge was destroyed by a project deletion');
});
