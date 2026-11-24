/**
 * ASKING A CARTRIDGE — triage, code-check, reproduce and fix requests. Mirrors lib/qa/dispatch.ts
 * and the Goal Pilot: a busy cartridge is not typed into (the request waits, `queued`), a worktree
 * cartridge that has not registered yet is waited for, and a request fails when its cartridge
 * finished without submitting — the SAME turn-end rule as requestWentSilent — or ran past budget.
 * Nothing is sent while the pause switch is on or the daily cap is reached.
 */
import { randomUUID } from 'crypto';
import db from '../../db.js';
import { sendCommandToAgent, noChannel } from '../send-command.js';
import { isCartridgeBusy } from '../queue-runner.js';
import { cartridgeExists } from '../cartridge-exists.js';
import { PLANNER_SILENT_MS, TURN_END_ENGINES } from '../goal-pilot-runner.js';
import { getSettings, nowIso } from './store.js';
import type { AgentStage } from './types.js';
import { sandbox } from './sandbox.js';

export interface TriageRequest {
  id: string; issueId: string; stage: AgentStage; agentId: string; resolvePath: string; resolveType: string;
  status: 'pending' | 'ready' | 'failed' | 'superseded'; queued: boolean; prompt: string; result: unknown; error: string;
  createdAt: string; dispatchedAt: string | null; completedAt: string | null;
}

function toRequest(r: Record<string, unknown>): TriageRequest {
  let result: unknown = null; try { result = r.result ? JSON.parse(String(r.result)) : null; } catch { /* corrupt */ }
  return {
    id: String(r.id), issueId: String(r.issue_id), stage: String(r.stage) as AgentStage, agentId: String(r.agent_id ?? ''),
    resolvePath: String(r.resolve_path ?? ''), resolveType: String(r.resolve_type ?? ''),
    status: String(r.status) as TriageRequest['status'], queued: Number(r.queued) === 1, prompt: String(r.prompt ?? ''),
    result, error: String(r.error ?? ''), createdAt: String(r.created_at),
    dispatchedAt: (r.dispatched_at as string | null) ?? null, completedAt: (r.completed_at as string | null) ?? null,
  };
}
export function getRequest(id: string): TriageRequest | null {
  const r = db.prepare('SELECT * FROM triage_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toRequest(r) : null;
}
export function requestsOf(issueId: string): TriageRequest[] {
  return (db.prepare('SELECT * FROM triage_requests WHERE issue_id = ? ORDER BY created_at, rowid').all(issueId) as Record<string, unknown>[]).map(toRequest);
}
export function openRequest(issueId: string): TriageRequest | null {
  const r = db.prepare(`SELECT * FROM triage_requests WHERE issue_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`).get(issueId) as Record<string, unknown> | undefined;
  return r ? toRequest(r) : null;
}

/** Sends a prompt to a cartridge. Injectable for tests. */
export type TriageSender = (agentId: string, prompt: string) => { ok: true } | { ok: false; error: string };
export const sendToCartridge: TriageSender = (agentId, prompt) => {
  const cmd = sendCommandToAgent(agentId, prompt, false, undefined, { standard: false });
  if (!cmd) return { ok: false, error: 'the cartridge no longer exists' };
  if (noChannel(cmd)) return { ok: false, error: 'the cartridge did not receive the request — is it connected?' };
  return { ok: true };
};
let sender: TriageSender = sendToCartridge;
export function setTriageSender(s: TriageSender | null): void { sender = s ?? sendToCartridge; }

let onFailed: (req: TriageRequest) => void = () => {};
export function onTriageRequestFailed(fn: (req: TriageRequest) => void): void { onFailed = fn; }

export function failRequest(id: string, error: string): void {
  const changed = db.prepare(`UPDATE triage_requests SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'pending'`)
    .run(error, nowIso(), id).changes;
  if (changed) onFailed(getRequest(id)!);
}
export function completeRequest(id: string, result: unknown): void {
  db.prepare(`UPDATE triage_requests SET status = 'ready', result = ?, completed_at = ? WHERE id = ?`).run(JSON.stringify(result ?? null), nowIso(), id);
}
export function supersedeOpen(issueId: string): void {
  db.prepare(`UPDATE triage_requests SET status = 'superseded', completed_at = ? WHERE issue_id = ? AND status = 'pending'`).run(nowIso(), issueId);
}

/** Requests delivered today (UTC), for the daily cap. */
export function dispatchedToday(now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return (db.prepare(`SELECT COUNT(*) AS n FROM triage_requests WHERE dispatched_at >= ?`).get(`${day}T00:00:00.000Z`) as { n: number }).n;
}
/** Why nothing may be sent right now, or null. */
export function dispatchBlocked(): string | null {
  const s = getSettings();
  if (s.paused) return 'Bug Triage is paused';
  if (dispatchedToday() >= s.dailyDispatchCap) return `the daily cap of ${s.dailyDispatchCap} requests is reached`;
  return null;
}

/**
 * Create and send (or queue) a request: to `agentId`, or to the cartridge that registers for
 * `resolvePath` (a worktree just launched). It is queued while the cartridge is busy, not yet
 * registered, or dispatch is blocked (paused / daily cap).
 */
export function dispatchRequest(input: { issueId: string; stage: AgentStage; agentId?: string; resolvePath?: string; resolveType?: string; prompt: (requestId: string) => string }): TriageRequest {
  const id = randomUUID();
  db.prepare(`INSERT INTO triage_requests (id, issue_id, stage, agent_id, resolve_path, resolve_type, queued, created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .run(id, input.issueId, input.stage, input.agentId ?? '', input.resolvePath ?? '', input.resolveType ?? '', nowIso());
  db.prepare('UPDATE triage_requests SET prompt = ? WHERE id = ?').run(input.prompt(id), id);
  tryDeliver(id);
  return getRequest(id)!;
}

/**
 * ONE REQUEST IN FLIGHT PER CARTRIDGE. `isCartridgeBusy` reads the cartridge's status, which only
 * turns `working` when its hooks fire — after the prompt lands. One sweep delivering every queued
 * request would paste them all into the same idle cartridge back to back. A request delivered
 * and not yet answered holds the cartridge until it is.
 */
function inFlightFor(agentId: string, exceptId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM triage_requests WHERE agent_id = ? AND id != ? AND status = 'pending' AND queued = 0 AND dispatched_at IS NOT NULL LIMIT 1`).get(agentId, exceptId);
}

/** Deliver a queued request if it may go now. True when it was sent. */
function tryDeliver(id: string): boolean {
  const req = getRequest(id);
  if (!req || req.status !== 'pending' || !req.queued) return false;
  if (dispatchBlocked()) return false;
  let agentId = req.agentId;
  if (!agentId && req.resolvePath) {
    agentId = sandbox().agentFor(req.resolvePath, req.resolveType) ?? '';
    if (!agentId) return false;   // the worktree's cartridge has not registered yet
    db.prepare('UPDATE triage_requests SET agent_id = ? WHERE id = ?').run(agentId, id);
  }
  if (!agentId || !cartridgeExists(agentId)) { failRequest(id, 'no cartridge for this request — set the triage cartridge in the source settings'); return false; }
  if (isCartridgeBusy(agentId)) return false;
  if (inFlightFor(agentId, id)) return false;
  const sent = sender(agentId, req.prompt);
  if (!sent.ok) { failRequest(id, sent.error); return false; }
  db.prepare('UPDATE triage_requests SET dispatched_at = ?, queued = 0 WHERE id = ?').run(nowIso(), id);
  db.prepare('UPDATE triage_issues SET dispatches = dispatches + 1 WHERE id = ?').run(req.issueId);
  return true;
}

/** Same rule as requestWentSilent (goal-pilot-runner.ts): its turn ENDED after delivery, or it went offline; then quiet. */
export function triageRequestWentSilent(req: TriageRequest, now = Date.now()): boolean {
  if (req.status !== 'pending' || !req.dispatchedAt) return false;
  if (now - Date.parse(req.dispatchedAt) < PLANNER_SILENT_MS) return false;
  const agent = db.prepare('SELECT status, agent_type, turn_ended_at FROM agents WHERE id = ?').get(req.agentId) as
    { status?: string; agent_type?: string; turn_ended_at?: string } | undefined;
  // background: its turn paused on its own running work — not silent (lib/background-tasks.ts).
  if (agent?.status === 'working' || agent?.status === 'waiting' || agent?.status === 'background') return false;
  if (agent && agent.status !== 'offline' && TURN_END_ENGINES.has(agent.agent_type || 'claude')) {
    const ended = Date.parse(agent.turn_ended_at || '');
    if (!(ended >= Date.parse(req.dispatchedAt))) return false;
  }
  const last = (db.prepare('SELECT MAX(timestamp) AS t FROM activity WHERE agent_id = ?').get(req.agentId) as { t?: string | null }).t;
  if (last && now - Date.parse(last) < PLANNER_SILENT_MS) return false;
  return true;
}

/** How long a worktree cartridge may take to register before its request fails. */
export const LAUNCH_WAIT_MS = 10 * 60_000;

/** One pass: deliver what may go; fail silent, never-launched or over-budget requests. */
export function sweepTriageRequests(now = Date.now(), budgetMinutesOf: (req: TriageRequest) => number = () => 90): void {
  const pending = (db.prepare(`SELECT * FROM triage_requests WHERE status = 'pending'`).all() as Record<string, unknown>[]).map(toRequest);
  for (const req of pending) {
    if (req.queued) {
      if (!tryDeliver(req.id) && req.resolvePath && !req.agentId && now - Date.parse(req.createdAt) > LAUNCH_WAIT_MS && !dispatchBlocked()) {
        failRequest(req.id, 'the issue\'s cartridge never came online in its worktree');
      }
      continue;
    }
    if (triageRequestWentSilent(req, now)) { failRequest(req.id, 'the cartridge finished without submitting'); continue; }
    if (req.dispatchedAt && now - Date.parse(req.dispatchedAt) > budgetMinutesOf(req) * 60_000) {
      failRequest(req.id, `no answer within the issue's budget (${budgetMinutesOf(req)} minutes)`);
    }
  }
}
