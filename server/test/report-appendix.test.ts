/**
 * ONE RUN, ONE DELIVERABLE — and for most workflows that deliverable is the completion report.
 *
 * A step that produces a file can ride at the end of the report via `reportAppendix`, read at
 * RUN time by buildRunReportContext rather than baked into the report prompt, because
 * ensureReportStepOnTemplates rewrites that prompt on every boot.
 *
 * ── THE DIGEST NO LONGER USES IT, AND THAT IS THE POINT ──────────────────────────────
 * The Daily AI Research Digest was this mechanism's only user: it wrote the digest, declared
 * it as an appendix, and did NOT open it, so the report was the one window. Reported back:
 * "we only want to see the digest at the end, not the report that we do for all the other
 * workflows on top of it." For a workflow whose entire output is a document, a report ABOUT
 * having produced that document is the second deliverable, not the first. The digest is now
 * the report — see REPORT_EXEMPT_TEMPLATES — so it opens its own window and declares no
 * appendix.
 *
 * That leaves the appendix mechanism with no template using it. It is still correct and still
 * tested, against a SYNTHETIC template built here, because a test whose only fixture was the
 * digest would now pass vacuously and nobody would notice the mechanism had rotted.
 *
 * SET-BASED over every template in the database for the window rule, since the exemption is
 * what makes it interesting: an exempt template MUST open, every other work step must not.
 */
// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import db from '../src/db.ts';
import { buildRunReportContext, isReportStep, REPORT_APPENDIX_KEY } from '../src/lib/workflow-report.ts';
import { REPORT_EXEMPT_TEMPLATES } from '../src/lib/digest-template.ts';

type Row = Record<string, unknown>;

const templates = (): Row[] =>
  db.prepare('SELECT * FROM workflows WHERE template_id IS NULL ORDER BY name').all() as Row[];

const stepsOf = (workflowId: string): Row[] =>
  db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Row[];

const cfg = (s: Row): Record<string, unknown> => {
  try { return JSON.parse((s.executor_config as string) || '{}'); } catch { return {}; }
};

const appendixOf = (s: Row) => cfg(s)[REPORT_APPENDIX_KEY] as { title: string; path: string } | undefined;

// A step prompt that opens a file in a window of its own.
const OPENS_A_WINDOW = /\bOPEN IT\b|\n\s*macOS\s+open\s|\bxdg-open\b/;

/** Clone a template into a run the way the executor sees it: same steps, same configs. */
function runOf(tpl: Row): { runId: string; reportStepId: string } {
  const runId = randomUUID();
  db.prepare(`INSERT INTO workflows (id, name, status, created_at, template_id, run_number)
              VALUES (?, ?, 'running', ?, ?, 1)`).run(runId, tpl.name, new Date().toISOString(), tpl.id);
  let reportStepId = '';
  for (const s of stepsOf(tpl.id as string)) {
    const id = randomUUID();
    if (isReportStep(cfg(s))) reportStepId = id;
    db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
                  executor_type, executor_id, executor_config, auto_advance, depends_on, created_at, status)
                VALUES (?, ?, ?, '', 0, ?, ?, '', ?, 1, '[]', ?, 'completed')`)
      .run(id, runId, s.name, s.position_y, s.executor_type, s.executor_config, new Date().toISOString());
  }
  return { runId, reportStepId };
}

test('the digest IS the deliverable — its own window, no appendix, no report', () => {
  const digest = templates().find((t) => t.name === 'Daily AI Research Digest');
  assert.ok(digest, 'Daily AI Research Digest template is missing');
  const steps = stepsOf(digest!.id as string);

  assert.deepEqual(steps.filter(appendixOf).map((s) => s.name), [],
    'the digest still declares a report appendix, which only made sense while a completion '
    + 'report was going to embed it');
  assert.deepEqual(steps.filter((s) => isReportStep(cfg(s))).map((s) => s.name), [],
    'the digest still ends in a completion report — two documents for one run');

  const opens = steps.filter((s) => OPENS_A_WINDOW.test(String(cfg(s).prompt || '')));
  assert.equal(opens.length, 1,
    `exactly one digest step must open the page; ${opens.length} do (${opens.map((s) => s.name).join(', ')})`);
  assert.equal(opens[0].name, 'Render the Digest');
});

test('only the report opens a window — unless the template IS its own document', () => {
  for (const tpl of templates()) {
    // An exempt template has no report to open, so its own document has to. Skipping the rule
    // for it is the exemption; applying the rule everywhere else is what stops a run landing
    // as several windows again.
    if (REPORT_EXEMPT_TEMPLATES.includes(tpl.name as string)) continue;
    for (const s of stepsOf(tpl.id as string)) {
      if (isReportStep(cfg(s))) continue;
      const prompt = String(cfg(s).prompt || '');
      assert.doesNotMatch(prompt, OPENS_A_WINDOW, `${tpl.name} → "${s.name}" opens its own window`);
    }
  }
});

test('every exempt template opens exactly one window of its own', () => {
  for (const name of REPORT_EXEMPT_TEMPLATES) {
    const tpl = templates().find((t) => t.name === name);
    assert.ok(tpl, `exempt template "${name}" is not in the database`);
    const opens = stepsOf(tpl!.id as string)
      .filter((s) => OPENS_A_WINDOW.test(String(cfg(s).prompt || '')));
    assert.equal(opens.length, 1,
      `"${name}" is exempt from the completion report, so exactly one of its own steps must `
      + `open the deliverable; ${opens.length} do`);
  }
});

/**
 * A template that DOES use the appendix mechanism.
 *
 * Built here because no shipped template uses it any more: the digest was its only user and
 * now opens its own window instead. Without this fixture the two invariants below would pass
 * by having nothing to check, which is how a mechanism quietly stops working.
 */
function syntheticAppendixTemplate(): Row {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, description, status, created_at)
              VALUES (?, 'Synthetic Appendix Template', '', 'pending', ?)`).run(id, now);
  const work = randomUUID();
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
                executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
              VALUES (?, ?, 'Produce the File', '', 300, 50, 'claude-code', '__deferred__', ?, 1, '[]', ?)`)
    .run(work, id, JSON.stringify({
      prompt: 'Write the artifact. Do not open it.',
      [REPORT_APPENDIX_KEY]: { title: 'Synthetic Artifact', path: '.neoncore/synthetic/out.html' },
    }), now);
  const rep = randomUUID();
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
                executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
              VALUES (?, ?, 'Workflow Completion Report', '', 300, 330, 'claude-code', '__deferred__', ?, 1, ?, ?)`)
    .run(rep, id, JSON.stringify({ stepKind: 'workflow-report', reportContext: true, prompt: 'report' }),
         JSON.stringify([work]), now);
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Row;
}

test('a template that appends to its report sends no separate notification', () => {
  syntheticAppendixTemplate();
  const carrying = templates().filter((t) => stepsOf(t.id as string).some(appendixOf));
  assert.ok(carrying.length > 0, 'not even the synthetic fixture carries an appendix');
  for (const tpl of carrying) {
    const notifies = stepsOf(tpl.id as string).filter((s) => cfg(s).connectorType === 'system-notify');
    assert.deepEqual(notifies.map((s) => s.name), [], `${tpl.name} still notifies separately`);
  }
});

test('every appendix reaches the report prompt; templates without one get none', () => {
  syntheticAppendixTemplate();
  let withCount = 0;
  for (const tpl of templates()) {
    const appendices = stepsOf(tpl.id as string).map(appendixOf).filter(Boolean) as { title: string; path: string }[];
    const { runId, reportStepId } = runOf(tpl);
    if (!reportStepId) continue;
    const context = buildRunReportContext(db, runId, reportStepId, 'http://neoncore.test');
    if (appendices.length === 0) {
      assert.doesNotMatch(context, /### APPENDIX/, `${tpl.name} got an appendix it never declared`);
      continue;
    }
    withCount++;
    assert.match(context, /### APPENDIX/, `${tpl.name}: appendix missing from the run record`);
    for (const a of appendices) {
      assert.ok(context.includes(a.title), `${tpl.name}: appendix title "${a.title}" missing`);
      assert.ok(context.includes(a.path), `${tpl.name}: appendix path "${a.path}" missing`);
    }
    // The appendix instruction must come before the send-back block, which ends the context.
    assert.ok(context.indexOf('### APPENDIX') < context.indexOf('### SENDING THE REPORT BACK'));
  }
  assert.ok(withCount > 0,
    'no template with an appendix produced a run record — the mechanism is untested, not merely unused');
});
