/**
 * Un-confer the report steps that are already in the database.
 *
 * `conferFillFor` (lib/workflow-launch.ts) stops the completion report being conferred at
 * LAUNCH. That fixes every run created afterwards and nothing that already exists — and the
 * rows that already exist are not history. Measured on the live database when this was
 * written: seven report steps had been converted to `confer` with an empty executor_id, SIX
 * were still `pending`, and one of those belonged to a run that was still running. That run
 * would have reached its last step, conferred the report across its participants, written a
 * duplicate into each repo and delivered none of them to the journal — on fixed code.
 *
 * So this is the other half of the fix, and it runs at boot beside backfillReportsFromDisk.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ──────────────────────────────────────────────
 *  · A step that already RAN. Rewriting it would invent a history in which one cartridge owned
 *    a step that two of them actually executed, and it would gain nothing: the ingest finds
 *    those reports through the roster in the config, not through the executor type.
 *  · A step whose whole roster is gone. Pinning a dead cartridge converts a visible confer into
 *    a step that dies at dispatch with "has no cartridge assigned" — the launch door refuses a
 *    stale pin for precisely this reason. It is counted and reported instead.
 *
 * The roster stays in the config after the repair. It is not dead weight: `reportSources`
 * (routes/workflows.ts) reads `conferAgentIds` to find a report a participant already wrote,
 * and dropping it would strand exactly the files this whole change set exists to recover.
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import { isReportStep } from './workflow-report.js';

export interface RepairResult {
  /** Steps turned back into single-cartridge claude-code steps. */
  repaired: number;
  /** Steps left as they were because no cartridge in the roster still exists. */
  unrepairable: number;
}

/**
 * The judge, chosen the same way the launch path chooses it: the first participant. Same rule
 * in both places on purpose — a repaired run and a freshly launched one should put the report
 * on the same cartridge, or the two paths disagree about who owns the report.
 */
function firstLiveParticipant(db: DatabaseType, roster: unknown): string {
  if (!Array.isArray(roster)) return '';
  for (const raw of roster) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) continue;
    if (db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id)) return id;
  }
  return '';
}

export function repairConferredReportSteps(db: DatabaseType): RepairResult {
  // Only steps that could still DISPATCH. `running` is included because a confer step that is
  // mid-flight when the server restarts has not yet produced its report.
  const rows = db.prepare(
    `SELECT id, executor_config FROM workflow_steps
      WHERE executor_type = 'confer' AND status IN ('pending', 'running')`,
  ).all() as { id: string; executor_config: string }[];

  const update = db.prepare(
    "UPDATE workflow_steps SET executor_type = 'claude-code', executor_id = ? WHERE id = ?",
  );

  let repaired = 0;
  let unrepairable = 0;
  for (const r of rows) {
    let config: Record<string, unknown>;
    try { config = JSON.parse(r.executor_config || '{}'); } catch { continue; }
    if (!isReportStep(config)) continue;

    const judge = firstLiveParticipant(db, config.conferAgentIds);
    if (!judge) { unrepairable += 1; continue; }

    update.run(judge, r.id);
    repaired += 1;
  }

  if (repaired || unrepairable) {
    console.log(`[workflow] Report steps un-conferred: ${repaired} repaired`
      + (unrepairable ? `, ${unrepairable} left (no surviving cartridge in the roster)` : ''));
  }
  return { repaired, unrepairable };
}
