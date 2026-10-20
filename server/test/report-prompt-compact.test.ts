/**
 * THE COMPLETION REPORT IS ONE JSON OBJECT, SENT ONCE.
 *
 * The report step averaged 16.8k chars per dispatch, ~9k of it a fixed spec: write a JSON file,
 * render a 9-section HTML page from it, open a window, POST the JSON with curl, AND pass it again
 * on report_step_done. The user said they barely read the reports, and the dashboard's Reports
 * tab already renders the JSON — the HTML was a second rendering of the same data, paid for in
 * output tokens on every run.
 *
 * The prompt now asks for the fields the app actually reads, delivered once through the tool.
 * SET-BASED: the required fields are read out of the code that consumes them, so a field the
 * dashboard starts showing cannot silently go missing from the prompt.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import db from '../src/db.ts';
import { WORKFLOW_REPORT_PROMPT, buildRunReportContext } from '../src/lib/workflow-report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every report field the dashboard and the server read, from their source. */
function consumedFields(): string[] {
  const panel = readFileSync(resolve(root, 'dashboard/src/components/ProjectMemoryPanel.tsx'), 'utf8');
  const route = readFileSync(resolve(root, 'server/src/routes/workflows.ts'), 'utf8');
  const fields = new Set<string>();
  for (const m of panel.matchAll(/\boutcome\.(\w+)/g)) fields.add(m[1]);
  for (const m of panel.matchAll(/\brep\.(\w+)/g)) fields.add(m[1]);
  for (const m of route.matchAll(/\bheader\??\.(\w+)/g)) fields.add(m[1]);
  return [...fields];
}

test('the prompt names EVERY report field the app reads', () => {
  const fields = consumedFields();
  assert.ok(fields.length >= 6, `expected the known consumed fields, found ${fields.join(', ')}`);
  const missing = fields.filter((f) => !WORKFLOW_REPORT_PROMPT.includes(f));
  assert.deepEqual(missing, [], `the dashboard reads fields the prompt never asks for: ${missing.join(', ')}`);
});

test('the prompt fits its budget', () => {
  assert.ok(WORKFLOW_REPORT_PROMPT.length <= 2600, `${WORKFLOW_REPORT_PROMPT.length} chars`);
});

test('ONE delivery: the report argument of report_step_done — no files, no HTML, no curl', () => {
  assert.match(WORKFLOW_REPORT_PROMPT, /neoncore_report_step_done/);
  assert.match(WORKFLOW_REPORT_PROMPT, /\breport\b/);
  for (const banned of [/curl/i, /\.html\b/i, /<details>/i, /\bxdg-open\b/, /workflow-report\.json/]) {
    assert.doesNotMatch(WORKFLOW_REPORT_PROMPT, banned, `the prompt still asks for ${banned}`);
  }
});

test('the run record no longer carries a curl send-back block', () => {
  const wf = randomUUID(), step = randomUUID(), now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES (?, 'run', 'running', ?)`).run(wf, now);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, position_x, position_y, created_at)
              VALUES (?, ?, 'Report', 'running', 'claude-code', '', '{}', 0, 0, ?)`).run(step, wf, now);
  const ctx = buildRunReportContext(db, wf, step, 'http://neoncore.test');
  assert.ok(ctx.length > 0);
  assert.doesNotMatch(ctx, /curl|SENDING THE REPORT BACK/);
});
