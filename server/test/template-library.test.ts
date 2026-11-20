/**
 * THE TEMPLATE LIBRARY, AS A SET.
 *
 * Reported as "the dev list gets even more convoluted, there's probably two or three doing the
 * same but one does it better" — and measuring it found something worse than duplication.
 *
 * `CI/CD Pipeline` and `New Feature` had FIVE and ONE agent steps respectively with **no prompt
 * at all** — nothing but a step name. A `claude-code` step with no prompt falls back to
 * `step.description || step.name` (workflow-executor-v2.ts), so launching one dispatched the
 * literal string "Develop" to a cartridge and called it a workflow. They were indistinguishable
 * from the real templates on the picker, which is most of why the list read as convoluted: two
 * of the entries were labels.
 *
 * THE BAR THIS FILE ENFORCES: every agent step of every standard template carries a real
 * prompt. It is set-based over STANDARD_TEMPLATE_NAMES and over each template's own steps, so a
 * template added next month is held to it without anyone remembering to add a test — which is
 * exactly how these two survived.
 *
 * Counted, not sampled: "some templates have prompts" was true before this and is the state
 * being fixed.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';
import { CONFER_EPIC_LINE } from '../src/lib/templates/confer.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

type Step = { name: string; executor_type: string; executor_config: string; auto_advance: number };

const templateNamed = (name: string) =>
  db.prepare('SELECT id, name FROM workflows WHERE template_id IS NULL AND name = ?')
    .get(name) as { id: string; name: string } | undefined;

const stepsOf = (id: string) =>
  db.prepare(
    'SELECT name, executor_type, executor_config, auto_advance FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(id) as Step[];

const cfg = (s: Step): Record<string, unknown> => {
  try { return JSON.parse(s.executor_config || '{}'); } catch { return {}; }
};

/** Step types that dispatch a prompt to a model and therefore need one. */
const NEEDS_PROMPT = new Set(['claude-code', 'confer', 'deliberation']);
const isReport = (s: Step) => cfg(s).stepKind === 'workflow-report';

// ── The bar ────────────────────────────────────────────────────────────────────────────

test('EVERY agent step of EVERY standard template carries a real prompt', () => {
  let templates = 0, agentSteps = 0;
  const bare: string[] = [];

  for (const name of STANDARD_TEMPLATE_NAMES) {
    const tpl = templateNamed(name);
    assert.ok(tpl, `"${name}" is in STANDARD_TEMPLATE_NAMES but seeds no template`);
    templates++;
    for (const s of stepsOf(tpl.id)) {
      if (!NEEDS_PROMPT.has(s.executor_type) || isReport(s)) continue;
      agentSteps++;
      const prompt = String(cfg(s).prompt ?? '').trim();
      // 40 chars: shorter than any real instruction and longer than a step name, so it
      // separates "someone wrote this" from "the name leaked into the prompt slot".
      if (prompt.length < 40) bare.push(`${name} / ${s.name} (${prompt.length} chars)`);
    }
  }

  assert.deepEqual(bare, [],
    `${bare.length} agent step(s) would dispatch their own NAME to a cartridge:\n  ${bare.join('\n  ')}`);
  console.log(`[set] ${templates}/${STANDARD_TEMPLATE_NAMES.length} templates · ${agentSteps} agent steps all carry a real prompt`);
});

test('the registry and the database agree — no template seeds that nobody declared', () => {
  const inDb = (db.prepare(
    "SELECT name FROM workflows WHERE template_id IS NULL",
  ).all() as { name: string }[]).map((r) => r.name);
  const undeclared = inDb.filter((n) => !(STANDARD_TEMPLATE_NAMES as readonly string[]).includes(n));
  assert.deepEqual(undeclared, [],
    `seeded but not in STANDARD_TEMPLATE_NAMES: ${undeclared.join(', ')} — the delete loop only ` +
    'visits declared names, so these can never be updated or removed again');
});

// ── The two shells are gone, and stay gone ─────────────────────────────────────────────

const RETIRED_TEMPLATES = [
  'CI/CD Pipeline', 'New Feature',
  // Removed as duplicates: Full Delivery copied the seven CE phases, Spec Intake overlapped
  // Feature Validation. Merged: Epic: Confer Across Repos into Confer, the two QA templates
  // into Super QA.
  'CE: Full Delivery', 'Spec Intake → Dev Spec', 'Epic: Confer Across Repos', 'Full QA Review', 'Code Review & Audit',
  // Removed as no longer wanted.
  'Daily AI Research Digest', 'Daily AI Filmmaking Digest',
];

test('the promptless shells are retired AND deprecated, not merely unlisted', () => {
  for (const name of RETIRED_TEMPLATES) {
    assert.ok(!(STANDARD_TEMPLATE_NAMES as readonly string[]).includes(name),
      `"${name}" is still declared`);
    assert.equal(templateNamed(name), undefined, `"${name}" still seeds a template`);
  }
  // Unlisting alone is not removal: seedDefaultTemplates' delete loop only visits declared
  // names, so an unlisted template lingers in every EXISTING database forever. That is what
  // `deprecatedNames` is for, and forgetting it is invisible on a fresh database.
  const src = read('server/src/lib/templates/index.ts');
  const depAt = src.indexOf('RETIRED_TEMPLATE_NAMES: readonly string[] = [');
  const dep = src.slice(depAt, src.indexOf('];', depAt));
  for (const name of RETIRED_TEMPLATES) {
    assert.ok(dep.includes(name),
      `"${name}" is unlisted but not in RETIRED_TEMPLATE_NAMES — it will survive in existing databases`);
  }
});

// ── The templates, each asserted on the thing it exists to do ───────────────────────────

test('Super QA covers every lens of BOTH templates it replaced', () => {
  const tpl = templateNamed('Super QA');
  assert.ok(tpl, 'Super QA does not exist');
  const steps = stepsOf(tpl.id);
  const all = steps.map((s) => `${s.name}\n${String(cfg(s).prompt ?? '')}`).join('\n');

  // SET-BASED over the union of what Full QA Review and Code Review & Audit each checked. A lens
  // dropped in the merge is a class of bug nobody looks for any more.
  const LENSES: [string, RegExp][] = [
    ['Full QA: golden paths', /golden path/i],
    ['Full QA: edge cases', /edge case/i],
    ['Full QA: error handling', /error handling/i],
    ['Full QA: performance', /N\+1/],
    ['Full QA / Code Review: security', /OWASP|injection/i],
    ['Full QA: accessibility', /WCAG/],
    ['Full QA: health score', /health score/i],
    ['Code Review: reads the diff of a change', /git diff main\.\.\.HEAD/],
    ['Code Review: logic correctness', /AND\/OR|boolean/i],
    ['Code Review: async and state', /race|awaited/i],
    ['Code Review: test coverage, and writing the missing tests', /missing tests/i],
    ['Both: one verdict', /SHIP WITH FIXES/],
  ];
  const missing = LENSES.filter(([, re]) => !re.test(all)).map(([name]) => name);
  assert.deepEqual(missing, [], `Super QA lost: ${missing.join(', ')}`);

  // Both originals ended on a report a human reviews before the run goes on.
  const report = steps.find((s) => s.name === 'QA Report');
  assert.ok(report && report.auto_advance === 0, 'the QA report is no longer a human checkpoint');
});

test('Confer with a Jira epic looks the epic up FIRST and keeps going until every task is done', () => {
  const tpl = templateNamed('Confer');
  assert.ok(tpl, 'Confer does not exist');
  const steps = stepsOf(tpl.id);
  const names = steps.map((s) => s.name);

  // Scope comes before the confer and reads the epic from the launch context's epic line.
  const scope = steps[0];
  assert.equal(scope.executor_type, 'claude-code', 'the first step is not the one that reads the epic');
  assert.ok(names.indexOf('Confer & Build') > 0, 'the confer runs before the epic is looked up');
  const scopePrompt = String(cfg(scope).prompt ?? '');
  assert.ok(scopePrompt.includes(CONFER_EPIC_LINE), 'Scope does not look for the epic line the launch form writes');
  assert.match(scopePrompt, /EVERY child issue/, 'Scope does not collect every task in the epic');
  assert.match(scopePrompt, /never invent tasks/i, 'with no Jira access, Scope would make tasks up');

  // One cartridge scopes and verifies, even in a confer run.
  for (const name of ['Scope the Work', 'Verify Coverage']) {
    assert.equal(cfg(steps.find((s) => s.name === name)!).conferFill, 'single', `${name} would be conferred`);
  }

  // "Every task": the engine reads Verify Coverage's COVERAGE line (lib/coverage-loop.ts) and sends
  // the run back to the CONFER while tasks are open. A coverage step that went back to anything
  // else would re-count the same gap and never do the missing work.
  const full = db.prepare('SELECT id, name, executor_type, executor_config FROM workflow_steps WHERE workflow_id = ?')
    .all(tpl.id) as { id: string; name: string; executor_type: string; executor_config: string }[];
  const byName = new Map(full.map((s) => [s.name, s]));
  const verify = JSON.parse(byName.get('Verify Coverage')!.executor_config);
  assert.deepEqual(verify.coverage?.retryFrom, ['Confer & Build'],
    'Verify Coverage is not a coverage step that sends the run back to the confer');
  assert.match(String(verify.prompt), /COVERAGE: \[done\]\/\[total\]/, 'Verify Coverage does not report the COVERAGE line the engine reads');

  // Sized to the epic, not a fixed 3 rounds: the confer reads Scope's TASK_COUNT.
  const confer = JSON.parse(byName.get('Confer & Build')!.executor_config);
  assert.equal(confer.buildRoundsFrom?.step, 'Scope the Work', 'the confer is not sized from the task count');
  assert.match(scopePrompt, /TASK_COUNT:/, 'Scope does not report the task count the confer is sized from');
  assert.match(scopePrompt, /docs\/progress\//, 'Scope does not write the progress document');

  // …and Confer keeps the Work Standard Check: a gate of its own would switch it off.
  assert.ok(!full.some((s) => s.executor_type === 'quality-gate' || s.executor_type === 'review-gate'),
    'Confer has its own gate, so it is launched without the Work Standard Check');
});

test('the launch form and the template agree on the epic line', () => {
  const dashboard = read('dashboard/src/lib/conferLaunch.ts');
  assert.ok(dashboard.includes(`export const CONFER_EPIC_LINE = '${CONFER_EPIC_LINE}';`),
    'dashboard/src/lib/conferLaunch.ts writes a different epic line than Scope the Work looks for');
});

test('NO template step writes to a path on one person\'s machine', () => {
  // Deep Research saved every epic to a fixed path in one person's home directory,
  // whatever repo the run was on. Set-based over every prompt of every template.
  const offenders: string[] = [];
  for (const name of STANDARD_TEMPLATE_NAMES) {
    const tpl = templateNamed(name)!;
    for (const s of stepsOf(tpl.id)) {
      const text = JSON.stringify(cfg(s));
      if (/\/Users\/|\/home\/[a-z]/.test(text)) offenders.push(`${name} / ${s.name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('Deep Research saves the epic INTO the repository, where the epic templates look', () => {
  const tpl = templateNamed('Deep Research')!;
  const save = stepsOf(tpl.id).find((s) => s.name === 'Save Epic');
  assert.ok(save, 'no Save Epic step');
  const prompt = String(cfg(save).prompt ?? '');
  assert.match(prompt, /git rev-parse --show-toplevel/, 'does not resolve the repository root');
  assert.match(prompt, /docs\/plans\/EPIC-\[slug\]\.md/, 'does not save under docs/plans/');
  // …which is one of the places the epic templates resolve an epic from.
  const epic = stepsOf(templateNamed('Epic: Task by Task')!.id).map((s) => String(cfg(s).prompt ?? '')).join('\n');
  assert.ok(epic.includes('docs/plans/*.md'), 'Epic: Task by Task no longer looks in docs/plans/');
});

test('EVERY continue-to-workflow step names a template that exists', () => {
  const links: string[] = [];
  const broken: string[] = [];
  for (const name of STANDARD_TEMPLATE_NAMES) {
    for (const s of stepsOf(templateNamed(name)!.id)) {
      const c = cfg(s);
      if (s.executor_type !== 'connector' || c.connectorType !== 'launch-workflow') continue;
      links.push(`${name} → ${c.templateName}`);
      if (!templateNamed(String(c.templateName))) broken.push(`${name} / ${s.name} → "${c.templateName}"`);
    }
  }
  assert.ok(links.includes('CE: Phase 3 — Implement → CE: Phase 4 — Review'), `Phase 3 no longer continues: ${links.join(', ')}`);
  assert.deepEqual(broken, []);
});

test('Confer is a template — two or more cartridges on one task', () => {
  const tpl = templateNamed('Confer');
  assert.ok(tpl, 'Confer template does not exist');
  const steps = stepsOf(tpl.id);
  const confer = steps.filter((s) => s.executor_type === 'confer');
  assert.equal(confer.length, 1, `expected exactly one confer step, found ${confer.length}`);
  const c = cfg(confer[0]);
  assert.ok(Array.isArray(c.conferAgentIds), 'the confer step declares no agent roster');
  assert.ok(String(c.prompt ?? '').length > 40, 'the confer step has no prompt');
});

test('the top-menu Confer button is gone — it is a workflow now', () => {
  const app = read('dashboard/src/App.tsx');
  assert.ok(!/setConferOpen/.test(app),
    'App.tsx still opens the confer modal — the button was meant to go away, not be hidden');
  assert.ok(!/ConferModal/.test(app),
    'App.tsx still imports ConferModal');
});

test('WORKFLOWS.md catalogs every template there is — and none that is gone', () => {
  // The catalog went stale once already: it still described New Feature and CI/CD Pipeline long
  // after they were removed. Set-based over the registry, so adding or removing a template fails
  // here until the doc says so.
  const doc = read('WORKFLOWS.md');
  const catalog = doc.slice(doc.indexOf('## Template catalog'), doc.indexOf('> **Removed templates**'));
  assert.ok(catalog.length > 500, 'the template catalog section is missing');
  const bold = new Set([...catalog.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]));
  const missing = STANDARD_TEMPLATE_NAMES.filter((n) => !bold.has(n));
  assert.deepEqual(missing, [], `WORKFLOWS.md does not catalog: ${missing.join(', ')}`);
  const stale = RETIRED_TEMPLATES.filter((n) => bold.has(n));
  assert.deepEqual(stale, [], `WORKFLOWS.md still catalogs removed templates: ${stale.join(', ')}`);
  const count = doc.match(/seeds \*\*(\d+) workflow templates\*\*/);
  assert.equal(Number(count?.[1]), STANDARD_TEMPLATE_NAMES.length, 'the template count in the overview is wrong');
});

test('EVERY task-list template is read by the engine for coverage and keeps a progress document', () => {
  // A task-list template is one that works a list of tasks: a loop sized from data, or a confer.
  // Set-based over the library, so a new one is held to the same promise — it does not finish with
  // work open — without anyone remembering to add it here.
  const wrong: string[] = [];
  let found = 0;
  for (const name of STANDARD_TEMPLATE_NAMES) {
    const steps = stepsOf(templateNamed(name)!.id);
    const workers = steps.filter((s) => s.executor_type === 'confer' || !!cfg(s).loopCountFrom).map((s) => s.name);
    if (workers.length === 0) continue;
    found++;
    const coverage = steps.filter((s) => cfg(s).coverage);
    if (coverage.length !== 1) { wrong.push(`${name}: ${coverage.length} coverage steps, expected 1`); continue; }
    const retryFrom = (cfg(coverage[0]).coverage as { retryFrom: string[] }).retryFrom;
    const names = steps.map((s) => s.name);
    for (const r of retryFrom) if (!names.includes(r)) wrong.push(`${name}: coverage sends the run back to "${r}", which is not a step`);
    for (const w of workers) if (!retryFrom.includes(w)) wrong.push(`${name}: coverage never sends the run back to "${w}"`);
    if (!/COVERAGE: \[done\]\/\[total\]/.test(String(cfg(coverage[0]).prompt ?? ''))) wrong.push(`${name}: the coverage step does not report COVERAGE`);
    const all = steps.map((s) => String(cfg(s).prompt ?? '')).join('\n');
    if (!/PROGRESS:/.test(all) || !/docs\/progress\//.test(all)) wrong.push(`${name}: no progress document at docs/progress/`);
  }
  assert.ok(found >= 4, `expected the task-list templates (Confer, the two epics, CE Develop and Optimize), found ${found}`);
  assert.deepEqual(wrong, []);
});
