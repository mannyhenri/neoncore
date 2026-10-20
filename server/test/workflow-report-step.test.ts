/**
 * EVERY WORKFLOW TEMPLATE ENDS IN A WORKFLOW COMPLETION REPORT.
 *
 * WHY SET-BASED, AND NOT "check the Bug Hunter template". The failure this guards is the
 * PARTIAL rollout: the helper is written, wired into `/v2/create`, and the 23 templates
 * already sitting in every existing database never get it — or it lands on the templates
 * someone happened to open and not on the rest. An example-based test goes green on the
 * first template and never notices the other 22. So the set is read FROM THE DATABASE
 * (`template_id IS NULL`), which is the same predicate the production pass uses, and a
 * template added next month is covered the day it is seeded.
 *
 * WHY "terminal, and depends on every OTHER terminal step" rather than "is the last row".
 * Templates branch. A report appended to the last row of the array sails past whatever a
 * parallel branch is still doing and reports on a run that has not finished — confidently
 * wrong, which is worse than no report. This is the same property `standard-gate.test.ts`
 * asserts for the work-standard gate, for the same reason.
 *
 * WHY THE ORDERING TEST. `/v2/create` applies both helpers. Reversed, the standard gate
 * becomes terminal-dependent on the report and the report is no longer last — the workflow
 * would render its completion report and THEN be audited. The order is load-bearing and
 * invisible in a diff, so it is asserted through the route itself, not through a
 * hand-composed call.
 */
// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import db from '../src/db.ts';
import { seedDefaultTemplates, STANDARD_TEMPLATE_NAMES } from '../src/db.ts';
import {
  REPORT_STEP_NAME,
  REPORT_STEP_KIND,
  WORKFLOW_REPORT_PROMPT,
  isReportStep,
  reportStepConfig,
  withReportStep,
  ensureReportStepOnTemplates,
} from '../src/lib/workflow-report.ts';
import { withStandardGate, withStandardGateOnTemplateRows } from '../src/routes/workflows.ts';
import workflowsRouter from '../src/routes/workflows.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { REPORT_EXEMPT_TEMPLATES } from '../src/lib/digest-template.ts';

installStubIO();

// ── The set, read from the database ────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const templates = (): Row[] =>
  db.prepare('SELECT * FROM workflows WHERE template_id IS NULL ORDER BY name').all() as Row[];

const stepsOf = (workflowId: string): Row[] =>
  db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ?').all(workflowId) as Row[];

const cfg = (s: Row): Record<string, unknown> => {
  try { return JSON.parse((s.executor_config as string) || '{}'); } catch { return {}; }
};

const deps = (s: Row): string[] => {
  try { return JSON.parse((s.depends_on as string) || '[]'); } catch { return []; }
};

/** A step that can carry the report — the same predicate the helper uses to inherit an executor. */
const WORK_TYPES = new Set(['claude-code', 'command', '']);
const hasWorkStep = (steps: Row[]) =>
  steps.some((s) => WORK_TYPES.has(((s.executor_type as string) || '')));

test('EVERY template in the database ends in a Workflow Completion Report', () => {
  const all = templates();
  assert.ok(all.length >= STANDARD_TEMPLATE_NAMES.length,
    `expected at least the ${STANDARD_TEMPLATE_NAMES.length} standard templates, found ${all.length}`);

  let covered = 0;
  let skippedNoWork = 0;
  let exempt = 0;

  for (const wf of all) {
    const steps = stepsOf(wf.id as string);
    const reports = steps.filter((s) => isReportStep(cfg(s)));

    // A workflow whose own output IS the document gets no report about having produced it.
    // See REPORT_EXEMPT_TEMPLATES — the rule is "one deliverable per run", not "always a report".
    if (REPORT_EXEMPT_TEMPLATES.includes(wf.name as string)) {
      assert.equal(reports.length, 0,
        `"${wf.name}" is report-exempt but still carries a completion report step`);
      exempt++;
      continue;
    }

    if (!hasWorkStep(steps)) {
      // Nothing to report on and no cartridge to inherit — must be left alone, not given a
      // step that dies at dispatch with "no cartridge assigned".
      assert.equal(reports.length, 0,
        `"${wf.name}" has no work step but was given a report step`);
      skippedNoWork++;
      continue;
    }

    assert.equal(reports.length, 1,
      `"${wf.name}" has ${reports.length} report steps, expected exactly 1`);
    const report = reports[0];

    // Terminal: nothing depends on it.
    const dependedOn = new Set<string>();
    for (const s of steps) for (const d of deps(s)) dependedOn.add(d);
    assert.ok(!dependedOn.has(report.id as string),
      `"${wf.name}": something depends on the report step, so it is not last`);

    // Depends on EVERY step that was terminal BEFORE the report was appended. The report's
    // own edges have to be excluded from that set — they are what makes those steps
    // non-terminal now, and counting them would assert the report depends on nothing.
    const dependedOnByOthers = new Set<string>();
    for (const s of steps) {
      if (s.id === report.id) continue;
      for (const d of deps(s)) dependedOnByOthers.add(d);
    }
    const otherTerminals = steps
      .filter((s) => s.id !== report.id && !dependedOnByOthers.has(s.id as string))
      .map((s) => s.id as string)
      .sort();
    assert.deepEqual([...deps(report)].sort(), otherTerminals,
      `"${wf.name}": the report step must wait on every terminal branch`);

    assert.equal(report.name, REPORT_STEP_NAME);
    assert.equal(report.executor_type, 'claude-code');
    const reportConfig = cfg(report);
    if (reportConfig.reportPromptManaged === false) {
      assert.match(String(reportConfig.prompt || ''), /Produce the WORKFLOW COMPLETION REPORT/,
        `"${wf.name}": customized report dropped the shared report delivery contract`);
      if (wf.name === 'Gridlight Local QA') {
        assert.match(String(reportConfig.prompt || ''), /GRIDLIGHT LOCAL QA report/,
          'local QA lost its engine comparison scorecard');
      }
      if (wf.name === 'Gridlight Full Release QA') {
        assert.match(String(reportConfig.prompt || ''), /GRIDLIGHT FULL RELEASE QA report/,
          'release QA lost its artifact and installation matrix');
      }
    } else {
      assert.equal(reportConfig.prompt, WORKFLOW_REPORT_PROMPT);
    }
    assert.equal(reportConfig.reportContext, true,
      `"${wf.name}": without reportContext the report only sees its direct dependencies`);
    covered++;
  }

  console.log(`[set] ${covered}/${all.length} templates carry a report step `
    + `(${skippedNoWork} skipped: no work step, ${exempt} exempt: the run's own output is the deliverable)`);
  // THREE categories now, not two. Every template is accounted for by exactly one of them —
  // a template falling through all three would be silently uncovered, which is the failure
  // this whole file exists to catch.
  assert.equal(covered + skippedNoWork + exempt, all.length);
  assert.equal(exempt, REPORT_EXEMPT_TEMPLATES.filter((n) => all.some((w) => w.name === n)).length,
    'an exempt template was counted somewhere other than the exempt branch');
  assert.ok(covered >= STANDARD_TEMPLATE_NAMES.length - exempt,
    `only ${covered} templates covered; expected at least ${STANDARD_TEMPLATE_NAMES.length - exempt}`);
});

test('the pass is idempotent — re-seeding and re-running adds nothing', () => {
  const before = templates().map((wf) => stepsOf(wf.id as string).filter((s) => isReportStep(cfg(s))).length);
  ensureReportStepOnTemplates(db);
  ensureReportStepOnTemplates(db);
  const after = templates().map((wf) => stepsOf(wf.id as string).filter((s) => isReportStep(cfg(s))).length);
  assert.deepEqual(after, before, 'a second pass duplicated report steps');

  // A boot re-seeds the standard templates from scratch; the pass must re-cover them.
  seedDefaultTemplates();
  ensureReportStepOnTemplates(db);
  const afterReseed = templates().map((wf) => stepsOf(wf.id as string).filter((s) => isReportStep(cfg(s))).length);
  assert.deepEqual(afterReseed, before, 're-seeding lost or duplicated the report step');
});

test('a user-created template already in the database gets one too', () => {
  const wfId = 'user-made-wf';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at)
              VALUES (?, 'Hand Rolled', '', 'pending', '[]', ?, '')`).run(wfId, now);
  const insert = db.prepare(`INSERT INTO workflow_steps
    (id, workflow_id, name, description, position_x, position_y, executor_type, executor_id,
     executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, '', 300, ?, 'claude-code', '__deferred__', '{}', 1, ?, ?)`);
  insert.run('umw-1', wfId, 'Do the thing', 0, '[]', now);
  insert.run('umw-2', wfId, 'Do the other thing', 175, '[]', now);

  ensureReportStepOnTemplates(db);

  const reports = stepsOf(wfId).filter((s) => isReportStep(cfg(s)));
  assert.equal(reports.length, 1);
  // Both hand-rolled steps are terminal, so the report waits on both.
  assert.deepEqual([...deps(reports[0])].sort(), ['umw-1', 'umw-2']);
  assert.ok((reports[0].position_y as number) > 175, 'the report must sit below the last step');

  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(wfId);
  db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);
});

test('an EXISTING report step is refreshed, not left on a stale prompt', () => {
  // THE DRIFT THIS CATCHES. The pass skipped any template that already carried the marker, so
  // improving the prompt reached the 23 standard templates — seedDefaultTemplates deletes and
  // re-inserts their steps every boot — and never reached a USER-created template, which keeps
  // whatever prompt it was given the day it was made. Found in the live database: 23 of 24
  // report steps had the current prompt and the one hand-built template had last month's.
  const wfId = 'stale-user-wf';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at)
              VALUES (?, 'Stale Hand Rolled', '', 'pending', '[]', ?, '')`).run(wfId, now);
  const insert = db.prepare(`INSERT INTO workflow_steps
    (id, workflow_id, name, description, position_x, position_y, executor_type, executor_id,
     executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, '', 300, ?, 'claude-code', ?, ?, 1, ?, ?)`);
  insert.run('su-1', wfId, 'Work', 0, '__deferred__', '{}', '[]', now);
  // A report step as an older build wrote it: stale prompt, pinned cartridge, and stale edges.
  insert.run('su-r', wfId, REPORT_STEP_NAME, 175, 'cartridge-pinned-by-user',
    JSON.stringify({ stepKind: REPORT_STEP_KIND, reportContext: true, prompt: 'LAST MONTH PROMPT' }),
    JSON.stringify(['su-1']), now);
  // …and then the user added another step, which is now terminal and unwatched by the report.
  insert.run('su-2', wfId, 'Added Later', 350, '__deferred__', '{}', '[]', now);

  const refreshed = ensureReportStepOnTemplates(db);
  assert.ok(refreshed >= 0);

  const reports = stepsOf(wfId).filter((s) => isReportStep(cfg(s)));
  assert.equal(reports.length, 1, 'refreshing must not add a second report step');
  const r = reports[0];
  assert.equal(r.id, 'su-r', 'the step was replaced instead of refreshed — its id must survive');
  assert.equal(cfg(r).prompt, WORKFLOW_REPORT_PROMPT, 'the stale prompt was left in place');
  assert.equal(r.executor_id, 'cartridge-pinned-by-user',
    'refreshing clobbered the cartridge the user pinned');
  assert.deepEqual([...deps(r)].sort(), ['su-1', 'su-2'],
    'the report must pick up a branch the user added after it');
  assert.ok((r.position_y as number) > 350, 'the report must stay below the last step');

  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(wfId);
  db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);
});

test('EVERY template carries the CURRENT prompt, not whatever it was seeded with', () => {
  const all = templates();
  let checked = 0;
  for (const wf of all) {
    for (const s of stepsOf(wf.id as string)) {
      if (!isReportStep(cfg(s))) continue;
      const reportConfig = cfg(s);
      if (reportConfig.reportPromptManaged === false) {
        assert.match(String(reportConfig.prompt || ''), /Produce the WORKFLOW COMPLETION REPORT/,
          `"${wf.name}" customized report dropped the shared report delivery contract`);
      } else {
        assert.equal(reportConfig.prompt, WORKFLOW_REPORT_PROMPT,
          `"${wf.name}" is running a stale copy of the report prompt`);
      }
      checked++;
    }
  }
  console.log(`[set] ${checked}/${all.length} templates carry the current prompt`);
  assert.ok(checked > 0);
});

// ── withReportStep, as a pure function (mirrors standard-gate.test.ts) ──────────────────

type Step = Record<string, unknown>;

const work = (id: string, deps: string[] = [], executorId = 'agent-1'): Step => ({
  id, name: `Work ${id}`, executorType: 'claude-code', executorId, dependsOn: deps,
});

const reportOf = (steps: Step[]) => steps.find((s) => isReportStep(s.executorConfig as Record<string, unknown>));

test('withReportStep appends a report at the end', () => {
  const out = withReportStep([work('a'), work('b', ['a'])]);
  assert.equal(out.length, 3);
  const r = reportOf(out)!;
  assert.ok(r, 'no report step was appended');
  assert.equal(r.executorType, 'claude-code');
  assert.equal(r.name, REPORT_STEP_NAME);
  assert.deepEqual(r.dependsOn, ['b']);
  assert.equal((r.executorConfig as Record<string, unknown>).stepKind, REPORT_STEP_KIND);
});

test('the report waits on EVERY terminal branch, not just the last step', () => {
  const out = withReportStep([work('a'), work('b', ['a']), work('c', ['a'])]);
  assert.deepEqual([...(reportOf(out)!.dependsOn as string[])].sort(), ['b', 'c']);
});

test('the report inherits an executor so it can actually be dispatched', () => {
  assert.equal(reportOf(withReportStep([work('a', [], 'cartridge-9')]))!.executorId, 'cartridge-9');
});

test('calling withReportStep twice adds exactly one step', () => {
  const once = withReportStep([work('a'), work('b', ['a'])]);
  const twice = withReportStep(once);
  assert.equal(twice.length, once.length, 'a second call duplicated the report step');
  assert.equal(twice.filter((s) => isReportStep(s.executorConfig as Record<string, unknown>)).length, 1);
});

test('report step ids are unique across calls so two workflows never collide', () => {
  assert.notEqual(
    reportOf(withReportStep([work('a')]))!.id,
    reportOf(withReportStep([work('a')]))!.id,
  );
});

test('the report never depends on itself', () => {
  const r = reportOf(withReportStep([work('a'), work('b', ['a'])]))!;
  assert.ok(!(r.dependsOn as string[]).includes(r.id as string));
});

test('a workflow with no work steps is left alone', () => {
  const steps = [{ id: 'c', executorType: 'connector', dependsOn: [] }];
  assert.deepEqual(withReportStep(steps), steps);
});

test('opting out leaves the steps untouched', () => {
  const steps = [work('a')];
  assert.deepEqual(withReportStep(steps, { skip: true }), steps);
});

test('the report sits AFTER the work-standard gate when both are applied', () => {
  const composed = withReportStep(withStandardGate([work('a'), work('b', ['a'])]));
  const gate = composed.find((s) => (s.executorConfig as Record<string, unknown> | undefined)?.gateType === 'standard')!;
  const report = reportOf(composed)!;
  assert.ok((report.dependsOn as string[]).includes(gate.id as string),
    'the report must wait for the standard gate');
  assert.ok(!(gate.dependsOn as string[]).includes(report.id as string),
    'the gate must not depend on the report — that would put the audit last, not the report');
});

test('template cloning inserts the system gate between authored work and report', () => {
  const rows = [
    { id: 'run', executor_type: 'claude-code', executor_id: 'agent-1', executor_config: '{}', depends_on: '[]' },
    { id: 'report', executor_type: 'claude-code', executor_id: 'agent-1',
      executor_config: JSON.stringify(reportStepConfig()), depends_on: JSON.stringify(['run']) },
  ];
  const composed = withStandardGateOnTemplateRows(rows);
  assert.equal(composed.length, 3);
  assert.equal(composed[1].executor_type, 'quality-gate');
  assert.deepEqual(JSON.parse(String(composed[1].depends_on)), ['run']);
  assert.deepEqual(JSON.parse(String(composed[2].depends_on)), [composed[1].id]);
  assert.equal(isReportStep(JSON.parse(String(composed[2].executor_config))), true);
});

// ── The order through the real route, which is where it can silently invert ─────────────

let base = '';
let server: Server;

test('POST /v2/create puts the report last, after the standard gate', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', workflowsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/workflows/v2/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Route Order Check',
      steps: [
        { id: 'a', name: 'A', executorType: 'claude-code', executorId: 'agent-1', dependsOn: [] },
        { id: 'b', name: 'B', executorType: 'claude-code', executorId: 'agent-1', dependsOn: ['a'] },
        { id: 'c', name: 'C', executorType: 'claude-code', executorId: 'agent-1', dependsOn: ['a'] },
      ],
    }),
  });
  assert.equal(res.status, 201);
  const { steps } = await res.json() as { steps: { id: string; name: string; executorType: string; executorConfig: Record<string, unknown>; dependsOn: string[] }[] };

  const report = steps.find((s) => isReportStep(s.executorConfig))!;
  const gate = steps.find((s) => s.executorConfig?.gateType === 'standard')!;
  assert.ok(report, 'the route created no report step');
  assert.ok(gate, 'the route created no standard gate');

  // The gate waits on both branches; the report waits on the gate and on nothing else.
  assert.deepEqual(report.dependsOn, [gate.id]);
  assert.ok(!gate.dependsOn.includes(report.id));

  // And the report is genuinely terminal in the persisted graph.
  const dependedOn = new Set(steps.flatMap((s) => s.dependsOn));
  assert.ok(!dependedOn.has(report.id), 'something depends on the report step');
});
