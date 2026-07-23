import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import { sendCommandToAgent } from './send-command.js';
import { getServerBaseUrl } from './server-url.js';
import { blockForRepo, parseAttachmentBlocks, type AttachmentBlocks } from './attachments.js';
import type { ConferSession, ConferMilestone } from '../types.js';

/**
 * Confer conductor — a standalone, milestone-driven collaboration loop for 2+ live
 * agents. It is deliberately NOT the workflow engine: its own tables, its own timer.
 *
 * The cycle for each milestone:
 *   dispatch the milestone prompt to EVERY participant  →  each agent works + coordinates
 *   with its peer(s)  →  each agent signals done (a curl baked into its prompt)  →  when
 *   ALL have signalled, mark the milestone done and auto-advance to the next  →  repeat.
 *
 * "Stop at a milestone" = a milestone stays `active` until every participant reports; there
 * is no idle inference. "Re-engage automatically" = advancing dispatches the next milestone
 * to both agents with no human step. A restart resumes a running session where it left off.
 */

const STALL_MS = 8 * 60 * 1000;   // re-nudge a participant that hasn't reported in this long
const FAIL_MS = 20 * 60 * 1000;   // give up on a milestone stuck this long

interface Participant {
  id: string;
  agentType: string;
  name: string;
  status: string;
  repoPath: string;
}

interface MilestoneDef {
  key: string;
  name: string;
  /** The body of the instruction for this milestone (coordination + done-signal are appended). */
  body: (task: string) => string;
}

// The "specific detailed approach": a two-agent build cycle. Each milestone dispatches to
// BOTH agents and only advances when BOTH have signalled done.
const MILESTONES: MilestoneDef[] = [
  {
    key: 'align',
    name: 'Align',
    body: () => [
      'GOAL: Agree on ONE shared plan and a concrete work split before any building.',
      '1. Read your peer\'s recent work with neoncore_read_agent, and read the task carefully.',
      '2. Message your peer (neoncore_message_agent) with your proposed approach + assumptions.',
      '3. Converge on ONE plan and split the work by area/files so you will not collide (state who owns what).',
      'DO NOT start implementing yet. Signal done only once you and your peer have agreed on the plan AND the split.',
    ].join('\n'),
  },
  {
    key: 'build',
    name: 'Build',
    body: () => [
      'GOAL: Implement YOUR agreed slice of the work.',
      '1. Build only the area you own from the Align split. Stay out of your peer\'s files.',
      '2. If you must touch a shared file, message your peer FIRST to coordinate.',
      '3. Keep your peer posted on meaningful progress via neoncore_message_agent.',
      'Signal done when your slice is implemented and it builds/works on its own.',
    ].join('\n'),
  },
  {
    key: 'review',
    name: 'Cross-review',
    body: () => [
      'GOAL: Review your PEER\'s work, not your own.',
      '1. Read what your peer built (neoncore_read_agent, and the git diff).',
      '2. Check correctness, how it integrates with your slice, and any gaps or risks.',
      '3. Send your concrete findings to your peer (neoncore_message_agent).',
      'Signal done once you have delivered your review to your peer.',
    ].join('\n'),
  },
  {
    key: 'converge',
    name: 'Converge',
    body: () => [
      'GOAL: Merge both slices into one coherent, working whole.',
      '1. Address the review feedback you received.',
      '2. Agree on ONE of you to integrate both slices; the other verifies it builds/passes.',
      '3. Resolve any conflicts together via neoncore_message_agent.',
      'Signal done once the combined work is integrated and BOTH of you have verified it works.',
    ].join('\n'),
  },
  {
    key: 'finalize',
    name: 'Finalize',
    body: () => [
      'GOAL: Land the combined result.',
      '1. The agreed integrator commits the combined work with a clear message.',
      '2. That agent posts a short summary (what was built + who did what) to the peer.',
      '3. The other confirms the summary is accurate.',
      'Signal done to close out the confer.',
    ].join('\n'),
  },
];

export const CONFER_MILESTONE_COUNT = MILESTONES.length;

// ── Row → type hydration ────────────────────────────────────────────────────

function hydrateMilestone(row: Record<string, unknown>): ConferMilestone {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    idx: row.idx as number,
    key: row.key as string,
    name: row.name as string,
    status: (row.status as ConferMilestone['status']) || 'pending',
    doneIds: JSON.parse((row.done_ids as string) || '[]'),
    dispatchedAt: (row.dispatched_at as string) || null,
    completedAt: (row.completed_at as string) || null,
  };
}

function hydrateSession(row: Record<string, unknown>): ConferSession {
  const milestones = db
    .prepare('SELECT * FROM confer_milestones WHERE session_id = ? ORDER BY idx')
    .all(row.id as string) as Record<string, unknown>[];
  return {
    id: row.id as string,
    repoName: (row.repo_name as string) || '',
    repoPath: (row.repo_path as string) || '',
    task: (row.task as string) || '',
    participantIds: JSON.parse((row.participant_ids as string) || '[]'),
    status: (row.status as ConferSession['status']) || 'running',
    currentMilestone: (row.current_milestone as number) || 0,
    error: (row.error as string) || '',
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) || null,
    milestones: milestones.map(hydrateMilestone),
  };
}

function sessionRow(id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM confer_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

function emit(id: string): ConferSession | null {
  const row = sessionRow(id);
  if (!row) return null;
  const session = hydrateSession(row);
  getIO().emit('confer_updated', session);
  return session;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getConfer(id: string): ConferSession | null {
  const row = sessionRow(id);
  return row ? hydrateSession(row) : null;
}

export function listConfers(): ConferSession[] {
  const rows = db
    .prepare('SELECT * FROM confer_sessions ORDER BY created_at DESC LIMIT 50')
    .all() as Record<string, unknown>[];
  return rows.map(hydrateSession);
}

function loadParticipants(ids: string[]): Participant[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, agent_type, name, status, repo_path FROM agents WHERE id IN (${ph})`)
    .all(...ids) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    agentType: (r.agent_type as string) || 'claude',
    name: (r.name as string) || '',
    status: (r.status as string) || 'idle',
    repoPath: (r.repo_path as string) || '',
  }));
}

/** Start a new confer: create the session + milestones, then dispatch milestone 0. */
export function startConfer(input: {
  repoName: string;
  repoPath: string;
  participantIds: string[];
  task: string;
  /** repoPath → prompt block for files attached at launch (see lib/attachments.ts). */
  attachmentBlocks?: AttachmentBlocks;
}): ConferSession {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO confer_sessions (id, repo_name, repo_path, task, participant_ids, status, current_milestone, created_at, attachments)
     VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?)`,
  ).run(
    id, input.repoName, input.repoPath, input.task, JSON.stringify(input.participantIds), now,
    JSON.stringify(input.attachmentBlocks || {}),
  );

  MILESTONES.forEach((m, idx) => {
    db.prepare(
      `INSERT INTO confer_milestones (id, session_id, idx, key, name, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).run(uuid(), id, idx, m.key, m.name);
  });

  dispatchMilestone(id, 0);
  return emit(id) || hydrateSession(sessionRow(id)!);
}

/**
 * Record that a participant finished the current milestone. When every participant has
 * reported, mark the milestone done and auto-advance (or finish the confer).
 */
export function recordMilestoneDone(sessionId: string, agentId: string, result: string): { ok: boolean; error?: string } {
  const row = sessionRow(sessionId);
  if (!row) return { ok: false, error: 'confer not found' };
  if (row.status !== 'running') return { ok: false, error: `confer is ${row.status}` };

  const idx = row.current_milestone as number;
  const participantIds: string[] = JSON.parse((row.participant_ids as string) || '[]');
  if (!participantIds.includes(agentId)) return { ok: false, error: 'not a participant of this confer' };

  const msRow = db
    .prepare('SELECT * FROM confer_milestones WHERE session_id = ? AND idx = ?')
    .get(sessionId, idx) as Record<string, unknown> | undefined;
  if (!msRow) return { ok: false, error: 'active milestone not found' };

  const doneIds: string[] = JSON.parse((msRow.done_ids as string) || '[]');
  const results: Record<string, string> = JSON.parse((msRow.results as string) || '{}');
  if (!doneIds.includes(agentId)) doneIds.push(agentId);
  results[agentId] = String(result || '').slice(0, 20000);
  db.prepare('UPDATE confer_milestones SET done_ids = ?, results = ? WHERE id = ?')
    .run(JSON.stringify(doneIds), JSON.stringify(results), msRow.id as string);

  const allDone = participantIds.every((pid) => doneIds.includes(pid));
  if (!allDone) {
    emit(sessionId);
    return { ok: true };
  }

  // Milestone complete → mark done and advance.
  const now = new Date().toISOString();
  db.prepare(`UPDATE confer_milestones SET status = 'done', completed_at = ? WHERE id = ?`).run(now, msRow.id as string);

  const nextIdx = idx + 1;
  if (nextIdx < MILESTONES.length) {
    db.prepare('UPDATE confer_sessions SET current_milestone = ? WHERE id = ?').run(nextIdx, sessionId);
    dispatchMilestone(sessionId, nextIdx);
  } else {
    db.prepare(`UPDATE confer_sessions SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, sessionId);
    console.log(`[confer] ${sessionId} completed all ${MILESTONES.length} milestones`);
  }
  emit(sessionId);
  return { ok: true };
}

export function cancelConfer(id: string): ConferSession | null {
  const row = sessionRow(id);
  if (!row) return null;
  if (row.status === 'running') {
    db.prepare(`UPDATE confer_sessions SET status = 'cancelled', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }
  return emit(id);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Base URL a confer participant should call back on.
 *
 * Must resolve to a host reachable from OTHER machines: a confer routinely spans
 * boxes (e.g. the orchestrator on Mannys-Mac-Pro.local and a peer on a laptop),
 * and this URL is pasted verbatim into the milestone prompt as a curl command.
 * This used to hardcode `http://localhost:<port>`, so an off-box participant
 * POSTed its done-signal to its OWN localhost — nothing listening, the signal
 * vanished, and the confer hung forever waiting on a milestone that had in fact
 * been completed.
 *
 * getServerBaseUrl() prefers the machine's network name (mDNS "Foo.local") over a
 * raw IP precisely because a DHCP lease changes and would silently break this
 * again. It is resolved per call, not cached, so a lease change is picked up on
 * the next dispatch.
 */
function baseUrl(): string {
  return getServerBaseUrl();
}

/** Build the per-agent milestone prompt, including coordination guidance + the done-signal. */
function buildPrompt(
  session: ConferSession,
  idx: number,
  me: Participant,
  peers: Participant[],
  attachmentBlocks: AttachmentBlocks,
): string {
  const def = MILESTONES[idx];
  const peerLines = peers.map((p) => `- ${p.agentType} (${p.name || session.repoName}) — agentId: ${p.id}`).join('\n');
  // `${NEONCORE_URL:-...}` is shell, not a JS template — it is expanded by the
  // agent's shell when it runs the curl, so a participant whose relay already
  // exported NEONCORE_URL uses its own known-good value and the server's guess is
  // only the fallback. Mirrors the webhook suffixes in workflow-executor-v2.
  const doneUrl = `\${NEONCORE_URL:-${baseUrl()}}/api/confer/${session.id}/milestone/${me.id}/done`;
  // Attachments ride along on EVERY milestone, not just Align — the reviewer on
  // Cross-review needs the same screenshot/log the builder had, and each milestone is a
  // fresh prompt with no memory of the last one.
  const attachmentBlock = blockForRepo(attachmentBlocks, me.repoPath);
  return [
    `[NeonCore Confer · Milestone ${idx + 1}/${MILESTONES.length}: ${def.name}]`,
    `You are collaborating with ${peers.length} other agent(s) on ONE task. Work together — do not work in isolation.`,
    ``,
    `OVERALL TASK:`,
    session.task,
    ``,
    `YOUR PEER(S):`,
    peerLines,
    ``,
    `THIS MILESTONE — ${def.name}:`,
    def.body(session.task),
    ``,
    `COORDINATE: use neoncore_message_agent to talk to your peer(s) and neoncore_read_agent to see their work.`,
    ``,
    `WHEN THIS MILESTONE IS DONE, you MUST signal completion by running:`,
    `curl -s -X POST "${doneUrl}" -H "Content-Type: application/json" -d '{"result":"<1-2 line summary of what you did this milestone>"}'`,
    `The confer will NOT advance to the next milestone until every participant has signalled. After you signal, wait for the next milestone prompt.`,
  ].join('\n') + attachmentBlock;
}

/** Send milestone `idx` to every participant and mark it active. */
export function dispatchMilestone(sessionId: string, idx: number): void {
  const row = sessionRow(sessionId);
  if (!row) return;
  const session = hydrateSession(row);
  const participants = loadParticipants(session.participantIds);
  const msRow = db.prepare('SELECT id FROM confer_milestones WHERE session_id = ? AND idx = ?').get(sessionId, idx) as { id: string } | undefined;
  if (!msRow) return;

  const now = new Date().toISOString();
  db.prepare(`UPDATE confer_milestones SET status = 'active', dispatched_at = ?, done_ids = '[]', nudged = 0 WHERE id = ?`)
    .run(now, msRow.id);

  const attachmentBlocks = parseAttachmentBlocks(row.attachments as string | undefined);

  let undelivered = 0;
  for (const me of participants) {
    const peers = participants.filter((p) => p.id !== me.id);
    const prompt = buildPrompt(session, idx, me, peers, attachmentBlocks);
    const cmd = sendCommandToAgent(me.id, prompt, false);
    if (!cmd || cmd.delivered === false) {
      undelivered += 1;
      console.error(`[confer] ${sessionId} milestone ${idx} (${MILESTONES[idx].name}): NOT delivered to ${me.agentType} ${me.id}`);
    }
  }
  if (undelivered > 0) {
    db.prepare('UPDATE confer_sessions SET error = ? WHERE id = ?')
      .run(`Milestone "${MILESTONES[idx].name}" could not reach ${undelivered} participant(s) — is that cartridge running?`, sessionId);
  } else if (row.error) {
    db.prepare("UPDATE confer_sessions SET error = '' WHERE id = ?").run(sessionId);
  }
  console.log(`[confer] ${sessionId} dispatched milestone ${idx + 1}/${MILESTONES.length} (${MILESTONES[idx].name}) to ${participants.length} agent(s)`);
}

// ── Watchdog / recovery ───────────────────────────────────────────────────────

/**
 * Re-nudge participants who haven't reported on an active milestone in a while, and fail a
 * milestone that has been stuck far too long. Also resumes a running session whose current
 * milestone was never dispatched (crash between advance and dispatch).
 */
export function reconcileConfers(now = Date.now()): void {
  const running = db.prepare("SELECT * FROM confer_sessions WHERE status = 'running'").all() as Record<string, unknown>[];
  for (const row of running) {
    const idx = row.current_milestone as number;
    const ms = db.prepare('SELECT * FROM confer_milestones WHERE session_id = ? AND idx = ?').get(row.id as string, idx) as Record<string, unknown> | undefined;
    if (!ms) continue;

    // Crash between advance and dispatch: current milestone still pending → dispatch it.
    if (ms.status === 'pending') {
      dispatchMilestone(row.id as string, idx);
      continue;
    }
    if (ms.status !== 'active' || !ms.dispatched_at) continue;

    const age = now - Date.parse(ms.dispatched_at as string);
    const participantIds: string[] = JSON.parse((row.participant_ids as string) || '[]');
    const doneIds: string[] = JSON.parse((ms.done_ids as string) || '[]');
    const pending = participantIds.filter((pid) => !doneIds.includes(pid));
    if (pending.length === 0) continue;

    if (age > FAIL_MS) {
      db.prepare(`UPDATE confer_sessions SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
        .run(`Milestone "${ms.name}" stalled — ${pending.length} participant(s) never reported.`, new Date().toISOString(), row.id as string);
      emit(row.id as string);
      continue;
    }

    if (age > STALL_MS && !(ms.nudged as number)) {
      db.prepare('UPDATE confer_milestones SET nudged = 1 WHERE id = ?').run(ms.id as string);
      const session = hydrateSession(row);
      for (const pid of pending) {
        const url = `${baseUrl()}/api/confer/${row.id}/milestone/${pid}/done`;
        sendCommandToAgent(
          pid,
          `[NeonCore Confer · reminder] You are on milestone ${idx + 1}/${MILESTONES.length} (${ms.name}) of the confer on ${session.repoName}. When you've finished it, signal done:\ncurl -s -X POST "${url}" -H "Content-Type: application/json" -d '{"result":"done"}'`,
          false,
        );
      }
      console.log(`[confer] ${row.id} nudged ${pending.length} participant(s) on milestone ${idx + 1}`);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startConferConductor(): void {
  if (timer) return;
  try { reconcileConfers(); } catch (err) { console.error('[confer] startup reconcile failed:', err); }
  timer = setInterval(() => {
    try { reconcileConfers(); } catch (err) { console.error('[confer] reconcile failed:', err); }
  }, 30_000);
  console.log('[confer] conductor started');
}
