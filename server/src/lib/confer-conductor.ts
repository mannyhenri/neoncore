import { v4 as uuid } from 'uuid';
import fs from 'fs';
import db from '../db.js';
import { libelleContexte } from './context-label.js';
import { getIO, agentHasLiveSocket } from '../ws.js';
import { inboxReachable } from './inbox-client.js';
import { sendCommandToAgent } from './send-command.js';
import { deliverToAgent, fetchPeerAgent } from './peer-forward.js';
import { busyRepoSiblings } from './queue-runner.js';
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
const FAIL_MS = 20 * 60 * 1000;   // past this, a milestone only survives if its participants are ALIVE
/**
 * How long a participant may go unseen before it counts as gone.
 *
 * A heartbeat lands on every tool call, so ten minutes of total silence from something claiming
 * to be `working` means the process is not there any more, whatever its status column says.
 */
const PARTICIPANT_DEAD_MS = 10 * 60 * 1000;
/**
 * The ceiling. A milestone whose participants are alive but silent is kept going — that is the
 * whole fix — but "kept going" cannot mean forever, or a confer hangs overnight looking like
 * progress. Past this it stops with an error that says the participant was ALIVE, which is a
 * different diagnosis from "it died" and points at the real bug: work finished, never signalled.
 */
const HARD_FAIL_MS = 4 * 60 * 60 * 1000;

/**
 * Is this participant still there?
 *
 * The conductor used to ask only "how long has this milestone been open", so an agent that had
 * done the work and gone idle was treated exactly like one that had crashed — and the first is
 * far more common. Eight sessions were failed this way before anyone looked.
 */
export function participantIsAlive(agentId: string, now: number): boolean {
  const a = db.prepare('SELECT status, last_seen, inbox_pid FROM agents WHERE id = ?').get(agentId) as
    { status?: string; last_seen?: string; inbox_pid?: number } | undefined;
  if (!a || a.status === 'offline') return false;
  const seen = Date.parse(a.last_seen || '');
  if (!Number.isNaN(seen) && now - seen < PARTICIPANT_DEAD_MS) return true;
  // Hook activity is not a connection heartbeat. Idle sessions may be silent for hours while
  // their relay or addressed inbox remains reachable and able to receive the next milestone.
  return agentHasLiveSocket(agentId) || (process.platform !== 'win32' && inboxReachable(a.inbox_pid || 0));
}

/** Ceiling on build rounds. High enough for a 20-bug list, low enough that a typo'd 500 can't
 * dispatch 500 milestones to a live fleet. */
export const MAX_BUILD_ROUNDS = 20;

interface Participant {
  id: string;
  agentType: string;
  name: string;
  status: string;
  repoPath: string;
}

/** What a milestone body needs to know: the task, and where it sits in a repeated step. */
interface MilestoneContext {
  task: string;
  /** 1-based round within an iterating milestone (always 1 for the others). */
  round: number;
  /** Total rounds for THIS milestone (1 unless it is the iterating one). */
  rounds: number;
  /**
   * The session's build-round count, visible to EVERY milestone — the planning step has to
   * say "we get N passes" before the first build, or the batching it agrees on is a guess.
   */
  buildRounds: number;
}

interface MilestoneDef {
  key: string;
  name: string;
  /**
   * The build/fix step — the ONE milestone a confer may run N times. Exactly one per mode:
   * round numbering (and the UI stepper) has no way to express two nested repeats.
   */
  iterates?: boolean;
  /** The body of the instruction for this milestone (coordination + done-signal are appended). */
  body: (ctx: MilestoneContext) => string;
}

/**
 * The instruction that makes a build round a BATCH rather than a retry.
 *
 * Without it, "build again" reads as "have another go at the same thing" and three rounds
 * produce the same three fixes three times. With it, each round claims the next unfinished
 * items, names them, and finishes them — which is what makes a 20-item list tractable.
 */
function batchLine(round: number, rounds: number): string {
  return round < rounds
    ? `4. THIS ROUND IS A BATCH: take the next unfinished items IN ORDER, say which ones you took, and finish them completely (code + verification). Leave the rest for the ${rounds - round} round(s) that follow — do not stop after one item, and do not skip ahead.`
    : '4. FINAL ROUND: everything still outstanding is due now — there is no round after this one. If an item genuinely cannot be done, say so explicitly in your done signal rather than leaving it silent.';
}

/**
 * What the planning milestone must decide when the build repeats: the batching. Agreed BEFORE
 * the first build, because "the next batch" only means something if both agents are reading the
 * same ordered list.
 */
function batchPlanLine(buildRounds: number): string {
  return `4. THIS CONFER HAS ${buildRounds} BUILD ROUNDS. Enumerate the work as an ordered list of items (if the task points at a document of bugs/findings, that list IS the enumeration — count it and say the number), then agree how it is batched across the ${buildRounds} rounds. Each round ends with a commit + push, so a batch must be a shippable chunk.`;
}

/** How much runway is left, said out loud so an agent can pace itself. */
function roundsLeftLine(round: number, rounds: number): string {
  return round < rounds
    ? `${rounds - round} more build round(s) follow this one.`
    : 'This is the LAST build round.';
}

// ── `divide` mode: split the task into per-agent slices, then merge ──────────────
// Each milestone dispatches to ALL participants and only advances when ALL signal done.
const DIVIDE_MILESTONES: MilestoneDef[] = [
  {
    key: 'align',
    name: 'Align',
    body: ({ buildRounds }) => [
      'GOAL: Agree on ONE shared plan and a concrete work split before any building.',
      '1. Read your peer\'s recent work with neoncore_read_agent, and read the task carefully.',
      '2. Message your peer (neoncore_message_agent) with your proposed approach + assumptions.',
      '3. Converge on ONE plan and split the work by area/files so you will not collide (state who owns what).',
      ...(buildRounds > 1 ? [batchPlanLine(buildRounds)] : []),
      'DO NOT start implementing yet. Signal done only once you and your peer have agreed on the plan AND the split.',
    ].join('\n'),
  },
  {
    key: 'build',
    name: 'Build',
    iterates: true,
    body: ({ round, rounds }) => [
      rounds > 1
        ? `GOAL: Build round ${round} of ${rounds} — implement the NEXT batch of YOUR agreed slice, then commit and push it.`
        : 'GOAL: Implement YOUR agreed slice of the work.',
      '1. Build only the area you own from the Align split. Stay out of your peer\'s files.',
      '2. If you must touch a shared file, message your peer FIRST to coordinate.',
      '3. Keep your peer posted on meaningful progress via neoncore_message_agent.',
      ...(rounds > 1 ? [batchLine(round, rounds)] : []),
      rounds > 1
        ? `Signal done once this round's items are implemented, verified, committed and PUSHED. ${roundsLeftLine(round, rounds)}`
        : 'Signal done when your slice is implemented and it builds/works on its own.',
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
    body: ({ buildRounds }) => [
      'GOAL: Agree on ONE approach to the ONE shared problem — do NOT split it up.',
      '1. Read your peers\' recent work (neoncore_read_agent) and the task carefully.',
      '2. Message the group (neoncore_message_agent) with your proposed approach + assumptions.',
      '3. Converge on ONE approach you will all build together (same solution, same files), and decide who drives the first draft.',
      ...(buildRounds > 1 ? [batchPlanLine(buildRounds)] : []),
      'DO NOT carve the task into separate slices — you are solving one problem together. Signal done once you agree on the single approach AND who drafts first.',
    ].join('\n'),
  },
  {
    key: 'draft',
    name: 'Draft',
    iterates: true,
    body: ({ round, rounds }) => [
      rounds > 1
        ? `GOAL: Draft round ${round} of ${rounds} — take the NEXT batch of the shared work through to a committed, pushed state.`
        : 'GOAL: Produce ONE shared solution — together, not in parallel copies.',
      round === 1
        ? '1. The agreed driver writes the first complete draft of the solution.'
        : '1. Continue the SAME shared solution from where the last round left it — do not restart it.',
      '2. The other(s) contribute directly (suggest concrete edits, add missing pieces) via neoncore_message_agent — do NOT build a competing version.',
      '3. Stick to the ONE agreed approach; coordinate before changing direction.',
      ...(rounds > 1 ? [batchLine(round, rounds)] : []),
      rounds > 1
        ? `Signal done once this round's items are in the shared solution, verified, committed and PUSHED. ${roundsLeftLine(round, rounds)}`
        : 'Signal done once a first complete draft of the shared solution exists.',
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

/** Every collaboration shape a confer can run. Derived, so a new mode is covered by tests. */
export const CONFER_MODES = Object.keys(MILESTONE_SETS) as ConferMode[];

/** The key of the build/fix milestone this mode repeats, or '' if it has none. */
export function iteratingKeyFor(mode: string): string {
  return milestonesFor(mode).find((m) => m.iterates)?.key || '';
}

// The base cycle — 5 milestones. The ACTUAL count of a session is base − 1 + buildRounds, so
// nothing may compute a total from this constant; use the session's own milestone rows.
export const CONFER_MILESTONE_COUNT = DIVIDE_MILESTONES.length;

/**
 * A round count that can be dispatched. Anything unusable becomes 1 rather than an error:
 * a confer that refuses to start because a text field held "3 " is worse than one that
 * builds once, and the UI already offers a number picker.
 */
export function clampBuildRounds(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_BUILD_ROUNDS, Math.max(1, Math.floor(n)));
}

/** One milestone as it will actually be run — the build step appears `rounds` times. */
export interface ConferPlanStep {
  key: string;
  /** Display name; a repeated build step is suffixed "2/5" so the stepper can tell them apart. */
  name: string;
  /** 1-based round within the repeated step (1 for every non-repeated milestone). */
  round: number;
  /** Total rounds of the repeated step (1 when not iterated). */
  rounds: number;
}

/**
 * Expand a mode's milestone set for `buildRounds` build passes.
 *
 * The expansion happens ONCE, at start, and is persisted as ordinary milestone rows — so the
 * watchdog, the advance logic, the stepper and a mid-flight restart all keep working on plain
 * indices with no notion of a loop. A run counter that lived only in the conductor would have
 * been lost on the first server restart, which is exactly when a 6-round build is still going.
 */
export function conferPlan(mode: string, buildRounds: unknown = 1): ConferPlanStep[] {
  const rounds = clampBuildRounds(buildRounds);
  const steps: ConferPlanStep[] = [];
  for (const def of milestonesFor(mode)) {
    if (!def.iterates) {
      steps.push({ key: def.key, name: def.name, round: 1, rounds: 1 });
      continue;
    }
    for (let r = 1; r <= rounds; r++) {
      steps.push({
        key: def.key,
        name: rounds > 1 ? `${def.name} ${r}/${rounds}` : def.name,
        round: r,
        rounds,
      });
    }
  }
  return steps;
}

// ── Row → type hydration ────────────────────────────────────────────────────

function hydrateMilestone(row: Record<string, unknown>): ConferMilestone {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    idx: row.idx as number,
    key: row.key as string,
    name: row.name as string,
    round: (row.round as number) || 1,
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
    // A confer's `task` is the whole prompt — sometimes a paragraph. `taskLabel` is the short
    // subject a list row can actually show, derived the same way a workflow run's is so the two
    // surfaces name the same work identically.
    taskLabel: libelleContexte((row.task as string) || ''),
    participantIds: JSON.parse((row.participant_ids as string) || '[]'),
    status: (row.status as ConferSession['status']) || 'running',
    currentMilestone: (row.current_milestone as number) || 0,
    error: (row.error as string) || '',
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) || null,
    mode: (row.mode as ConferMode) || 'divide',
    buildRounds: (row.build_rounds as number) || 1,
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

/** How many milestones THIS session actually has (base cycle expanded by its build rounds). */
function milestoneCount(sessionId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM confer_milestones WHERE session_id = ?').get(sessionId) as { n: number };
  return row?.n || 0;
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

/**
 * Which run owns each session, keyed by session id.
 *
 * `confer_sessions` holds no back-reference to the step that created it — the link lives the
 * other way, in `workflow_steps.executor_config.conferSessionId` (written at
 * lib/workflow-executor-v2.ts:687). Without it the client cannot tell a confer that IS a
 * workflow step from a standalone one, so it lists both beside the runs and a workflow confer
 * appears twice: once as its run, once as its session. Reported as "2 confers running at the
 * same time for baseback and backend-interlag".
 *
 * One query for the whole list rather than one per session, and joined against `workflows` so
 * a step whose run was deleted resolves to nothing. A dangling id would be worse than none:
 * every surface hides owned sessions, so the confer would vanish with no run left to show it.
 */
function owningRuns(): Map<string, { workflowId: string; stepId: string }> {
  const rows = db.prepare(
    `SELECT s.id AS step_id, s.workflow_id, json_extract(s.executor_config, '$.conferSessionId') AS session_id
       FROM workflow_steps s
       JOIN workflows w ON w.id = s.workflow_id
      WHERE session_id IS NOT NULL AND session_id != ''`,
  ).all() as { step_id: string; workflow_id: string; session_id: string }[];
  const out = new Map<string, { workflowId: string; stepId: string }>();
  for (const r of rows) out.set(r.session_id, { workflowId: r.workflow_id, stepId: r.step_id });
  return out;
}

export function listConfers(): ConferSession[] {
  const rows = db
    .prepare('SELECT * FROM confer_sessions ORDER BY created_at DESC LIMIT 50')
    .all() as Record<string, unknown>[];
  const owners = owningRuns();
  return rows.map((r) => {
    const session = hydrateSession(r);
    const owner = owners.get(session.id);
    return { ...session, workflowId: owner?.workflowId ?? null, stepId: owner?.stepId ?? null };
  });
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
  /** How many times the build/fix milestone runs (1 = the classic single build). */
  buildRounds?: number;
}): ConferSession {
  const id = uuid();
  const now = new Date().toISOString();
  const mode: ConferMode = input.mode === 'collaborate' ? 'collaborate' : 'divide';
  const buildRounds = clampBuildRounds(input.buildRounds);
  // Worktree isolation only makes sense when agents own separate slices; a collaborate
  // confer produces ONE shared solution, so it always stays on the shared checkout.
  const isolation: ConferIsolation = mode === 'divide' && input.isolation === 'worktree' ? 'worktree' : 'shared';
  const worktrees = isolation === 'worktree' ? provisionWorktrees(id, input.participantIds) : {};

  db.prepare(
    `INSERT INTO confer_sessions (id, repo_name, repo_path, task, participant_ids, status, current_milestone, created_at, attachments, mode, isolation, worktrees, build_rounds)
     VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.repoName, input.repoPath, input.task, JSON.stringify(input.participantIds), now,
    JSON.stringify(input.attachmentBlocks || {}), mode, isolation, JSON.stringify(worktrees), buildRounds,
  );

  conferPlan(mode, buildRounds).forEach((m, idx) => {
    db.prepare(
      `INSERT INTO confer_milestones (id, session_id, idx, key, name, round, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(uuid(), id, idx, m.key, m.name, m.round);
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

  // The total comes from the session's OWN rows, never from the base cycle length: a confer
  // with 6 build rounds has 10 milestones, and finishing at 5 would abandon four rounds of
  // fixes while reporting success.
  const total = milestoneCount(sessionId);
  const nextIdx = idx + 1;
  if (nextIdx < total) {
    db.prepare('UPDATE confer_sessions SET current_milestone = ? WHERE id = ?').run(nextIdx, sessionId);
    void dispatchMilestone(sessionId, nextIdx).catch((err) => console.error(`[confer] advance dispatch failed: ${err}`));
  } else {
    db.prepare(`UPDATE confer_sessions SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, sessionId);
    console.log(`[confer] ${sessionId} completed all ${total} milestones`);
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

/** Resume a failed confer at its active milestone, retaining every acknowledgement. */
export async function resumeConfer(id: string): Promise<{ ok: true; session: ConferSession; delivered: number } | { ok: false; error: string }> {
  const row = sessionRow(id);
  if (!row) return { ok: false, error: 'confer not found' };
  if (row.status !== 'failed') return { ok: false, error: `confer is ${row.status}, not failed` };
  const session = hydrateSession(row);
  const idx = session.currentMilestone;
  const milestone = session.milestones?.[idx];
  if (!milestone || milestone.status !== 'active') return { ok: false, error: 'no active milestone to resume' };
  const pending = session.participantIds.filter(pid => !milestone.doneIds.includes(pid));
  if (pending.length === 0) return { ok: false, error: 'all participants already reported; reconcile the milestone first' };
  const missing = session.participantIds.filter(pid => !participantIsAlive(pid, Date.now()));
  if (missing.length) return { ok: false, error: `participant(s) still unreachable: ${missing.join(', ')}` };
  // Same rule as every other way a confer starts — nothing lands beside a busy cartridge in one
  // of its repos, or on a participant holding OTHER queued work — with one deliberate
  // difference: a participant's bare `working` status does not hold a resume. The usual reason
  // to resume is that participants dropped and came back, and they come back working on THIS
  // confer's milestone (confer-liveness-recovery.test.ts); `working` cannot say whose work it
  // is, so refusing on it would refuse exactly the resume this exists for. A queue stamp can
  // say, so that is what counts. Resume is a person pressing a button, so it refuses with the
  // reason (409) rather than queueing behind work they may not know about.
  const ownItems = (db.prepare(
    "SELECT id FROM queue_items WHERE kind = 'confer' AND handle = ?",
  ).all(id) as { id: string }[]).map((r) => r.id);
  const heldElsewhere = session.participantIds.filter((pid) => {
    const r = db.prepare('SELECT active_queue_item_id FROM agents WHERE id = ?').get(pid) as
      { active_queue_item_id?: string } | undefined;
    return !!r?.active_queue_item_id && !ownItems.includes(r.active_queue_item_id);
  });
  const busy = [...heldElsewhere, ...busyRepoSiblings(session.participantIds, ownItems)];
  if (busy.length) return { ok: false, error: `busy in the confer's repos: ${[...new Set(busy)].join(', ')} — resume when they are free` };

  const now = new Date().toISOString();
  db.transaction(() => {
    const changed = db.prepare("UPDATE confer_sessions SET status = 'running', error = '', completed_at = NULL WHERE id = ? AND status = 'failed'").run(id);
    if (!changed.changes) throw new Error('confer changed during resume');
    db.prepare('UPDATE confer_milestones SET dispatched_at = ?, nudged = 0 WHERE id = ?').run(now, milestone.id);
  })();

  let delivered = 0;
  for (const pid of pending) {
    const url = `${baseUrl()}/api/confer/${id}/milestone/${pid}/done`;
    const text = `[NeonCore Confer · resumed] Continue ${milestone.name} (${idx + 1}/${session.milestones!.length}) on ${session.repoName}. Previous milestones and your peers' completion signals were preserved. Coordinate with your peer(s), then report YOUR result with: curl -s -X POST "${url}" -H "Content-Type: application/json" -d '{"result":"<brief summary>"}'`;
    const out = await deliverToAgent(pid, text, (agentId, body) => sendCommandToAgent(agentId, body, false));
    if (out.delivered) delivered++;
  }
  if (delivered !== pending.length) {
    db.prepare('UPDATE confer_sessions SET error = ? WHERE id = ?').run(`Resume message reached ${delivered}/${pending.length} pending participant(s); the remainder will be nudged again`, id);
  }
  const updated = emit(id);
  return { ok: true, session: updated!, delivered };
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

/**
 * What a build round owes the remote before it may call itself done.
 *
 * A round is only a unit of progress if it LANDS something. Left to itself an agent happily
 * signals "round 2 done" with everything sitting uncommitted in a working tree, and the next
 * round — a fresh prompt with no memory of the last — builds on sand; a crash or a peer's
 * checkout loses the lot. So every round ends with a commit and a push to the SAME ongoing
 * branch (its own worktree branch under isolation, otherwise whatever branch the agent is
 * already on — `HEAD`, which is correct on any machine without the server guessing a name).
 */
function commitPushLines(session: ConferSession, me: Participant, round: number, rounds: number): string {
  const wt = session.worktrees?.[me.id];
  const dir = wt?.path || me.repoPath;
  const target = wt ? wt.branch : 'HEAD';
  const label = rounds > 1 ? `round ${round}/${rounds}` : 'build';
  return [
    `COMMIT + PUSH — REQUIRED before you signal this ${rounds > 1 ? 'round' : 'milestone'} done:`,
    ...(dir ? [`  cd "${dir}"`] : []),
    `  git add -A`,
    `  git commit -m "confer ${session.id.slice(0, 8)} ${label}: <what you changed>"`,
    `  git push -u origin ${target}`,
    `Stay on the SAME ongoing fix/feature branch for every round — do not cut a new branch per round.`,
    `If the push is rejected because a peer pushed first: \`git pull --rebase\`, re-run your checks, push again. NEVER force-push over a peer's work.`,
    `A ${rounds > 1 ? 'round' : 'build'} with nothing pushed is NOT done — do not signal until the push succeeds.`,
  ].join('\n');
}

/** Build the per-agent milestone prompt, including coordination guidance + the done-signal. */
export function buildMilestonePrompt(
  session: ConferSession,
  idx: number,
  me: Participant,
  peers: Participant[],
  attachmentBlocks: AttachmentBlocks,
): string {
  const milestones = session.milestones || [];
  const total = milestones.length || CONFER_MILESTONE_COUNT;
  const ms = milestones[idx];
  // Milestone rows are the source of truth for name/round (they survive a restart); the def
  // supplies the body. Looked up by KEY, so a repeated build finds the same def every round.
  const set = milestonesFor(session.mode);
  const def = (ms && set.find((m) => m.key === ms.key)) || set[idx];
  const round = ms?.round || 1;
  const buildRounds = clampBuildRounds(session.buildRounds);
  const rounds = def?.iterates ? buildRounds : 1;
  const name = ms?.name || def.name;
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
  // The build step is the only one that must land a commit; the review/converge steps have
  // their own git story (and Finalize commits the combined result).
  const commitLines = def?.iterates ? commitPushLines(session, me, round, rounds) : '';
  return [
    `[NeonCore Confer · Milestone ${idx + 1}/${total}: ${name}]`,
    `You are collaborating with ${peers.length} other agent(s) on ONE task. Work together — do not work in isolation.`,
    ``,
    `OVERALL TASK:`,
    session.task,
    ``,
    `YOUR PEER(S):`,
    peerLines,
    ``,
    `THIS MILESTONE — ${name}:`,
    def.body({ task: session.task, round, rounds, buildRounds }),
    ...(worktreeLines ? ['', worktreeLines] : []),
    ...(commitLines ? ['', commitLines] : []),
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
  const msRow = db.prepare('SELECT id, name FROM confer_milestones WHERE session_id = ? AND idx = ?').get(sessionId, idx) as { id: string; name: string } | undefined;
  if (!msRow) return;

  const now = new Date().toISOString();
  db.prepare(`UPDATE confer_milestones SET status = 'active', dispatched_at = ?, done_ids = '[]', nudged = 0 WHERE id = ?`)
    .run(now, msRow.id);

  const attachmentBlocks = parseAttachmentBlocks(row.attachments as string | undefined);
  // The stored name, not the def's — on a repeated build this is "Build 2/5", and the log is
  // where you look to see which round a stalled confer is on.
  const milestoneName = msRow.name;
  const total = session.milestones?.length || CONFER_MILESTONE_COUNT;

  let undelivered = 0;
  for (const me of participants) {
    const peers = participants.filter((p) => p.id !== me.id);
    const prompt = buildMilestonePrompt(session, idx, me, peers, attachmentBlocks);
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
  console.log(`[confer] ${sessionId} dispatched milestone ${idx + 1}/${total} (${milestoneName}) to ${participants.length} agent(s)`);
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

    /**
     * FAIL ONLY WHEN SOMEONE IS ACTUALLY GONE.
     *
     * Elapsed time alone was the old test, and it killed the case it should have protected: a
     * participant that finished the work, went idle, and never POSTed its done signal. Now the
     * question is whether each silent participant is still there — a dead one is unrecoverable
     * and failing is honest, a live one just needs reminding.
     */
    const dead = pending.filter((pid) => !participantIsAlive(pid, now));

    if (age > FAIL_MS && dead.length > 0) {
      const names = dead.map((pid) => {
        const a = db.prepare('SELECT repo_name, status FROM agents WHERE id = ?').get(pid) as
          { repo_name?: string; status?: string } | undefined;
        return `${a?.repo_name || pid} (${a?.status || 'unknown'})`;
      });
      db.prepare(`UPDATE confer_sessions SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
        .run(
          `Milestone "${ms.name}" — ${dead.length} participant(s) unreachable and gone: ${names.join(', ')}.`,
          new Date().toISOString(), row.id as string,
        );
      emit(row.id as string);
      continue;
    }

    if (age > HARD_FAIL_MS) {
      // Everyone is alive and nothing has been signalled for hours. Stop, but say so precisely:
      // this is "the work was probably done and never reported", not "a cartridge crashed".
      db.prepare(`UPDATE confer_sessions SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
        .run(
          `Milestone "${ms.name}" ran ${Math.round(age / 60000)} min with ${pending.length} participant(s) ALIVE but never signalling done — they were nudged ${ms.nudged as number} time(s). The work may well be finished; check the cartridges before re-running.`,
          new Date().toISOString(), row.id as string,
        );
      emit(row.id as string);
      continue;
    }

    /**
     * Nudge REPEATEDLY, once per stall window.
     *
     * `nudged` was a boolean gate, so a participant got exactly one reminder in the session's
     * life and a single missed signal was terminal. It is now a COUNT, and the reminder repeats
     * every STALL_MS for as long as the participant is alive.
     */
    const dueNudges = Math.floor(age / STALL_MS);
    if (dueNudges > (ms.nudged as number)) {
      db.prepare('UPDATE confer_milestones SET nudged = ? WHERE id = ?').run(dueNudges, ms.id as string);
      const session = hydrateSession(row);
      const total = session.milestones?.length || CONFER_MILESTONE_COUNT;
      for (const pid of pending) {
        const url = `${baseUrl()}/api/confer/${row.id}/milestone/${pid}/done`;
        sendCommandToAgent(
          pid,
          `[NeonCore Confer · reminder] You are on milestone ${idx + 1}/${total} (${ms.name}) of the confer on ${session.repoName}. When you've finished it, signal done:\ncurl -s -X POST "${url}" -H "Content-Type: application/json" -d '{"result":"done"}'`,
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
