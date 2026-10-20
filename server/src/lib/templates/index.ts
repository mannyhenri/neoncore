/**
 * THE STANDARD WORKFLOW TEMPLATES — one file per family, seeded in this order on every boot.
 *
 * Moved out of db.ts, where the seeder was ~1,600 lines in the middle of the schema. The
 * definitions are unchanged; db.ts still owns the transaction (see seedDefaultTemplates).
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { GRIDLIGHT_QA_TEMPLATE_NAMES, GRIDLIGHT_PERF_TEMPLATE_NAME } from '../gridlight-qa-templates.js';
import type { SeedKit } from './kit.js';
import { seedGridlight } from './gridlight.js';
import { seedSpecIntake } from './spec-intake.js';
import { seedDigests } from './digests.js';
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
export const STANDARD_TEMPLATE_NAMES = ['Spec Intake → Dev Spec', 'Daily AI Research Digest', 'Daily AI Filmmaking Digest', 'Confer', 'QA Testing Guide', 'Release Documentation', 'Bug Hunter', 'Feature Validation', 'Deep Research', 'Jira Tasks Validation', 'Epic: Task by Task', 'CE Develop and Optimize', 'Epic: Two Repos', 'Epic: Confer Across Repos', 'Product Strategy Session', 'Engineering Architecture Review', 'Full QA Review', 'Bug Investigation', 'Code Review & Audit', 'CE: Phase 1 — Interrogate', 'CE: Phase 2 — Plan', 'CE: Phase 3 — Implement', 'CE: Phase 4 — Review', 'CE: Phase 5 — QA', 'CE: Phase 6 — Ship', 'CE: Phase 7 — Compound', 'CE: Full Delivery', ...GRIDLIGHT_QA_TEMPLATE_NAMES, GRIDLIGHT_PERF_TEMPLATE_NAME] as const;

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
  const deprecatedNames = ['Feature Fix', 'Code Improvement', 'Refactor', 'Jira Tasks Completion', 'New Feature', 'CI/CD Pipeline'];
  for (const name of deprecatedNames) {
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
  seedGridlight(kit);
  seedSpecIntake(kit);
  seedDigests(kit);
  seedConfer(kit);
  seedDocs(kit);
  seedInvestigation(kit);
  seedEpics(kit);
  seedReviews(kit);
  seedCompoundEngineering(kit);

  // Derived, not hand-written: this said 20 while the list held 23, because a count typed
  // into a log line is a fact nobody updates when they add a template.
  console.log(`[db] Seeded ${standardNames.length} default workflow templates`);
}
