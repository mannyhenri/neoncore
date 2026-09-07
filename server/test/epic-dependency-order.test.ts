/**
 * AN EPIC LOOP WORKS THE PREREQUISITE, IT DOES NOT WORK DOCUMENT ORDER.
 *
 * REPORTED, and it is the difference between a guardrail and the feature: "I want it to switch
 * to the prerequisite if there is one." The task-queue gate built earlier refuses a blocked
 * claim — necessary, and irrelevant here, because `Epic: Task by Task` never touches the task
 * queue. It reads a state doc, and its instruction was:
 *
 *     "Read the state doc. Take the FIRST task not yet marked done or skipped."
 *
 * Document order. An epic where GLW-042 depends on GLW-041 runs correctly only if whoever wrote
 * the doc happened to put 041 first, and a task added mid-run lands wherever it was appended.
 * Nothing anywhere in the engine reads a dependency for this shape of run — not the state doc,
 * not Jira's "is blocked by" links.
 *
 * ── WHY SWITCH RATHER THAN SKIP ────────────────────────────────────────────────────────
 * `Epic: Two Repos` already noticed the problem and chose the other answer: "take the next one
 * instead and say which you skipped". Skipping is right there ONLY because the blocker may
 * belong to the other repo's cartridge, which this one must not touch. When the blocker is the
 * agent's own work, skipping past it defers the thing the epic needs next and reorders the run
 * into exactly the shape the dependency was written to prevent. So: work it if it is yours,
 * skip only when it is not.
 *
 * ── THE SET IS READ FROM THE SEEDED TEMPLATES ──────────────────────────────────────────
 * Not from a list in this file. Every template step that loops over a state doc is found by its
 * `loopUntil` sentinel, so a fourth epic template — or a fifth, when someone adds one — fails
 * here until it carries the rule too. An example-based test naming "Epic: Task by Task" would
 * have passed while Two Repos kept skipping.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { seedDefaultTemplates } from '../src/db.js';

/** Every seeded template step that picks tasks from a state doc in a loop. */
function pickingLoops(): { wf: string; step: string; prompt: string }[] {
  const rows = db.prepare(`
    SELECT w.name wf, s.name step, s.executor_config cfg
      FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
     WHERE w.template_id IS NULL AND w.status = 'pending'`).all() as
    { wf: string; step: string; cfg: string }[];
  const out: { wf: string; step: string; prompt: string }[] = [];
  for (const r of rows) {
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(r.cfg || '{}'); } catch { continue; }
    if (!cfg.loopUntil) continue;                 // not a task-picking loop
    out.push({ wf: r.wf, step: r.step, prompt: String(cfg.prompt || '') });
  }
  return out;
}

test('the seeded templates contain task-picking loops at all', () => {
  seedDefaultTemplates();
  const loops = pickingLoops();
  // Non-vacuity: if the discovery query breaks, every assertion below passes on an empty set,
  // which is the failure mode this whole file exists to prevent one level down.
  assert.ok(loops.length >= 3,
    `expected the epic loops to be discoverable, found ${loops.length}`);
});

test('EVERY task-picking loop is told to work the prerequisite first', () => {
  const missing: string[] = [];
  for (const l of pickingLoops()) {
    const p = l.prompt;
    const has = {
      // A named section, so the rule is findable in a 4k-character prompt rather than buried.
      section: /DEPENDENCIES FIRST/.test(p),
      // The word the epic docs and trackers actually use.
      prerequisite: /prerequisite/i.test(p),
      // The specific instruction — an agent told only "consider dependencies" will still take
      // the first undone task, because that is what the surrounding steps tell it to do.
      switchTo: /work (its|that) prerequisite|switch to (the|its) prerequisite/i.test(p),
      // And the prohibition, because skipping past is the plausible wrong answer — it is what
      // Two Repos did, and what an agent optimising for "make progress" will choose unprompted.
      dontSkip: /do not skip past it|never skip past it/i.test(p),
    };
    const gaps = Object.entries(has).filter(([, ok]) => !ok).map(([k]) => k);
    if (gaps.length) missing.push(`${l.wf} :: ${l.step} — missing: ${gaps.join(', ')}`);
  }
  assert.deepEqual(missing, [], `\n  ${missing.join('\n  ')}\n`);
});

test('EVERY loop still says what to do when the prerequisite is NOT its own work', () => {
  // The escape hatch has to survive. In a two-repo run the blocker often belongs to the other
  // cartridge, and an agent that "works the prerequisite" there would edit a repo another agent
  // is writing to right now. Switching is conditional on ownership; the rule must say so.
  const missing: string[] = [];
  for (const l of pickingLoops()) {
    if (!/not yours|belongs to (the )?(other|another)|another cartridge|cannot start it/i.test(l.prompt)) {
      missing.push(`${l.wf} :: ${l.step}`);
    }
  }
  assert.deepEqual(missing, [],
    `these loops switch to a prerequisite without saying what to do when it is not theirs to `
    + `work:\n  ${missing.join('\n  ')}`);
});

test('EVERY loop keeps the remaining-count contract that drives the engine', () => {
  // Guard against fixing ordering by rewriting the prompt and dropping something load-bearing:
  // `[k] remaining` is what extends the loop budget, and the sentinel is what ends it early.
  const broken: string[] = [];
  for (const l of pickingLoops()) {
    if (!/\[k\] remaining/.test(l.prompt)) broken.push(`${l.wf} :: ${l.step} — lost "[k] remaining"`);
    if (!/COMPLETE/.test(l.prompt)) broken.push(`${l.wf} :: ${l.step} — lost its completion sentinel`);
  }
  assert.deepEqual(broken, [], `\n  ${broken.join('\n  ')}\n`);
});
