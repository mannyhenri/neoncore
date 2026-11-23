// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import db from '../src/db.ts';
import { STANDARD_TEMPLATE_NAMES, NO_STANDARD_GATE_TEMPLATES, RETIRED_TEMPLATE_NAMES, runStandardTemplateSeed } from '../src/lib/templates/index.ts';
import { NOT_PER_FEATURE } from '../src/lib/feature-stages.ts';

/**
 * REQUESTED: "maybe we should drop the CE: Phase 1 Interrogate altogether in the workflows since
 * we're using this process in every feature". Feature scoping asks the person the questions and
 * writes the brief every stage receives — Phase 1 was the same interrogation run a second time,
 * by an agent answering its own questions.
 */
const PHASE_1 = 'CE: Phase 1 — Interrogate';
const templateRows = (name: string) =>
  db.prepare('SELECT id FROM workflows WHERE name = ? AND template_id IS NULL').all(name) as { id: string }[];

test('Phase 1 is no standard template and is not seeded', () => {
  assert.ok(!(STANDARD_TEMPLATE_NAMES as readonly string[]).includes(PHASE_1));
  assert.ok(!(NO_STANDARD_GATE_TEMPLATES as readonly string[]).includes(PHASE_1));
  assert.equal(NOT_PER_FEATURE[PHASE_1], undefined, 'nothing left to refuse — it no longer exists');
  assert.equal(templateRows(PHASE_1).length, 0);
});

test('an existing database loses its Phase 1 template on boot; past runs are kept', () => {
  assert.ok(RETIRED_TEMPLATE_NAMES.includes(PHASE_1));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at) VALUES ('old-p1', ?, 'x', 'pending', '[]', ?, '')").run(PHASE_1, now);
  db.prepare("INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at, template_id) VALUES ('old-p1-run', ?, 'x', 'cancelled', '[]', ?, '', 'old-p1')").run(PHASE_1, now);
  db.transaction(() => runStandardTemplateSeed(db))();
  assert.equal(templateRows(PHASE_1).length, 0);
  assert.ok(db.prepare("SELECT 1 FROM workflows WHERE id = 'old-p1-run'").get(), 'a past run is history, not a template');
});

test('Phase 2 plans from the scope NeonCore hands it, not from a Phase 1 brainstorm doc', () => {
  const rows = db.prepare(`SELECT s.name, s.description, s.executor_config FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
                           WHERE w.name = 'CE: Phase 2 — Plan' AND w.template_id IS NULL`).all() as { name: string; description: string; executor_config: string }[];
  assert.ok(rows.length > 0);
  const all = rows.map((r) => `${r.name}\n${r.description}\n${r.executor_config}`).join('\n');
  assert.doesNotMatch(all, /Phase 1/);
  const first = rows.find((r) => /Load/.test(r.name))!;
  assert.match(first.executor_config, /scope/i);
  assert.match(first.executor_config, /if docs\/\[slug\]\/brainstorm\.md exists/i, 'an old brainstorm is still read when there is one');
  // The cheap evidence methods Phase 1 carried move to where the approach is now chosen.
  assert.match(all, /ce-prototype/);
  assert.match(all, /ce-bakeoff/);
});

test('no template, and no picker, still names Phase 1', () => {
  const prompts = db.prepare("SELECT s.executor_config, s.description FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id WHERE w.template_id IS NULL").all() as { executor_config: string; description: string }[];
  for (const p of prompts) assert.doesNotMatch(`${p.description}${p.executor_config}`, /from Phase 1|Phase 1 —/);
  for (const f of ['../../dashboard/src/components/WorkflowPanel.tsx', '../../dashboard/src/lib/demoTemplates.ts']) {
    assert.doesNotMatch(readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'), /Phase 1 — Interrogate/, f);
  }
});
