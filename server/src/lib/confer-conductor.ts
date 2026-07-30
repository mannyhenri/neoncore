import { v4 as uuid } from 'uuid';
import fs from 'fs';
import db from '../db.js';
import { getIO } from '../ws.js';
import { sendCommandToAgent } from './send-command.js';
import { deliverToAgent, fetchPeerAgent } from './peer-forward.js';
import { getServerBaseUrl } from './server-url.js';
import { createWorktree } from './worktree.js';
import { blockForRepo, parseAttachmentBlocks, type AttachmentBlocks } from './attachments.js';
import type { ConferSession, ConferMilestone } from '../types.js';

/** How the participants relate to the task. `divide` = split into per-agent slices;
 * `collaborate` = all work the ONE problem into one shared solution. */
export type ConferMode = 'collaborate' | 'divide';
/** `worktree` = each agent gets its own git worktree+branch (divide mode only). */
export type ConferIsolation = 'shared' | 'worktree';
/** agentId → the worktree provisioned for it (empty when isolation = shared). */
export type ConferWorktrees = Record<string, { path: string; branch: string }>;

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

// ── `divide` mode: split the task into per-agent slices, then merge ──────────────
// Each milestone dispatches to ALL participants and only advances when ALL signal done.
const DIVIDE_MILESTONES: MilestoneDef[] = [
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
      'GOAL: Merge all slices into one coherent, working whole — and prove there are no conflicts.',
      '1. Address the review feedback you received.',
      '2. Agree on ONE of you to integrate all slices; the other(s) verify it builds/passes.',
      '3. Resolve any conflicts together via neoncore_message_agent.',
      'Signal done once the combined work is integrated and EVERYONE has verified it works.',
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

// ── `collaborate` mode: everyone works the ONE problem into ONE shared solution ──
// No per-agent slices — one work product the whole panel drafts, critiques, and revises.
const COLLABORATE_MILESTONES: MilestoneDef[] = [
  {
    key: 'frame',
    name: 'Frame',
    body: () => [
      'GOAL: Agree on ONE approach to the ONE shared problem — do NOT split it up.',
      '1. Read your peers\' recent work (neoncore_read_agent) and the task carefully.',
      '2. Message the group (neoncore_message_agent) with your proposed approach + assumptions.',
      '3. Converge on ONE approach you will all build together (same solution, same files), and decide who drives the first draft.',
      'DO NOT carve the task into separate slices — you are solving one problem together. Signal done once you agree on the single approach AND who drafts first.',
    ].join('\n'),
  },
  {
    key: 'draft',
    name: 'Draft',
    body: () => [
      'GOAL: Produce ONE shared solution — together, not in parallel copies.',
      '1. The agreed driver writes the first complete draft of the solution.',
      '2. The other(s) contribute directly (suggest concrete edits, add missing pieces) via neoncore_message_agent — do NOT build a competing version.',
      '3. Stick to the ONE agreed approach; coordinate before changing direction.',
      'Signal done once a first complete draft of the shared solution exists.',
    ].join('\n'),
  },
  {
    key: 'critique',
    name: 'Critique',
    body: () => [
      'GOAL: Pressure-test the SHARED draft — everyone reviews the same work.',
      '1. Read the current shared solution (git diff).',
      '2. Find correctness gaps, edge cases, and risks — be specific with file:line.',
      '3. Send your critique to the group (neoncore_message_agent).',
      'Signal done once you have delivered your critique of the shared draft.',
    ].join('\n'),
  },
  {
    key: 'revise',
    name: 'Revise',
    body: () => [
      'GOAL: Fold every critique into the ONE solution.',
      '1. Work the critiques into the single shared solution together.',
      '2. Agree who applies each change so you do not both edit the same lines.',
      '3. Verify it builds/passes.',
      'Signal done once the revised shared solution builds and the group agrees it is ready.',
    ].join('\n'),
  },
  {
    key: 'finalize',
    name: 'Finalize',
    body: () => [
      'GOAL: Land the shared result.',
      '1. The agreed driver commits the solution with a clear message.',
      '2. Posts a short summary of what was built to the group.',
      '3. The others confirm it is accurate.',
      'Signal done to close out the confer.',
    ].join('\n'),
  },
];

const MILESTONE_SETS: Record<ConferMode, MilestoneDef[]> = {
  divide: DIVIDE_MILESTONES,
  collaborate: COLLABORATE_MILESTONES,
};

/** The milestone set for a mode (defaults to divide for legacy/unknown values). */
function milestonesFor(mode: string): MilestoneDef[] {
  return MILESTONE_SETS[mode as ConferMode] || DIVIDE_MILESTONES;
}

// Both sets have the same length; the cycle is always 5 milestones.
export const CONFER_MILESTONE_COUNT = DIVIDE_MILESTONES.length;

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
    mode: (row.mode as ConferMode) || 'divide',
    isolation: (row.isolation as ConferIsolation) || 'shared',
    worktrees: parseWorktrees(row.worktrees as string | undefined),
    milestones: milestones.map(hydrateMilestone),
  };
}

/** Safe-parse the worktrees JSON column into an agentId → {path,branch} map. */
function parseWorktrees(stored: string | undefined): ConferWorktrees {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ConferWorktrees) : {};
  } catch {
    return {};
  }
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

/**
 * Participants, including any owned by a peer server.
 *
 * A cartridge registers with exactly one server, so in a two-machine fleet half the
 * participants are routinely absent from this database. The local-only query did not just
 * fail to message them — it dropped them from the list, and the confer then ran as though
 * that machine had never been invited, waiting forever for a signal from an agent it had
 * silently excluded.
 *
 * A participant we cannot find anywhere is skipped rather than faked: better a confer with
 * a missing member, loudly, than one that pretends to include a machine that is switched off.
 */
async function loadParticipantsAcrossFleet(ids: string[]): Promise<Participant[]> {
  const local = loadParticipants(ids);
  const found = new Set(local.map((p) => p.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length === 0) return local;

  const hydrated = await Promise.all(missing.map((id) => fetchPeerAgent(id)));
  const remote: Participant[] = [];
  hydrated.forEach((a, i) => {
    if (!a) {
      console.warn(`[confer] participant ${missing[i]} is not on this server or any reachable peer — excluded`);
      return;
    }
    remote.push({
      id: (a.id as string) || missing[i],
      agentType: (a.agentType as string) || 'claude',
      name: (a.name as string) || '',
      status: (a.status as string) || 'idle',
      repoPath: (a.repoPath as string) || '',
    });
  });
  // Preserve the caller's ordering so "you are agent 2 of 3" stays stable.
  const byId = new Map([...local, ...remote].map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as Participant[];
}

/**
 * Provision a git worktree per participant whose repo lives on THIS machine (the server
 * runs the git commands locally, so it cannot create a worktree on a remote box). Each
 * gets its own branch, so per-agent work is isolated and independently mergeable at
 * Converge. A remote/missing repo is skipped — that agent works in its shared checkout.
 */
function provisionWorktrees(sessionId: string, participantIds: string[]): ConferWorktrees {
  const wt: ConferWorktrees = {};
  const shortId = sessionId.slice(0, 8);
  loadParticipants(participantIds).forEach((p, i) => {
    if (!p.repoPath || !fs.existsSync(p.repoPath)) {
      console.warn(`[confer] ${sessionId}: no server-local repo for ${p.agentType} ${p.id} (${p.repoPath || 'none'}) — skipping worktree; it works in its shared checkout.`);
      return;
    }
    try {
      const branch = `confer/${shortId}/${p.agentType}-${i + 1}`;
      const created = createWorktree(p.repoPath, branch);
      wt[p.id] = { path: created.path, branch: created.branch };
      console.log(`[confer] ${sessionId}: worktree for ${p.agentType} ${p.id} → ${created.path} (${created.branch})`);
    } catch (err) {
      console.warn(`[confer] ${sessionId}: worktree create failed for ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return wt;
}

/** Start a new confer: create the session + milestones, then dispatch milestone 0. */
export function startConfer(input: {
  repoName: string;
  repoPath: string;
  participantIds: string[];
  task: string;
  /** repoPath → prompt block for files attached at launch (see lib/attachments.ts). */
  attachmentBlocks?: AttachmentBlocks;
  mode?: ConferMode;
  isolation?: ConferIsolation;
}): ConferSession {
  const id = uuid();
  const now = new Date().toISOString();
  const mode: ConferMode = input.mode === 'collaborate' ? 'collaborate' : 'divide';
  // Worktree isolation only makes sense when agents own separate slices; a collaborate
  // confer produces ONE shared solution, so it always stays on the shared checkout.
  const isolation: ConferIsolation = mode === 'divide' && input.isolation === 'worktree' ? 'worktree' : 'shared';
  const worktrees = isolation === 'worktree' ? provisionWorktrees(id, input.participantIds) : {};

  db.prepare(
    `INSERT INTO confer_sessions (id, repo_name, repo_path, task, participant_ids, status, current_milestone, created_at, attachments, mode, isolation, worktrees)
     VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.repoName, input.repoPath, input.task, JSON.stringify(input.participantIds), now,
    JSON.stringify(input.attachmentBlocks || {}), mode, isolation, JSON.stringify(worktrees),
  );

  milestonesFor(mode).forEach((m, idx) => {
    db.prepare(
      `INSERT INTO confer_milestones (id, session_id, idx, key, name, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).run(uuid(), id, idx, m.key, m.name);
  });

  void dispatchMilestone(id, 0).catch((err) => console.error(`[confer] start dispatch failed: ${err}`));
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
  if (nextIdx < CONFER_MILESTONE_COUNT) {
    db.prepare('UPDATE confer_sessions SET current_milestone = ? WHERE id = ?').run(nextIdx, sessionId);
    void dispatchMilestone(sessionId, nextIdx).catch((err) => console.error(`[confer] advance dispatch failed: ${err}`));
  } else {
    db.prepare(`UPDATE confer_sessions SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, sessionId);
    console.log(`[confer] ${sessionId} completed all ${CONFER_MILESTONE_COUNT} milestones`);
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

    // Tell the participants to stop. Marking the session cancelled already makes the
    // conductor ignore it and rejects any late done-signal, but the agents are mid-milestone
    // and won't know unless we say so — otherwise "cancel" only stops the bookkeeping while
    // the engines keep working, which reads as "cancel didn't do anything". Best-effort:
    // a participant with no live channel just won't get the note.
    const participantIds: string[] = JSON.parse((row.participant_ids as string) || '[]');
    for (const pid of participantIds) {
      try {
        void deliverToAgent(
          pid,
          '[NeonCore Confer · cancelled] This confer has been cancelled. Stop working on the confer task and wait for new instructions.',
          (id, body) => sendCommandToAgent(id, body, false, undefined, { trackObjective: false }),
        );
      } catch (err) {
        console.warn(`[confer] ${id} cancel: could not notify ${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

/**
 * The worktree-isolation block for a given agent + milestone, or '' when this confer
 * isn't worktree-isolated (or this agent got no worktree — e.g. a remote participant).
 * Tells the agent to work only in its own worktree, names the peer branches for review,
 * and on Converge spells out that the merge IS the conflict check.
 */
function isolationLines(session: ConferSession, me: Participant, peers: Participant[], def: MilestoneDef): string {
  const wt = session.worktrees?.[me.id];
  if (!wt) return '';
  const peerBranches = peers
    .map((p) => session.worktrees?.[p.id]?.branch)
    .filter((b): b is string => !!b);
  const lines = [
    `YOUR ISOLATED WORKTREE — make ALL your changes here:`,
    `  cd "${wt.path}"   (branch: ${wt.branch})`,
    `Work ONLY in your worktree; do not touch your peers' worktrees or the shared checkout.`,
  ];
  if (peerBranches.length) lines.push(`Peer branches (for cross-review + converge): ${peerBranches.join(', ')}`);
  if (def.key === 'converge' && peerBranches.length) {
    lines.push(
      `CONVERGE = a REAL merge: the agreed integrator merges each peer branch into their own (\`git merge ${peerBranches.join(' ')}\`), resolves any git CONFLICTS (that is the whole point of this step), and verifies the combined result builds/passes before signalling done.`,
    );
  }
  return lines.join('\n');
}

/** Build the per-agent milestone prompt, including coordination guidance + the done-signal. */
function buildPrompt(
  session: ConferSession,
  idx: number,
  me: Participant,
  peers: Participant[],
  attachmentBlocks: AttachmentBlocks,
): string {
  const def = milestonesFor(session.mode)[idx];
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
  const worktreeLines = isolationLines(session, me, peers, def);
  return [
    `[NeonCore Confer · Milestone ${idx + 1}/${CONFER_MILESTONE_COUNT}: ${def.name}]`,
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
    ...(worktreeLines ? ['', worktreeLines] : []),
    ``,
    `COORDINATE: use neoncore_message_agent to talk to your peer(s) and neoncore_read_agent to see their work.`,
    ``,
    `WHEN THIS MILESTONE IS DONE, you MUST signal completion by running:`,
    `curl -s -X POST "${doneUrl}" -H "Content-Type: application/json" -d '{"result":"<1-2 line summary of what you did this milestone>"}'`,
    `The confer will NOT advance to the next milestone until every participant has signalled. After you signal, wait for the next milestone prompt.`,
  ].join('\n') + attachmentBlock;
}

/** Send milestone `idx` to every participant and mark it active. */
export async function dispatchMilestone(sessionId: string, idx: number): Promise<void> {
  const row = sessionRow(sessionId);
  if (!row) return;
  const session = hydrateSession(row);
  const participants = await loadParticipantsAcrossFleet(session.participantIds);
  const msRow = db.prepare('SELECT id FROM confer_milestones WHERE session_id = ? AND idx = ?').get(sessionId, idx) as { id: string } | undefined;
  if (!msRow) return;

  const now = new Date().toISOString();
  db.prepare(`UPDATE confer_milestones SET status = 'active', dispatched_at = ?, done_ids = '[]', nudged = 0 WHERE id = ?`)
    .run(now, msRow.id);

  const attachmentBlocks = parseAttachmentBlocks(row.attachments as string | undefined);
  const milestoneName = milestonesFor(session.mode)[idx].name;

  let undelivered = 0;
  for (const me of participants) {
    const peers = participants.filter((p) => p.id !== me.id);
    const prompt = buildPrompt(session, idx, me, peers, attachmentBlocks);
    // Fleet-aware: participants on a peer server are reached through their owner. Local
    // delivery still runs first and synchronously, so a single-server confer is unchanged.
    const out = await deliverToAgent(me.id, prompt, (id, body) => sendCommandToAgent(id, body, false));
    if (!out.delivered) {
      undelivered += 1;
      console.error(`[confer] ${sessionId} milestone ${idx} (${milestoneName}): NOT delivered to ${me.agentType} ${me.id} — ${out.reason || 'unknown'}`);
    } else if (out.origin) {
      console.log(`[confer] ${sessionId} milestone ${idx} → ${me.id} forwarded to ${out.origin}`);
    }
  }
  if (undelivered > 0) {
    db.prepare('UPDATE confer_sessions SET error = ? WHERE id = ?')
      .run(`Milestone "${milestoneName}" could not reach ${undelivered} participant(s) — is that cartridge running?`, sessionId);
  } else if (row.error) {
    db.prepare("UPDATE confer_sessions SET error = '' WHERE id = ?").run(sessionId);
  }
  console.log(`[confer] ${sessionId} dispatched milestone ${idx + 1}/${CONFER_MILESTONE_COUNT} (${milestoneName}) to ${participants.length} agent(s)`);
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
      void dispatchMilestone(row.id as string, idx).catch((err) => console.error(`[confer] watchdog dispatch failed: ${err}`));
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
          `[NeonCore Confer · reminder] You are on milestone ${idx + 1}/${CONFER_MILESTONE_COUNT} (${ms.name}) of the confer on ${session.repoName}. When you've finished it, signal done:\ncurl -s -X POST "${url}" -H "Content-Type: application/json" -d '{"result":"done"}'`,
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
