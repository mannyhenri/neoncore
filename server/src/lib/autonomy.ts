/**
 * Autonomy levels — N4 of docs/plans/build-order.md.
 *
 * How much a run may settle for itself while you are asleep. The posture is per-workflow, with
 * a per-project default, and raising it is TIME-BOXED: an unbounded grant is one you stop
 * noticing, and the whole point of a level is that you decided it on purpose.
 *
 * ── ADVANCE SHIPS BEFORE FULL, AND THAT IS ENCODED HERE ────────────────────────────────
 * The plan's "Do not" is explicit: "Ship `full` before `advance`. Live with `advance` for a
 * week." So `full` is DEFINED — the column accepts it, the audit records it — but today it
 * grants exactly what `advance` grants. The reasons it will eventually add (`decision`,
 * `agent-waiting`) need the hold-if-no-default rule and the override window, which are the
 * second half of N4 and are not written yet.
 *
 * That is stated in the table below rather than left to a reader's memory, and the test asserts
 * it. A level that silently granted latitude it was never given the machinery to exercise
 * safely is the exact failure the time-box exists to prevent.
 *
 * ── WHAT IS NEVER AUTO-RESOLVED ────────────────────────────────────────────────────────
 * "`failed` and `interrupted` are never auto-resolved at any level — that is breakage, not a
 * gate." A gate is a question the run is entitled to ask; breakage is the run being wrong.
 * Nothing may clear breakage on your behalf.
 */
import { randomUUID } from 'crypto';
import db from '../db.js';
import type { AttentionReason } from './workflow-attention.js';

export const AUTONOMY_LEVELS = ['manual', 'advance', 'full'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Breakage. Never auto-resolved, at any level, ever. */
export const NEVER_AUTO: AttentionReason[] = ['failed', 'interrupted'];

/**
 * What each level may settle without you. THE registry — the test iterates it against every
 * attention reason, so a level that quietly grows a capability fails there first.
 */
export const AUTO_RESOLVABLE: Record<AutonomyLevel, AttentionReason[]> = {
  // Nothing. The default, and what an expired grant falls back to.
  manual: [],
  // Reason 5 only: releasing a finished step decides nothing. It is the one gate where the
  // work is already done and the only question is whether the next step may begin.
  // `manual-advance` releases finished work. `agent-idle` NUDGES a cartridge that was told to
  // do something and went quiet without reporting — it decides nothing either, it asks the
  // agent to finish the instruction it was already given. Both belong at the level whose whole
  // definition is "decides nothing on your behalf".
  advance: ['manual-advance', 'agent-idle'],
  // Decision gates and agent questions, TAKEN BY THEIR CONFIGURED DEFAULT.
  //
  // GRANTING IS NOT THE SAME AS ALWAYS RESOLVING. A grant says the level MAY settle this
  // reason; whether it can depends on there being a default to take. A decision gate carries
  // `recommendation` in its executor_config (15 of 15 live gates have one); an agent question
  // has no default-answer field anywhere in the schema, so `full` grants it and then holds
  // every time, by the same rule. Inventing an answer to a question a cartridge asked you is
  // the one thing worse than waiting for you to answer it.
  full: ['manual-advance', 'agent-idle', 'decision', 'agent-waiting'],
};

/**
 * Levels a person may set. `full` is settable now that it means more than `advance` and ships
 * with the override window — the plan's ordering constraint was lifted deliberately, on the
 * record, rather than by forgetting it was there.
 */
export const SETTABLE_LEVELS: AutonomyLevel[] = ['manual', 'advance', 'full'];

/**
 * How long an auto-resolution stays reversible from the notification.
 *
 * "Work continues immediately, you still get a window. That's the difference between
 * automation you trust and automation you watch." The window is short on purpose: past it, the
 * run has built on the decision and reversing one step in isolation is no longer a safe undo —
 * it is a repair, and belongs in the dashboard with the rest of the run in front of you.
 */
export const OVERRIDE_WINDOW_MS = 5 * 60_000;

export function isAutonomyLevel(v: string): v is AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(v);
}

interface WorkflowAutonomyRow {
  autonomy: string;
  autonomy_expires_at: string | null;
  project_id: string | null;
}

export interface EffectiveAutonomy {
  level: AutonomyLevel;
  /** Where it came from, so a surface can explain itself. */
  source: 'workflow' | 'project' | 'default' | 'expired';
  expiresAt: string | null;
}

/**
 * The level actually in force for a run.
 *
 * An EXPIRED grant does not fall back to the workflow's own column — it falls through to the
 * project default, and then to 'manual'. Reading the stale column would make a time-box
 * decorative: the grant would end on paper and continue in effect.
 */
export function effectiveAutonomy(workflowId: string, now = Date.now()): EffectiveAutonomy {
  const wf = db.prepare(
    'SELECT autonomy, autonomy_expires_at, project_id FROM workflows WHERE id = ?',
  ).get(workflowId) as WorkflowAutonomyRow | undefined;
  if (!wf) return { level: 'manual', source: 'default', expiresAt: null };

  const expired = !!wf.autonomy_expires_at && Date.parse(wf.autonomy_expires_at) <= now;

  if (!expired && wf.autonomy && isAutonomyLevel(wf.autonomy) && wf.autonomy !== 'manual') {
    return { level: wf.autonomy, source: 'workflow', expiresAt: wf.autonomy_expires_at };
  }

  if (wf.project_id) {
    const proj = db.prepare('SELECT default_autonomy FROM projects WHERE id = ?')
      .get(wf.project_id) as { default_autonomy?: string } | undefined;
    const lvl = proj?.default_autonomy;
    if (lvl && isAutonomyLevel(lvl) && lvl !== 'manual') {
      return { level: lvl, source: 'project', expiresAt: null };
    }
  }

  return { level: 'manual', source: expired ? 'expired' : 'default', expiresAt: null };
}

/** May this level settle this reason, right now? */
export function canAutoResolve(level: AutonomyLevel, reason: AttentionReason): boolean {
  if (NEVER_AUTO.includes(reason)) return false;   // breakage, at every level
  return AUTO_RESOLVABLE[level].includes(reason);
}

/** Set a run's posture. `untilMs` null means no expiry, which SETTABLE_LEVELS keeps rare. */
export function setWorkflowAutonomy(workflowId: string, level: AutonomyLevel, untilMs: number | null): void {
  db.prepare('UPDATE workflows SET autonomy = ?, autonomy_expires_at = ? WHERE id = ?')
    .run(level, untilMs ? new Date(untilMs).toISOString() : null, workflowId);
}

export interface AutoResolution {
  workflowId: string;
  stepId: string;
  reason: AttentionReason;
  /** What it did, in the words the audit should show: "advance", or an option label. */
  chose: string;
  autonomy: AutonomyLevel;
}

/** Every auto-resolution is recorded BEFORE anyone is told about it. */
export function recordAutoResolution(r: AutoResolution): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO workflow_auto_resolutions
      (id, workflow_id, step_id, reason, chose, autonomy, overridden, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, r.workflowId, r.stepId, r.reason, r.chose, r.autonomy, new Date().toISOString());
  return id;
}

/** The option a decision gate recommends, or null. This IS the "configured default". */
export function recommendationOf(executorConfig: string): string | null {
  try {
    const cfg = JSON.parse(executorConfig || '{}') as {
      recommendation?: string; options?: { id: string }[];
    };
    const rec = cfg.recommendation;
    if (!rec) return null;
    // A recommendation naming an option that no longer exists is not a default, it is stale
    // config. Holding is correct; picking something else on its behalf is not.
    return (cfg.options || []).some((o) => o.id === rec) ? rec : null;
  } catch {
    return null;
  }
}

export interface StoredResolution extends AutoResolution {
  id: string;
  overridden: number;
  createdAt: string;
}

export function getAutoResolution(id: string): StoredResolution | null {
  const row = db.prepare(`
    SELECT id, workflow_id AS workflowId, step_id AS stepId, reason, chose, autonomy,
           overridden, created_at AS createdAt
    FROM workflow_auto_resolutions WHERE id = ?
  `).get(id) as StoredResolution | undefined;
  return row ?? null;
}

/** Still inside the window, and not already reversed. */
export function isOverridable(r: StoredResolution, now = Date.now()): boolean {
  if (r.overridden) return false;
  const at = Date.parse(r.createdAt);
  return Number.isFinite(at) && now - at <= OVERRIDE_WINDOW_MS;
}

export function markOverridden(id: string): void {
  db.prepare('UPDATE workflow_auto_resolutions SET overridden = 1 WHERE id = ?').run(id);
}

export function listAutoResolutions(workflowId: string, limit = 20): AutoResolution[] {
  return db.prepare(`
    SELECT workflow_id AS workflowId, step_id AS stepId, reason, chose, autonomy
    FROM workflow_auto_resolutions WHERE workflow_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(workflowId, limit) as AutoResolution[];
}

/** "2h", "30m", "1d" → ms. Null when unparseable, so a typo does not become an unbounded grant. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*([mhd])$/i.exec((text || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  const unit = m[2].toLowerCase();
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}
