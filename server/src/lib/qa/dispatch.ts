/**
 * ASKING THE TARGET'S CARTRIDGE — author, repair and explore requests.
 *
 * Mirrors the Goal Pilot's delivery (goal-pilot-runner.ts dispatchPlannerRequest): the prompt is
 * stored on the request, sent with sendCommandToAgent (no work-standard offer: a QA request changes
 * no repo), and a busy cartridge is not typed into mid-turn — the request waits (`queued`) and the
 * QA sweep sends it once the cartridge is free. A request is failed when its cartridge finished
 * without submitting — the SAME rule as requestWentSilent: its turn ENDED after the request arrived
 * (or it went offline), not merely "idle", which the staleness sweep also sets mid-tool — or when it
 * ran past its budget.
 */
import { randomUUID } from 'crypto';
import db from '../../db.js';
import { sendCommandToAgent, noChannel } from '../send-command.js';
import { isCartridgeBusy } from '../queue-runner.js';
import { cartridgeExists } from '../cartridge-exists.js';
import { PLANNER_SILENT_MS, TURN_END_ENGINES } from '../goal-pilot-runner.js';
import type { RequestKind } from './types.js';

const nowIso = () => new Date().toISOString();

export interface QaRequest {
  id: string; runId: string; resultId: string; kind: RequestKind; agentId: string;
  status: 'pending' | 'ready' | 'failed' | 'superseded'; queued: boolean; context: Record<string, unknown>;
  prompt: string; result: unknown; error: string; createdAt: string; dispatchedAt: string | null; completedAt: string | null;
}

function toRequest(r: Record<string, unknown>): QaRequest {
  const parse = (s: unknown, f: unknown) => { try { return s ? JSON.parse(String(s)) : f; } catch { return f; } };
  return {
    id: String(r.id), runId: String(r.run_id), resultId: String(r.result_id ?? ''), kind: String(r.kind) as RequestKind,
    agentId: String(r.agent_id ?? ''), status: String(r.status) as QaRequest['status'], queued: Number(r.queued) === 1,
    context: parse(r.context, {}) as Record<string, unknown>, prompt: String(r.prompt ?? ''), result: parse(r.result, null),
    error: String(r.error ?? ''), createdAt: String(r.created_at), dispatchedAt: (r.dispatched_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
  };
}

export function getRequest(id: string): QaRequest | null {
  const r = db.prepare('SELECT * FROM qa_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toRequest(r) : null;
}
export function requestsOf(runId: string): QaRequest[] {
  return (db.prepare('SELECT * FROM qa_requests WHERE run_id = ? ORDER BY created_at').all(runId) as Record<string, unknown>[]).map(toRequest);
}

/** Sends a prompt to a cartridge. Injectable for tests; returns an error string when it could not. */
export type QaSender = (agentId: string, prompt: string) => { ok: true } | { ok: false; error: string };

export const sendToCartridge: QaSender = (agentId, prompt) => {
  const cmd = sendCommandToAgent(agentId, prompt, false, undefined, { standard: false });
  if (!cmd) return { ok: false, error: 'the cartridge no longer exists' };
  if (noChannel(cmd)) return { ok: false, error: 'the cartridge did not receive the request — is it connected?' };
  return { ok: true };
};
let sender: QaSender = sendToCartridge;
export function setQaSender(s: QaSender | null): void { sender = s ?? sendToCartridge; }

/** Called when a request fails without an answer (silence, budget, delivery) — the engine moves the run on. */
let onFailed: (req: QaRequest) => void = () => {};
export function onQaRequestFailed(fn: (req: QaRequest) => void): void { onFailed = fn; }

export function failRequest(id: string, error: string): void {
  const changed = db.prepare(`UPDATE qa_requests SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'pending'`)
    .run(error, nowIso(), id).changes;
  if (changed) onFailed(getRequest(id)!);
}

export function completeRequest(id: string, result: unknown): void {
  db.prepare(`UPDATE qa_requests SET status = 'ready', result = ?, completed_at = ? WHERE id = ?`).run(JSON.stringify(result ?? null), nowIso(), id);
}

/**
 * Create and send (or queue) a request. Returns the request; a request that could not be sent at
 * all comes back failed (and the run has been told).
 */
export function dispatchRequest(input: { runId: string; resultId?: string; kind: RequestKind; agentId: string; context?: Record<string, unknown>; prompt: (requestId: string) => string }): QaRequest {
  const id = randomUUID();
  db.prepare(`INSERT INTO qa_requests (id, run_id, result_id, kind, agent_id, context, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, input.runId, input.resultId ?? '', input.kind, input.agentId, JSON.stringify(input.context ?? {}), nowIso());
  db.prepare('UPDATE qa_requests SET prompt = ? WHERE id = ?').run(input.prompt(id), id);
  if (!cartridgeExists(input.agentId)) {
    failRequest(id, 'no cartridge is set for this target — pick one in the target settings');
    return getRequest(id)!;
  }
  if (isCartridgeBusy(input.agentId) || inFlightFor(input.agentId, id)) {
    db.prepare('UPDATE qa_requests SET queued = 1 WHERE id = ?').run(id);
    return getRequest(id)!;
  }
  deliver(id);
  return getRequest(id)!;
}

/**
 * ONE REQUEST IN FLIGHT PER CARTRIDGE: a cartridge's status turns `working` only once its hooks
 * fire, so a delivered, unanswered request must hold it — or two requests land back to back.
 */
function inFlightFor(agentId: string, exceptId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM qa_requests WHERE agent_id = ? AND id != ? AND status = 'pending' AND queued = 0 LIMIT 1`).get(agentId, exceptId);
}

function deliver(id: string): void {
  const req = getRequest(id);
  if (!req || req.status !== 'pending') return;
  const sent = sender(req.agentId, req.prompt);
  if (!sent.ok) { failRequest(id, sent.error); return; }
  db.prepare('UPDATE qa_requests SET dispatched_at = ?, queued = 0 WHERE id = ?').run(nowIso(), id);
}

/**
 * Has a delivered QA request's cartridge finished without submitting? Same rule as the Goal
 * Pilot's requestWentSilent: offline, or its turn ended after the request arrived — and either way
 * nothing since for PLANNER_SILENT_MS. An engine that never reports a turn end keeps idle-and-quiet.
 */
export function qaRequestWentSilent(req: QaRequest, now = Date.now()): boolean {
  if (req.status !== 'pending' || !req.dispatchedAt) return false;
  if (now - Date.parse(req.dispatchedAt) < PLANNER_SILENT_MS) return false;
  const agent = db.prepare('SELECT status, agent_type, turn_ended_at FROM agents WHERE id = ?').get(req.agentId) as
    { status?: string; agent_type?: string; turn_ended_at?: string } | undefined;
  if (agent?.status === 'working' || agent?.status === 'waiting') return false;
  if (agent && agent.status !== 'offline' && TURN_END_ENGINES.has(agent.agent_type || 'claude')) {
    const ended = Date.parse(agent.turn_ended_at || '');
    if (!(ended >= Date.parse(req.dispatchedAt))) return false;
  }
  const last = (db.prepare('SELECT MAX(timestamp) AS t FROM activity WHERE agent_id = ?').get(req.agentId) as { t?: string | null }).t;
  if (last && now - Date.parse(last) < PLANNER_SILENT_MS) return false;
  return true;
}

/** One pass: send queued requests whose cartridge is free; fail silent or over-budget ones. */
export function sweepQaRequests(now = Date.now(), budgetMinutesOf: (req: QaRequest) => number = () => 60): void {
  const pending = (db.prepare(`SELECT * FROM qa_requests WHERE status = 'pending'`).all() as Record<string, unknown>[]).map(toRequest);
  for (const req of pending) {
    if (req.queued) {
      if (!cartridgeExists(req.agentId)) failRequest(req.id, 'the cartridge no longer exists');
      else if (!isCartridgeBusy(req.agentId) && !inFlightFor(req.agentId, req.id)) deliver(req.id);
      continue;
    }
    if (qaRequestWentSilent(req, now)) { failRequest(req.id, 'the cartridge finished without submitting'); continue; }
    // A hard cap: twice the target's minutes budget, for a cartridge that keeps going forever.
    if (req.dispatchedAt && now - Date.parse(req.dispatchedAt) > budgetMinutesOf(req) * 2 * 60_000) {
      failRequest(req.id, `no answer within the run's budget (${budgetMinutesOf(req)} minutes)`);
    }
  }
}
