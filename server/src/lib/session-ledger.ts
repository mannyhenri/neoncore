/**
 * WHAT THIS SESSION HAS ALREADY BEEN TOLD — so a later prompt can refer to it instead of repeating it.
 *
 * Every step of a workflow is typed into the same live agent session, and nothing clears it between
 * steps. Measured over the seeded catalogue (sandbox/workflow-test --profile): 53% of every
 * character NeonCore sent was something that same session had ALREADY been sent — the goal brief
 * and memory on every step (22%), the agent's own earlier results pasted back to it (15%), the
 * completion contract again (11%), a loop's full instructions on every iteration. All of it is then
 * carried, and re-read, for the rest of the session.
 *
 * The ledger records, per cartridge and per session, which blocks went in. A block the session
 * already holds is replaced by a one-line reference — and every reference that stands for real
 * content says where to FETCH it, so an agent that has lost it can get it back.
 *
 * ── WHEN THE SESSION IS TREATED AS NOT HOLDING IT ──────────────────────────────────────
 * The ledger starts over — and the next prompt carries everything in full — when:
 *  - the session changed (a new session id: restarted cartridge, /clear — including the /clear NeonCore
 *    itself sends to start a long run's next phase in a fresh session, see noteSessionCleared);
 *  - the session was COMPACTED since the ledger began (agents.context_compacted_at, reported from
 *    the transcript by agent/hooks/reporter.py);
 *  - LEDGER_REFRESH_DISPATCHES prompts have gone in since it began — a backstop for a compaction
 *    that has happened but not been reported yet;
 *  - the server restarted (the ledger lives in memory: losing it errs toward full prompts).
 *
 * Only engines whose compactions NeonCore can see get references at all. Others (Codex) get full prompts, as before.
 */
import { createHash } from 'node:crypto';
import db from '../db.js';

/** Full context again after this many dispatches into one session, compaction seen or not. */
export const LEDGER_REFRESH_DISPATCHES = 10;

/** Engines that report compactions (reporter.py); only they are sent references. */
const TRACKED_ENGINES = new Set(['claude']);

export interface SessionLedger {
  agentId: string;
  sessionId: string;
  /** ms epoch; anything dispatched before this is not assumed to be in context. */
  createdAt: number;
  /** block kind → hash of what was sent. */
  sent: Map<string, string>;
  /** The persona of the last dispatch, so consecutive steps in one role do not restate it. */
  lastRole: string | null;
  dispatches: number;
  /**
   * Step prompts each workflow run has typed into THIS session (workflowId → count). Survives the
   * LEDGER_REFRESH_DISPATCHES backstop — that refresh re-sends context, it does not empty the
   * session — and starts over only when the session really does (new id, compaction, /clear).
   * What decides when a long run gets a fresh session (workflow-executor-v2 freshSessionReason).
   */
  runDispatches: Map<string, number>;
  /**
   * NeonCore just cleared this session (/clear). The new session's id is not known until its
   * first hook fires — which is the very prompt this ledger is about to record — so the next
   * session id seen is adopted as this ledger's, instead of starting the ledger over a second time.
   */
  adoptNextSession: boolean;
}

const ledgers = new Map<string, SessionLedger>();

const hash = (text: string) => createHash('sha1').update(text).digest('hex');

/**
 * The ledger for the session `agentId` is in NOW, or null when references must not be used
 * (untracked engine, unknown session). Starts a fresh ledger whenever the old one cannot be trusted.
 */
export function sessionLedger(agentId: string): SessionLedger | null {
  if (!agentId) return null;
  const row = db.prepare('SELECT session_id, agent_type, context_compacted_at FROM agents WHERE id = ?')
    .get(agentId) as { session_id?: string; agent_type?: string; context_compacted_at?: string } | undefined;
  const sessionId = (row?.session_id || '').trim();
  if (!row || !sessionId || !TRACKED_ENGINES.has(String(row.agent_type || 'claude'))) return null;

  const compactedAt = row.context_compacted_at ? Date.parse(row.context_compacted_at) || 0 : 0;
  const current = ledgers.get(agentId);
  if (current?.adoptNextSession && current.sessionId !== sessionId) {
    current.sessionId = sessionId;
    current.adoptNextSession = false;
  }
  if (current && current.sessionId === sessionId && compactedAt < current.createdAt
      && current.dispatches < LEDGER_REFRESH_DISPATCHES) {
    return current;
  }
  // The refresh backstop re-sends context into the SAME session; the run's count carries over.
  const sameSession = !!current && current.sessionId === sessionId && compactedAt < current.createdAt;
  const fresh = newLedger(agentId, sessionId);
  if (sameSession) fresh.runDispatches = current!.runDispatches;
  ledgers.set(agentId, fresh);
  return fresh;
}

function newLedger(agentId: string, sessionId: string): SessionLedger {
  return {
    agentId, sessionId, createdAt: Date.now(), sent: new Map(), lastRole: null, dispatches: 0,
    runDispatches: new Map(), adoptNextSession: false,
  };
}

/**
 * The session was cleared — Claude reported SessionEnd with reason "clear" — so it holds nothing.
 * Starts the ledger over and adopts the next session id the cartridge reports (the one /clear
 * started). `adopt: false` only forgets: for a /clear that was sent but never confirmed, where the
 * next session id might just as well belong to a restarted cartridge that was told nothing.
 */
export function noteSessionCleared(agentId: string, opts: { adopt?: boolean } = {}): void {
  const row = db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agentId) as { session_id?: string } | undefined;
  const fresh = newLedger(agentId, (row?.session_id || '').trim());
  fresh.adoptNextSession = opts.adopt !== false;
  ledgers.set(agentId, fresh);
}

/** How many step prompts this run has typed into the ledger's session. */
export function runDispatchesIn(ledger: SessionLedger | null, workflowId: string): number {
  return ledger?.runDispatches.get(workflowId) ?? 0;
}

/** Has this exact block (by kind) already gone into this session? */
export function alreadySent(ledger: SessionLedger | null, kind: string, text: string): boolean {
  return !!ledger && ledger.sent.get(kind) === hash(text);
}

export function noteSent(ledger: SessionLedger | null, kind: string, text: string): void {
  if (ledger) ledger.sent.set(kind, hash(text));
}

/** One more prompt into this session — counted towards the refresh backstop. */
export function noteDispatch(ledger: SessionLedger | null): void {
  if (ledger) ledger.dispatches += 1;
}

/** A step's prompt went into this session — its report will be in the session's context too. */
export function noteStepDispatched(ledger: SessionLedger | null, stepId: string, workflowId?: string): void {
  if (!ledger) return;
  ledger.sent.set(`step:${stepId}`, 'dispatched');
  if (workflowId) ledger.runDispatches.set(workflowId, (ledger.runDispatches.get(workflowId) ?? 0) + 1);
}

/**
 * Did THIS session produce a step's result, recently enough that it is still in context? Only if
 * the step was dispatched into this very ledger — same cartridge, same session, and no compaction
 * or refresh since (either would have started a new ledger). Recorded, not inferred from
 * timestamps: a first step is dispatched milliseconds BEFORE the ledger it starts.
 */
export function producedInSession(ledger: SessionLedger | null, stepId: string): boolean {
  return !!ledger && ledger.sent.get(`step:${stepId}`) === 'dispatched';
}

/** Test seam. */
export function __resetLedgersForTests(): void {
  ledgers.clear();
}
