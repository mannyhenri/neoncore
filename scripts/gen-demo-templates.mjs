#!/usr/bin/env node
/**
 * Regenerate dashboard/src/lib/demoTemplates.ts from the live template library.
 *
 * Demo mode shows the real workflow library so a demo conveys what the product actually does.
 * Names, descriptions and step sequences only — product content, never anybody's data. Run
 * after changing the template seed, or the demo portrays a library that no longer exists.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(root, 'server/neoncore.db'), { readonly: true });

const tpls = db.prepare(
  'SELECT id, name, description FROM workflows WHERE template_id IS NULL ORDER BY name',
).all();
const stepsFor = db.prepare(
  'SELECT name FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
);

const entries = tpls.map((t, i) => ({
  id: `demo-tpl-${i + 1}`,
  name: t.name,
  description: (t.description || '').trim(),
  stepNames: stepsFor.all(t.id).map((s) => s.name),
}));

const j = (v) => JSON.stringify(v);
const body = entries.map((e) => [
  '  {',
  `    id: ${j(e.id)},`,
  `    name: ${j(e.name)},`,
  `    description: ${j(e.description)},`,
  `    stepNames: ${j(e.stepNames)},`,
  '  },',
].join('\n')).join('\n');

writeFileSync(path.join(root, 'dashboard/src/lib/demoTemplates.ts'), `/**
 * THE TEMPLATE LIBRARY, AS IT ACTUALLY IS.
 *
 * Demo mode previously shipped runs but no templates, so the workflow library — the thing a
 * demo most needs to show — came up empty. Asked for as "copy all the workflow templates from
 * our live DB so we can get an idea of what is there".
 *
 * These are the REAL names, descriptions and step sequences, snapshotted from the library.
 * They are product content, not anybody's data: no repo paths, no tickets, no transcripts. The
 * ids are demo ids, so nothing here can address a real template.
 *
 * GENERATED, not hand-written. Regenerate after changing the template seed:
 *   node scripts/gen-demo-templates.mjs
 * Hand-editing it would make it drift from the library it exists to portray, which is the one
 * thing that would make it worse than having no templates at all.
 */

export interface DemoTemplate {
  id: string;
  name: string;
  description: string;
  stepNames: string[];
}

export const DEMO_TEMPLATES: DemoTemplate[] = [
${body}
];
`);
console.log(`wrote demoTemplates.ts — ${entries.length} templates, ${entries.reduce((n, e) => n + e.stepNames.length, 0)} steps`);
