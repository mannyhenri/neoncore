// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import db, { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';

const panelSource = readFileSync(fileURLToPath(
  new URL('../../dashboard/src/components/WorkflowPanel.tsx', import.meta.url),
), 'utf8');

test('every standard template has a useful picker description', () => {
  const rows = db.prepare(`
    SELECT name, description FROM workflows
    WHERE template_id IS NULL AND name IN (${STANDARD_TEMPLATE_NAMES.map(() => '?').join(',')})
  `).all(...STANDARD_TEMPLATE_NAMES) as Array<{ name: string; description: string }>;

  assert.equal(rows.length, STANDARD_TEMPLATE_NAMES.length);
  for (const row of rows) {
    assert.ok(row.description.trim().length >= 30, `${row.name} needs a useful description`);
  }
  assert.match(panelSource, /!wf\.templateId && wf\.description/);
});

test('templates are grouped by function with no CE or Jira silo', () => {
  assert.match(panelSource, /type TemplateTab = 'all' \| 'strategy' \| 'planning' \| 'development' \| 'quality' \| 'delivery' \| 'learning'/);
  assert.doesNotMatch(panelSource, /compound:\s*'Compound Eng'/);
  assert.doesNotMatch(panelSource, /jira:\s*'Jira'/);

  for (const name of STANDARD_TEMPLATE_NAMES) {
    assert.match(panelSource, new RegExp(`['\"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]\\s*:`), `${name} lacks a functional category`);
  }
});

test('CE delivery paths include the missing lean error-reduction methods', () => {
  const rows = db.prepare(`
    SELECT w.name, group_concat(s.executor_config, '\n') AS prompts
    FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
    WHERE w.name IN ('CE: Phase 1 — Interrogate', 'CE: Phase 3 — Implement',
                     'CE: Phase 4 — Review', 'CE: Phase 7 — Compound', 'CE: Full Delivery')
      AND w.template_id IS NULL
    GROUP BY w.id, w.name
  `).all() as Array<{ name: string; prompts: string }>;
  const byName = new Map(rows.map((row) => [row.name, row.prompts]));

  for (const name of ['CE: Phase 1 — Interrogate', 'CE: Full Delivery']) {
    assert.match(byName.get(name)!, /ce-prototype/);
    assert.match(byName.get(name)!, /ce-bakeoff/);
  }
  for (const name of ['CE: Phase 3 — Implement', 'CE: Full Delivery']) {
    assert.match(byName.get(name)!, /ce-simplify-code/);
  }
  for (const name of ['CE: Phase 4 — Review', 'CE: Full Delivery']) {
    assert.match(byName.get(name)!, /ce-resolve-pr-feedback/);
  }
  assert.match(byName.get('CE: Phase 7 — Compound')!, /ce-compound-refresh/);
});
