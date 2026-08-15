/**
 * A template's id must survive a server restart.
 *
 * WHAT IT COST. `seedDefaultTemplates()` runs unconditionally at boot and hard-deletes then
 * recreates all 20 standard templates with fresh `randomUUID()`s. Under `tsx watch` — which
 * restarts on every source save — the CE: Full Delivery id churned three times in one
 * afternoon (027b4646 → f4ba5eae → 2910cdb9, each deleted in turn) while the user was trying
 * to launch it. Consequences, all silent:
 *
 *   · every historical run's `template_id` becomes a dangling reference, so "which template
 *     did this run come from" is unanswerable a restart later
 *   · a dashboard holding a template id in its launch modal is holding a dead id — POST to it
 *     returns 404 "Workflow not found", which is what happened mid-investigation
 *   · anything that stores a template id (a heartbeat row, a script, a bookmark) breaks
 *
 * WHY REPLACEMENT ITSELF IS KEPT. The point of reseeding is that template edits in code reach
 * existing databases — the function's own comment says "so schema changes take effect". That
 * is worth keeping. What must not change is the IDENTITY. So the fix preserves the id across
 * the delete/recreate rather than abandoning the refresh, and the tests below assert BOTH: the
 * id is stable AND the content still updates. Asserting only stability would pass on a seeder
 * that stopped doing its job.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { seedDefaultTemplates, STANDARD_TEMPLATE_NAMES } from '../src/db.js';

/** id-by-name for every standard template currently in the database. */
function templateIds(): Map<string, string> {
  const rows = db.prepare(
    "SELECT id, name FROM workflows WHERE template_id IS NULL",
  ).all() as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.name, r.id]));
}

test('the registry is non-empty and matches what actually got seeded', () => {
  // A vacuous name list would make every assertion below pass trivially.
  assert.ok(STANDARD_TEMPLATE_NAMES.length >= 20,
    `expected the 20 standard templates, found ${STANDARD_TEMPLATE_NAMES.length}`);
  const seeded = templateIds();
  const missing = STANDARD_TEMPLATE_NAMES.filter((n) => !seeded.has(n));
  assert.deepEqual(missing, [], `these standard templates were never seeded: ${missing.join(', ')}`);
});

test('EVERY standard template keeps its id across a reseed', () => {
  const before = templateIds();
  seedDefaultTemplates();          // the restart
  const after = templateIds();

  const churned: string[] = [];
  for (const name of STANDARD_TEMPLATE_NAMES) {
    const b = before.get(name);
    const a = after.get(name);
    if (!a) { churned.push(`${name}: vanished after reseed`); continue; }
    if (b && a !== b) churned.push(`${name}: ${b.slice(0, 8)} → ${a.slice(0, 8)}`);
  }
  assert.deepEqual(churned, [],
    `these template ids changed on restart, orphaning every run that referenced them:\n  ${churned.join('\n  ')}`);
});

test('ids stay stable across MANY restarts, not just the first', () => {
  // A fix that stabilises one reseed but drifts on the next is worse than none: it looks
  // correct in a quick check and still breaks overnight across repeated deploys.
  const first = templateIds();
  for (let i = 0; i < 3; i++) seedDefaultTemplates();
  const last = templateIds();
  const churned = STANDARD_TEMPLATE_NAMES
    .filter((n) => first.get(n) && first.get(n) !== last.get(n))
    .map((n) => `${n}: ${first.get(n)!.slice(0, 8)} → ${last.get(n)?.slice(0, 8)}`);
  assert.deepEqual(churned, [], `drifted after repeated restarts:\n  ${churned.join('\n  ')}`);
});

test('a run launched from a template still resolves to it after a restart', () => {
  // The user-visible consequence, asserted end to end rather than by proxy.
  const tplId = templateIds().get('CE: Full Delivery')!;
  assert.ok(tplId, 'CE: Full Delivery must exist for this test to mean anything');

  db.prepare(`INSERT INTO workflows (id, name, status, created_at, template_id, run_number)
              VALUES ('run-stability','CE: Full Delivery','running',?,?,1)`)
    .run(new Date().toISOString(), tplId);

  seedDefaultTemplates();

  const run = db.prepare("SELECT template_id FROM workflows WHERE id = 'run-stability'")
    .get() as { template_id: string };
  const resolved = db.prepare('SELECT name FROM workflows WHERE id = ?').get(run.template_id) as
    { name: string } | undefined;
  assert.ok(resolved, 'the run points at a template id that no longer exists — dangling reference');
  assert.equal(resolved.name, 'CE: Full Delivery');
});

test('reseeding still REFRESHES content — stability must not disable the update', () => {
  // The reason this function exists. Vandalise a template, reseed, and the damage must be gone
  // while the id is untouched.
  const before = templateIds().get('Bug Hunter')!;
  db.prepare("UPDATE workflows SET description = 'VANDALISED' WHERE id = ?").run(before);
  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(before);

  seedDefaultTemplates();

  const after = templateIds().get('Bug Hunter')!;
  assert.equal(after, before, 'the id changed while refreshing');
  const row = db.prepare('SELECT description FROM workflows WHERE id = ?').get(after) as { description: string };
  assert.notEqual(row.description, 'VANDALISED', 'reseeding no longer refreshes template content');
  const steps = db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE workflow_id = ?').get(after) as { n: number };
  assert.ok(steps.n > 0, 'reseeding no longer restores template steps');
});

test('duplicate templates with the same name collapse to ONE stable id', () => {
  // Older databases can hold duplicates from previous seeding runs. Preserving "the" id is
  // only well-defined if the duplicates are cleared, or the id would ping-pong between them.
  const name = 'Bug Hunter';
  const original = templateIds().get(name)!;
  db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES ('dupe-bh',?, 'pending', ?)`)
    .run(name, new Date().toISOString());

  seedDefaultTemplates();

  const rows = db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').all(name) as { id: string }[];
  assert.equal(rows.length, 1, `expected exactly one "${name}" template, found ${rows.length}`);
  assert.equal(rows[0].id, original, 'the surviving template took the duplicate\'s id instead of the established one');
});

test('deprecated templates are still removed', () => {
  // Regression guard on the other half of the seeder, which the fix must not disturb.
  db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES ('dep-1','Refactor','pending',?)`)
    .run(new Date().toISOString());
  seedDefaultTemplates();
  const gone = db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE name = 'Refactor'").get() as { n: number };
  assert.equal(gone.n, 0, 'a deprecated template survived reseeding');
});
