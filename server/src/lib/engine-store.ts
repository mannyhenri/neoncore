/**
 * Persistence for capability routing — and the consumer that closes the loop.
 *
 * This module exists because the feature was a dead drop at both ends. Nothing loaded a
 * measured profile at runtime, and nothing had EVER read the `trouble_signals` events
 * Gridlight has been emitting since the second confer: they landed in `activities` and
 * were never consulted. The router honoured a demotion argument that nothing produced.
 *
 * Two stores, deliberately separate:
 *   - profiles   per (model_id)               — replaced wholesale by a re-probe
 *   - demotions  per (model_id, function_id)  — runtime evidence accumulated BETWEEN probes
 */
import db from '../db.js';
import { DEMOTION_CONSECUTIVE_FAILURES, type CapabilityProfile } from './engine-capability.js';
import type { DemotionRecord } from './engine-router.js';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Persist a measurement. Saving a profile CLEARS that model's demotions.
 *
 * DECIDED-AND-MARKED: demotions do not expire on a timer; a re-probe clears them. The
 * probe is the authority and demotions are evidence gathered since it ran. Without this
 * the loop is a ratchet — one bad turn pins a function to frontier forever and the map can
 * only ever get more pessimistic.
 */
export function saveProfile(profile: CapabilityProfile): void {
  db.prepare(`
    INSERT INTO model_capability_profiles (model_id, measured_at, profile_json)
    VALUES (?, ?, ?)
    ON CONFLICT(model_id) DO UPDATE SET measured_at = excluded.measured_at, profile_json = excluded.profile_json
  `).run(profile.modelId, profile.measuredAt, JSON.stringify(profile));
  clearDemotionsForModel(profile.modelId);
}

/** Null when the model has never been measured — which routes frontier, not local. */
export function loadProfile(modelId: string): CapabilityProfile | null {
  const row = db.prepare('SELECT profile_json FROM model_capability_profiles WHERE model_id = ?')
    .get(modelId) as { profile_json: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.profile_json) as CapabilityProfile; } catch { return null; }
}

export function listProfiles(): CapabilityProfile[] {
  const rows = db.prepare('SELECT profile_json FROM model_capability_profiles').all() as { profile_json: string }[];
  return rows.flatMap((r) => { try { return [JSON.parse(r.profile_json) as CapabilityProfile]; } catch { return []; } });
}

// ---------------------------------------------------------------------------
// Demotions
// ---------------------------------------------------------------------------

export function recordDemotion(modelId: string, functionId: string, reason: string): void {
  db.prepare(`
    INSERT INTO engine_demotions (model_id, function_id, demoted, reason, demoted_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(model_id, function_id) DO UPDATE SET demoted = 1, reason = excluded.reason, demoted_at = excluded.demoted_at
  `).run(modelId, functionId, reason, new Date().toISOString());
}

export function loadDemotions(modelId: string): DemotionRecord[] {
  const rows = db.prepare('SELECT function_id, demoted, reason FROM engine_demotions WHERE model_id = ? AND demoted = 1')
    .all(modelId) as { function_id: string; demoted: number; reason: string }[];
  return rows.map((r) => ({ functionId: r.function_id, demoted: Boolean(r.demoted), reason: r.reason }));
}

export function clearDemotionsForModel(modelId: string): void {
  db.prepare('DELETE FROM engine_demotions WHERE model_id = ?').run(modelId);
}

// ---------------------------------------------------------------------------
// The consumer — trouble_signals -> demotion
// ---------------------------------------------------------------------------

/**
 * Consecutive failing turns, PERSISTED in engine_demotions.failure_streak.
 *
 * An in-memory Map resets on every restart, so two failures + a restart + a third never
 * reaches the threshold — on a server that restarts more often than a function fails three
 * times running, demotion would silently never fire.
 */
function readStreak(modelId: string, functionId: string): number {
  const row = db.prepare('SELECT failure_streak FROM engine_demotions WHERE model_id = ? AND function_id = ?')
    .get(modelId, functionId) as { failure_streak: number } | undefined;
  return row?.failure_streak ?? 0;
}

function writeStreak(modelId: string, functionId: string, streak: number): void {
  db.prepare(`
    INSERT INTO engine_demotions (model_id, function_id, demoted, reason, demoted_at, failure_streak)
    VALUES (?, ?, 0, '', ?, ?)
    ON CONFLICT(model_id, function_id) DO UPDATE SET failure_streak = excluded.failure_streak
  `).run(modelId, functionId, new Date().toISOString(), streak);
}

export interface TroubleSignalsPayload {
  model?: string;
  /** Which registry function this turn performed. Required for a demotion to be recorded. */
  functionId?: string;
  stepId?: string;
  escalationHint?: string;
  signals?: Record<string, unknown>;
}

/**
 * Fold one observed turn into the demotion state.
 *
 * A turn counts as failing when the engine's own signals say so. We deliberately read the
 * RAW signals rather than trusting `escalationHint` alone: the agreed contract is that raw
 * signals are truth and the rollup is a diagnostic, and a rollup we depend on becomes a
 * second policy that can drift from the first.
 */
export function observeTroubleSignals(functionId: string, payload: TroubleSignalsPayload): void {
  const modelId = payload.model;
  if (!modelId || !functionId) return;

  const s = (payload.signals ?? {}) as Record<string, unknown>;
  const reasons: string[] = [];
  if (s.proseInsteadOfToolCall === true) reasons.push('prose instead of tool call');
  if (s.emptyResponse === true) reasons.push('empty response');
  if (s.stepThrew === true) reasons.push('step threw');
  if (s.testSuite === 'red') reasons.push('test suite red');
  const failed = reasons.length > 0 || s.success === false;

  if (!failed) { writeStreak(modelId, functionId, 0); return; }

  const next = readStreak(modelId, functionId) + 1;
  if (next >= DEMOTION_CONSECUTIVE_FAILURES) {
    const why = reasons.length ? reasons.join(', ') : 'turn reported failure';
    recordDemotion(modelId, functionId, `${next} consecutive failing turns: ${why}`);
    writeStreak(modelId, functionId, 0);
  } else {
    writeStreak(modelId, functionId, next);
  }
}

/**
 * Entry point for the activity route. Trouble signals arrive at POST /api/activity with
 * eventType 'trouble_signals' and the payload packed into toolInput (the activities table
 * persists only a fixed column set, so extra top-level keys are silently dropped — which
 * is why the payload rides there).
 */
export function consumeActivityEvent(
  eventType: string,
  toolInput: string | undefined,
  agentId?: string,
): void {
  if (eventType !== 'trouble_signals' || !toolInput) return;
  let payload: TroubleSignalsPayload;
  try { payload = JSON.parse(toolInput) as TroubleSignalsPayload; } catch { return; }

  // THE MODEL ARRIVES HERE, not at registration. The relay registers a gridlight cartridge
  // with no model field at all (agent/relay/index.js has zero references to one), so
  // agents.model would stay '' forever and every lookup would miss. Every signal event, by
  // contrast, carries the model the turn actually ran on — so this is the real data path,
  // and persisting from it needs no CLI change and no new endpoint.
  if (agentId && payload.model) {
    try {
      db.prepare("UPDATE agents SET model = ? WHERE id = ? AND (model IS NULL OR model = '')")
        .run(payload.model, agentId);
    } catch { /* column may predate the migration on an unrestarted server */ }
  }

  // ATTRIBUTION IS A LOOKUP, NOT A GUESS. The payload names the STEP; workflow_steps
  // .executor_type IS a registry function id (the same mapping the launch path uses). So
  // stepId -> executor_type is exact.
  //
  // Measured on the 9 real events in this database: 7 carry a stepId, 6 carry a model, 6
  // carry both. The rest CANNOT be attributed, and they are DROPPED. Defaulting them would
  // pin a working function to frontier on evidence from a different one, and nothing
  // downstream could tell the difference.
  const functionId = payload.functionId || resolveFunctionIdFromStep(payload.stepId);
  if (!functionId) return;
  observeTroubleSignals(functionId, payload);
}

/** stepId -> the registry function that step performs, or null when it does not resolve. */
function resolveFunctionIdFromStep(stepId?: string): string | null {
  if (!stepId) return null;
  try {
    const row = db.prepare('SELECT executor_type FROM workflow_steps WHERE id = ?')
      .get(stepId) as { executor_type: string } | undefined;
    return row?.executor_type || null;
  } catch { return null; }
}
