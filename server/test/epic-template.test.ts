// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { STANDARD_TEMPLATE_NAMES, seedDefaultTemplates } from '../src/db.ts';

/**
 * The epic template: load an epic, do every task, commit after each, keep going.
 *
 * TWO THINGS ARE BEING GUARDED, and the second is the one that bites.
 *
 * 1. The template's BEHAVIOUR. It must commit per task and must not stop to ask between them —
 *    a run that pauses after every task is not unattended, it is a slow conversation.
 *
 * 2. THE RENAME. `seedDefaultTemplates()` deletes and re-inserts every standard template on
 *    every boot, but the delete loop only visits names in STANDARD_TEMPLATE_NAMES. Rename a
 *    template without updating that list and its old row is never deleted again: it lingers in
 *    every existing database forever, beside its replacement, with no way to tell which is
 *    which. `deprecatedNames` exists for exactly this and is easy to forget, because forgetting
 *    it is invisible on a fresh database — which is where anyone would test a rename.
 *
 * SET-BASED over STANDARD_TEMPLATE_NAMES rather than the one template being changed, because
 * the failure is a PARTIAL rename: the registry updated and the seed block not, or the reverse.
 * Either leaves a name in the list that seeds nothing, which is invisible until someone looks
 * for a template that is no longer there.
 */

const EPIC_TEMPLATE = 'Epic: Task by Task';

interface Row { id: string; name: string }

function templates(): Row[] {
  return db.prepare(
    'SELECT id, name FROM workflows WHERE template_id IS NULL ORDER BY name',
  ).all() as Row[];
}

function stepsOf(name: string): { name: string; config: string }[] {
  return db.prepare(`
    SELECT s.name AS name, s.executor_config AS config
    FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
    WHERE w.name = ? AND w.template_id IS NULL ORDER BY s.position_y
  `).all(name) as { name: string; config: string }[];
}

test('the registry is real — an empty scan would pass vacuously', () => {
  assert.ok(STANDARD_TEMPLATE_NAMES.length >= 20,
    `expected the full template registry, got ${STANDARD_TEMPLATE_NAMES.length}`);
});

test('every name in STANDARD_TEMPLATE_NAMES seeds a template with steps', () => {
  // Catches a half-done rename from either side: a registry entry whose seed block still uses
  // the old name, or a seed block the registry no longer lists.
  const present = new Set(templates().map((t) => t.name));
  const failures: string[] = [];

  for (const name of STANDARD_TEMPLATE_NAMES) {
    if (!present.has(name)) { failures.push(`"${name}" is in the registry but seeds nothing`); continue; }
    if (stepsOf(name).length === 0) failures.push(`"${name}" seeded with zero steps`);
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('the template a rename replaced is GONE, not orphaned beside its replacement', () => {
  /*
   * THIS TEST HAD TO SIMULATE AN OLD DATABASE TO BE WORTH ANYTHING.
   *
   * Its first version simply asserted the old name was absent — and passed with the
   * deprecation removed, because the isolated database is FRESH and never held that row. It
   * reproduced, exactly, the blind spot it was written to describe: a rename looks clean on a
   * new database and orphans a row on every existing one.
   *
   * So the old row is inserted first, and seeding is re-run over it. That is what an existing
   * database looks like on the boot after the rename ships.
   */
  db.prepare(`
    INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at)
    VALUES ('stale-jira-row', 'Jira Tasks Completion', 'the pre-rename template', 'pending', '[]', ?, '')
  `).run(new Date().toISOString());
  assert.ok(templates().some((t) => t.name === 'Jira Tasks Completion'), 'fixture did not take');

  seedDefaultTemplates();

  const names = templates().map((t) => t.name);
  assert.ok(!names.includes('Jira Tasks Completion'),
    'the old "Jira Tasks Completion" row survived a reseed — add it to deprecatedNames in db.ts, '
    + 'or it sits beside its replacement in every existing database forever');
  assert.ok(names.includes(EPIC_TEMPLATE), 'the replacement was removed along with it');
});

test('the epic template exists under a name that describes what it does', () => {
  const names = templates().map((t) => t.name);
  assert.ok(names.includes(EPIC_TEMPLATE), `no "${EPIC_TEMPLATE}" template — got: ${names.join(', ')}`);
  assert.ok((STANDARD_TEMPLATE_NAMES as readonly string[]).includes(EPIC_TEMPLATE),
    `"${EPIC_TEMPLATE}" seeds but is absent from STANDARD_TEMPLATE_NAMES, so a later rename cannot clean it up`);
});

/**
 * THE SET: what the loop must do, and what it must not.
 *
 * Expressed against the whole template's prompts rather than one step, because which step
 * carries a phase is an implementation detail — the guarantee is about the template.
 */
const REQUIRED = [
  { label: 'commits after each task', pattern: /commit/i },
  { label: 'loops until the tasks run out', pattern: /loop|repeat|next task/i },
  { label: 'writes failing tests before implementing', pattern: /fail/i },
];

const FORBIDDEN = [
  {
    label: 'stops to ask between tasks',
    pattern: /AskUserQuestion/i,
    why: 'a run that asks after every task is not unattended — and `full` autonomy cannot clear '
       + 'an agent question, because nothing in the schema carries a default answer to one',
  },
  {
    label: 'hard-requires the Jira CLI',
    pattern: /Use the Jira CLI/i,
    why: 'the template must work from a plain epic file; Jira should be one source, not the only one',
  },
];

test('the epic loop commits per task, keeps going, and never stops to ask', () => {
  const all = stepsOf(EPIC_TEMPLATE).map((s) => s.config).join('\n');
  assert.ok(all.length > 500, 'the template has no substantial prompt to check');

  const failures: string[] = [];
  for (const r of REQUIRED) {
    if (!r.pattern.test(all)) failures.push(`MISSING: ${r.label} (${r.pattern})`);
  }
  for (const f of FORBIDDEN) {
    if (f.pattern.test(all)) failures.push(`PRESENT BUT MUST NOT BE: ${f.label} — ${f.why}`);
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('the epic can come from a file OR a tracker — neither is assumed', () => {
  const all = stepsOf(EPIC_TEMPLATE).map((s) => s.config).join('\n');
  assert.match(all, /\.md|markdown|file/i, 'no way to point it at an epic file');
  assert.match(all, /jira/i, 'Jira support was dropped rather than made optional');
});

// ── The count has to be READ FROM DATA, and the wiring has to be real ────────

function loopStepConfig(): Record<string, unknown> {
  const row = db.prepare(`
    SELECT s.executor_config AS c FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
    WHERE w.name = ? AND s.name = 'Work Every Task'
  `).get(EPIC_TEMPLATE) as { c: string } | undefined;
  assert.ok(row, 'no "Work Every Task" step');
  return JSON.parse(row!.c) as Record<string, unknown>;
}

/**
 * THE WIRING, END TO END.
 *
 * `loopCountFrom` names its source step by NAME and greps its output with a pattern. Both sides
 * are strings, and a typo in either degrades SILENTLY to looping once — which is precisely the
 * bug this feature was added to fix, restored in a form nobody would notice. So the test checks
 * the producer actually emits what the consumer greps for, rather than checking each in isolation.
 */
test('the loop count is read from data, and its source really produces it', () => {
  const cfg = loopStepConfig();
  const from = cfg.loopCountFrom as { step?: string; pattern?: string } | undefined;

  assert.ok(from?.step && from?.pattern,
    'the loop step has no loopCountFrom — its coverage is back to whatever the prompt remembers');
  assert.ok(cfg.loopUntil, 'no loopUntil: when the tasks run out the remaining dispatches do nothing');

  // The named step must EXIST in this template...
  const names = stepsOf(EPIC_TEMPLATE).map((x) => x.name);
  assert.ok(names.includes(from!.step!),
    `loopCountFrom names "${from!.step}", which is not a step in this template — got: ${names.join(', ')}`);

  // ...and must be a DEPENDENCY, or its result is not available when the count is resolved.
  const dep = db.prepare(`
    SELECT s.depends_on AS d FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
    WHERE w.name = ? AND s.name = 'Work Every Task'
  `).get(EPIC_TEMPLATE) as { d: string };
  const srcId = db.prepare(`
    SELECT s.id FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
    WHERE w.name = ? AND s.name = ?
  `).get(EPIC_TEMPLATE, from!.step!) as { id: string };
  assert.ok((dep.d || '').includes(srcId.id),
    `"${from!.step}" is not a dependency of the loop step, so its output is not there to read`);

  // ...and the producer's own prompt must emit text the consumer's pattern matches.
  const producer = stepsOf(EPIC_TEMPLATE).find((x) => x.name === from!.step!)!;
  const emitted = JSON.parse(producer.config).prompt as string;
  const probe = emitted.replace(/\[count of tasks not yet done\]|\[[^\]]*\]/g, '7');
  assert.match(probe, new RegExp(from!.pattern!),
    `"${from!.step}" never emits anything matching /${from!.pattern}/ — the count would silently fall back to 1`);
});

test('a final sweep confirms nothing was missed', () => {
  // The loop guarantees N dispatches; it cannot guarantee N completions. Something has to look
  // at the state doc afterwards and say which tasks are still outstanding, or a blocked task in
  // the middle of the run is only discoverable by reading twelve step outputs.
  const names = stepsOf(EPIC_TEMPLATE).map((x) => x.name);
  assert.ok(names.includes('Verify Coverage'),
    `no sweep step — got: ${names.join(', ')}`);
});
