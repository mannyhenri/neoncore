/**
 * THE STANDARD WORKFLOW TEMPLATES — one file per family, seeded in this order on every boot.
 *
 * Moved out of db.ts, where the seeder was ~1,600 lines in the middle of the schema. The
 * definitions are unchanged; db.ts still owns the transaction (see seedDefaultTemplates).
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';
import { seedConfer } from './confer.js';
import { seedDocs } from './docs.js';
import { seedInvestigation } from './investigation.js';
import { seedEpics } from './epics.js';
import { seedReviews } from './reviews.js';
import { seedCompoundEngineering } from './compound-engineering.js';

/**
 * The standard templates, by name. Exported so the id-stability test iterates the real
 * registry rather than a copy that can drift from it.
 */
// 'New Feature' and 'CI/CD Pipeline' are GONE, not reordered. Every one of their agent steps
// had an empty prompt, so a step called "Develop" dispatched the word "Develop" to a cartridge
// (the executor falls back to `description || name`). They looked like the real templates in the
// picker, which is most of why the list read as convoluted. Both are in `deprecatedNames` below
// so they are deleted from existing databases too, not merely unlisted.
export const STANDARD_TEMPLATE_NAMES = ['Confer', 'QA Testing Guide', 'Release Documentation', 'Bug Hunter', 'Feature Validation', 'Deep Research', 'Jira Tasks Validation', 'Epic: Task by Task', 'CE Develop and Optimize', 'Epic: Two Repos', 'Product Strategy Session', 'Engineering Architecture Review', 'Super QA', 'Bug Investigation', 'CE: Phase 1 — Interrogate', 'CE: Phase 2 — Plan', 'CE: Phase 3 — Implement', 'CE: Phase 4 — Review', 'CE: Phase 5 — QA', 'CE: Phase 6 — Ship', 'CE: Phase 7 — Compound'] as const;

/**
 * Templates launched WITHOUT the auto-added Work Standard Check (workflows.standard_gate = 'off').
 *
 * The check audits code: "go to the CODE and establish the complete set it should have touched",
 * then the set-based test that proves it. These templates change no code — they produce a digest,
 * research, a strategy, an architecture review, documentation, a validation report, a QA run, a
 * brainstorm, a plan, or compound notes — so the check had nothing to audit and cost a full
 * dispatch (and its retries) on every run. Templates that change code keep it, including CE Phase 4
 * (resolves review findings), Phase 5 (fixes the bugs QA finds) and Phase 6 (recovery actions).
 */
export const NO_STANDARD_GATE_TEMPLATES = [
  'Deep Research', 'Product Strategy Session',
  'Engineering Architecture Review', 'Release Documentation', 'Jira Tasks Validation',
  'CE: Phase 1 — Interrogate', 'CE: Phase 2 — Plan', 'CE: Phase 7 — Compound', 'Super QA',
] as const;

/**
 * Templates that used to be standard and were removed or renamed. Every boot deletes them from
 * existing databases (runStandardTemplateSeed, below). Exported so the sandbox's template import
 * (sandbox/lib/templates-import.mjs) does not copy a retired one back in from an older database.
 * Why each one went is recorded where they are deleted.
 */
export const RETIRED_TEMPLATE_NAMES: readonly string[] = ['Feature Fix', 'Code Improvement', 'Refactor', 'Jira Tasks Completion', 'New Feature', 'CI/CD Pipeline',
  'Gridlight Local QA', 'Gridlight Full Release QA', 'Gridlight Performance Improvement',
  'CE: Full Delivery', 'Spec Intake → Dev Spec', 'Epic: Confer Across Repos', 'Full QA Review', 'Code Review & Audit',
  'Daily AI Research Digest', 'Daily AI Filmmaking Digest'];

export function runStandardTemplateSeed(db: DatabaseType): void {
  const standardNames = STANDARD_TEMPLATE_NAMES;

  // Capture the established id for each name BEFORE deleting anything. Oldest wins, so
  // duplicates left by earlier seeding runs collapse onto the id things already reference
  // rather than the id of whichever duplicate happened to be found first.
  const preservedIds = new Map<string, string>();
  for (const name of standardNames) {
    const rows = db.prepare(
      "SELECT id FROM workflows WHERE name = ? AND template_id IS NULL ORDER BY created_at ASC",
    ).all(name) as { id: string }[];
    if (rows.length > 0) preservedIds.set(name, rows[0].id);
    for (const row of rows) {
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(row.id);
      db.prepare("DELETE FROM workflows WHERE id = ?").run(row.id);
    }
  }

  /** The template's established id, or a new one the first time it is ever seeded. */
  const stableId = (name: string): string => preservedIds.get(name) ?? randomUUID();

  // Remove deprecated templates on every boot so they don't linger in existing DBs
  // Renamed templates go here, not just removed ones. The delete loop above only visits names
  // in STANDARD_TEMPLATE_NAMES, so a rename that does not deprecate its old name leaves that row
  // in every existing database forever, beside its replacement with nothing to tell them apart.
  // Invisible on a fresh database, which is where a rename gets tested.
  // Removed templates: listing them here deletes the template rows from existing databases.
  // Past runs (template_id set) are left alone.
  //   The three Gridlight templates — unused.
  //   CE: Full Delivery — a hand-copied chain of the seven CE phases whose prompts had drifted
  //     from the phases' own; Phase 3 now continues into Phase 4 itself.
  //   Spec Intake → Dev Spec — covered by Feature Validation.
  //   Epic: Confer Across Repos — merged into Confer (give it a Jira epic).
  //   Full QA Review, Code Review & Audit — merged into Super QA.
  //   Daily AI Research Digest, Daily AI Filmmaking Digest — no longer wanted.
  for (const name of RETIRED_TEMPLATE_NAMES) {
    const rows = db.prepare("SELECT id FROM workflows WHERE name = ? AND template_id IS NULL").all(name) as { id: string }[];
    for (const row of rows) {
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(row.id);
      db.prepare("DELETE FROM workflows WHERE id = ?").run(row.id);
    }
  }

  const now = new Date().toISOString();

  const insertWorkflow = db.prepare(`
    INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at)
    VALUES (?, ?, ?, 'pending', '[]', ?, '')
  `);

  const insertStep = db.prepare(`
    INSERT INTO workflow_steps
      (id, workflow_id, name, description, position_x, position_y,
       executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Agent-based types need __deferred__ so the user picks a cartridge at run time.
  // Connector/command steps run without a cartridge.
  const DEFERRED_TYPES = new Set(['claude-code', 'quality-gate', 'review-gate', 'deliberation', 'confer']);

  function step(
    wfId: string,
    id: string,
    name: string,
    desc: string,
    x: number,
    y: number,
    type: string,
    config: Record<string, unknown>,
    deps: string[],
    auto = true,
  ) {
    const executorId = DEFERRED_TYPES.has(type) ? '__deferred__' : '';
    insertStep.run(id, wfId, name, desc, x, y, type, executorId, JSON.stringify(config), auto ? 1 : 0, JSON.stringify(deps), now);
  }

  const cc = (role: string, extra: Record<string, unknown> = {}) => ({
    role,
    includeDepOutput: true,
    systemPromptMode: 'free',
    systemPrompt: '',
    loopCount: 1,
    ...extra,
  });

  const gate = (gateType: string) => ({ gateType, includeDepOutput: true });

  // Layout constants: all steps x=300, y increments by 175 (fully linear/sequential).

  const kit: SeedKit = { db, now, stableId, insertWorkflow, step, cc, gate };
  seedConfer(kit);
  seedDocs(kit);
  seedInvestigation(kit);
  seedEpics(kit);
  seedReviews(kit);
  seedCompoundEngineering(kit);

  const noGate = db.prepare("UPDATE workflows SET standard_gate = 'off' WHERE name = ? AND template_id IS NULL");
  for (const name of NO_STANDARD_GATE_TEMPLATES) noGate.run(name);

  // Derived, not hand-written: this said 20 while the list held 23, because a count typed
  // into a log line is a fact nobody updates when they add a template.
  console.log(`[db] Seeded ${standardNames.length} default workflow templates`);
}
