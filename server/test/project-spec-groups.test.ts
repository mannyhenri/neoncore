/**
 * An executive reads the spec as a handful of capability groups, not a flat list of 80 features.
 *
 * Generate with AI used to keep each feature's `area` only as prose in its description ("Area:
 * Gateway · Routing & engines."), so the Spec tab and docs/product/README.md listed every feature
 * in one long run. These tests hold the whole chain to the grouping, over every feature and group:
 *   proposal  → at most MAX_FEATURE_GROUPS top-level groups (the smallest fold into "Other")
 *   apply     → each kept feature's area recorded on the feature, each group's summary on the project
 *   spec      → the groups partition the features exactly; every feature sits in its area's group
 *   markdown  → a heading per group
 *   backfill  → features imported before the column existed get their area back from the description
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  normalizeImport, createImportRow, submitImport, applyImport, backfillFeatureAreas, groupOf, MAX_FEATURE_GROUPS,
} from '../src/lib/project-import.ts';
import { buildProjectSpec, renderSpecMarkdown } from '../src/lib/project-spec.ts';
import { createFeature } from '../src/routes/goals.ts';

installStubIO();
const ISO = new Date().toISOString();
let n = 0;
function project(): string {
  const id = `psg-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,NULL,?,'','','#fff',?,?)`).run(id, `proj ${id}`, ISO, ISO);
  return id;
}

// 14 top-level groups of shrinking size (8, 8, 7, 7, … 2, 2 = 70 features, under the 80 cap), each split into two sub-areas.
const GROUPS = Array.from({ length: 14 }, (_, i) => ({ name: `Group ${String.fromCharCode(65 + i)}`, size: 8 - Math.floor(i / 2) }));
const FEATURES = GROUPS.flatMap((g) => Array.from({ length: g.size }, (_, j) => ({
  name: `${g.name} feature ${j + 1}`, description: `does ${j + 1}`, area: `${g.name} · Sub ${j % 2 ? 'odd' : 'even'}`,
  evidence: 'src/x.ts', criteria: [{ text: 'When x, the system shall y.', expect: 'x → y' }],
})));
const AREAS = GROUPS.map((g) => ({ name: g.name, summary: `What ${g.name} does for the business.` }));

test('a proposal keeps at most MAX_FEATURE_GROUPS top-level groups, folding the smallest into Other', () => {
  const total = FEATURES.length;
  assert.equal(GROUPS.length, 14);
  const out = normalizeImport({ features: FEATURES, areas: AREAS }, { listed: [], parts: ['features'] });
  assert.ok(out.value, out.error);
  const groups = new Set(out.value!.features.map((f) => groupOf(f.area)));
  assert.ok(groups.size <= MAX_FEATURE_GROUPS, `${groups.size} groups survived — more than ${MAX_FEATURE_GROUPS}`);
  assert.equal(out.value!.features.length, total, 'folding groups must not drop features');
  for (const f of out.value!.features) assert.ok(f.area, `"${f.name}" lost its area`);
  for (const g of groups) {
    if (g === 'Other') continue;
    assert.ok(out.value!.areas.some((a) => a.name === g && a.summary), `group "${g}" lost its summary`);
  }
  assert.ok(out.notes.some((x) => /folded/.test(x)), 'folding must be said in the notes');
});

test('applying records every kept feature\'s area, and the spec groups partition the features', () => {
  const pid = project();
  createFeature({ projectId: pid, name: 'Planned without an area' });
  const imp = createImportRow(pid, 'agent-x', ['features']);
  const ready = submitImport(imp.id, { features: FEATURES, areas: AREAS });
  const proposed = ready.proposal!.features;
  applyImport(imp.id, { features: proposed.map((f) => f.name) });

  const spec = buildProjectSpec(pid)!;
  const byName = new Map(spec.features.map((f) => [f.name, f]));
  for (const f of proposed) assert.equal(byName.get(f.name)?.area, f.area, `"${f.name}" has the wrong area on the spec`);

  // Every feature in exactly one group, and in the group its area names.
  const seen = new Map<string, string>();
  for (const g of spec.groups) {
    for (const s of g.sections) for (const id of s.featureIds) {
      assert.ok(!seen.has(id), `feature ${id} is in two groups`);
      seen.set(id, g.name);
    }
  }
  assert.equal(seen.size, spec.features.length, 'some features are in no group');
  for (const f of spec.features) assert.equal(seen.get(f.id), groupOf(f.area) || 'Unsorted', `"${f.name}" is in the wrong group`);

  for (const g of spec.groups) {
    if (g.name === 'Unsorted' || g.name === 'Other') continue;
    assert.equal(g.summary, `What ${g.name} does for the business.`, `group "${g.name}" lost its summary on the way to the spec`);
  }

  const md = renderSpecMarkdown(spec);
  for (const g of spec.groups) assert.ok(md.includes(`### ${g.name}`), `the spec markdown has no heading for "${g.name}"`);
});

test('features imported before areas were stored get their area back from the description', () => {
  const pid = project();
  const ids = ['Gateway · Routing & engines', 'Work · Chat', 'Licence server · Billing'].map((area, i) => {
    const id = createFeature({ projectId: pid, name: `old ${i}`, description: `Does a thing. Area: ${area}. Where: src/a.ts`, status: 'achieved' });
    db.prepare("UPDATE goals SET origin = 'imported' WHERE id = ?").run(id);
    return { id, area };
  });
  backfillFeatureAreas();
  for (const { id, area } of ids) {
    const r = db.prepare('SELECT area, description FROM goals WHERE id = ?').get(id) as { area: string; description: string };
    assert.equal(r.area, area);
    assert.ok(!r.description.includes('Area:'), 'the area text should leave the description once it has its own field');
  }
});
