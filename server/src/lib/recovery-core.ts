import type { Database } from 'better-sqlite3';

/**
 * Crash-recovery core — pure, dependency-injected logic.
 * ======================================================
 * Everything here takes its `database`, clock (`now`), socket-liveness probe
 * (`isAlive`), and command dispatcher (`dispatch`) as parameters so it can be
 * unit-tested against an in-memory SQLite db with no server singletons. The
 * production wiring (real db + sockets + sendCommandToAgent) lives in
 * `recovery.ts`. See `.neoncore/docs/recovery-subsystem-plan.md`.
 *
 * Recovery model (transcript replay, NOT native --resume):
 *
 *   detection ─► step.recovery_status: '' → 'interrupted'   (status stays 'running')
 *        │        (agent offline + past grace, OR relay reported interrupt)
 *        ▼
 *   recoverStep ─► CAS 'interrupted' → 'recovering' → dispatch replay ─► 'recovered'
 *        │          (rebuilds context from the messages transcript)
 *        └─► attempts > max ─► 'recovery_failed'  (surfaced, never silent)
 *
 * We flag recovery on `recovery_status` and deliberately leave `status='running'`
 * untouched, so the executor's state machine never sees a new status value.
 */

export const DEFAULT_GRACE_MS = 90_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * How long an executor can go silent before recovery treats it as dead.
 *
 * This is deliberately decoupled from the agent's user-facing `offline` flag. An agent
 * that goes quiet stays VISIBLE in the grid (it may just be idle), but a workflow step
 * whose executor has produced nothing for this long is stranded and must be reconciled.
 * Matches the 5 minutes that the old idle→offline sweep used to give us for free.
 */
export const EXECUTOR_STALE_MS = 5 * 60 * 1000;
const VERBATIM_TURNS = 10;
const MAX_CONTEXT_CHARS = 12_000;

export interface MessageRow {
  role: string;
  content: string; // JSON array of blocks (text/thinking/tool_use/tool_result)
  seq?: number;
}

// ── Transcript rendering (pure) ─────────────────────────────────────────────

function summarize(value: unknown, max: number): string {
  let s: string;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { s = String(value); }
  s = (s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function renderBlocks(content: string): string {
  let blocks: unknown;
  try { blocks = JSON.parse(content); } catch { return summarize(content, 2000); }
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(String(block.text));
        break;
      case 'tool_use':
        parts.push(`→ ${block.name ?? 'tool'}(${summarize(block.input, 200)})`);
        break;
      case 'tool_result':
        parts.push(`← result: ${summarize(block.content, 300)}`);
        break;
      // 'thinking' is intentionally omitted from the replay — it is not needed
      // to continue and only inflates the prompt.
      default:
        break;
    }
  }
  return parts.join('\n');
}

const REPLAY_HEADER =
  'You are RESUMING a task that was interrupted mid-stream — the session was ' +
  'killed (crash / power loss) before it finished. Below is the conversation so ' +
  'far, including tool results you already produced. Continue from exactly where ' +
  'you left off. Do NOT repeat work the transcript shows is already done.';

const REPLAY_FOOTER = '--- end of recovered transcript ---\nContinue the task now.';

/**
 * Build the replay prompt from a session's message rows (ordered by seq asc).
 * Keeps the last N turns verbatim and notes how many earlier turns were omitted,
 * then hard-caps total length. Pure: no db, no clock.
 */
export function renderReplayContext(
  rows: MessageRow[],
  opts: { verbatimTurns?: number; maxChars?: number } = {},
): string {
  const verbatimTurns = opts.verbatimTurns ?? VERBATIM_TURNS;
  const maxChars = opts.maxChars ?? MAX_CONTEXT_CHARS;

  if (!rows || rows.length === 0) {
    return `${REPLAY_HEADER}\n\n(No prior transcript was captured for this session — ` +
      `restart the task from its original goal.)\n\n${REPLAY_FOOTER}`;
  }

  const tail = rows.slice(-verbatimTurns);
  const omitted = rows.length - tail.length;
  const lines: string[] = [REPLAY_HEADER, ''];
  if (omitted > 0) lines.push(`[${omitted} earlier turn(s) omitted for brevity]`);
  for (const r of tail) {
    const body = renderBlocks(r.content);
    if (!body) continue;
    lines.push(`\n[${r.role}]\n${body}`);
  }

  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n[…transcript truncated…]';
  return `${out}\n\n${REPLAY_FOOTER}`;
}

// ── DB-coupled logic (injected `database`) ──────────────────────────────────

/** Latest native session id for an agent, from the messages transcript. */
export function resolveSessionId(database: Database, agentId: string): string {
  const row = database
    .prepare('SELECT session_id FROM messages WHERE agent_id = ? ORDER BY ts DESC LIMIT 1')
    .get(agentId) as { session_id?: string } | undefined;
  return row?.session_id ?? '';
}

interface RunningStepRow {
  id: string;
  executor_id: string;
  started_at: string | null;
}

/**
 * Backstop reconciler: mark `running` steps as `interrupted` when their agent is
 * offline (or gone), has no live socket, and the step has been running past the
 * grace window. Idempotent via `recovery_status = ''` guard. Returns marked ids.
 */
export function detectInterruptedSteps(
  database: Database,
  opts: { now: number; graceMs?: number; isAlive: (agentId: string) => boolean },
): string[] {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const nowIso = new Date(opts.now).toISOString();

  const rows = database.prepare(`
    SELECT id, executor_id, started_at
    FROM workflow_steps
    WHERE status = 'running' AND recovery_status = ''
      AND executor_id != '' AND executor_id != '__deferred__'
  `).all() as RunningStepRow[];

  const marked: string[] = [];
  for (const r of rows) {
    const agent = database.prepare('SELECT status, last_seen FROM agents WHERE id = ?')
      .get(r.executor_id) as { status?: string; last_seen?: string } | undefined;

    // Recovery must NOT key off `status === 'offline'` alone. The user-facing offline
    // flag is now only set by a real death signal (SessionEnd / socket drop / 24h zombie
    // reap), because agents that merely go quiet must stay visible in the grid. A crashed
    // executor fires none of those, so waiting for the flag would blind recovery for a
    // full day. Judge death here on ACTIVITY staleness instead — that's what "this step's
    // executor stopped executing" actually means.
    const lastSeenAge = agent?.last_seen ? opts.now - Date.parse(agent.last_seen) : Infinity;
    const dead =
      !agent ||
      agent.status === 'offline' ||
      (Number.isFinite(lastSeenAge) && lastSeenAge > EXECUTOR_STALE_MS);

    if (!dead) continue;                       // agent still alive/working
    if (opts.isAlive(r.executor_id)) continue; // live socket → not actually dead
    if (r.started_at) {
      const age = opts.now - Date.parse(r.started_at);
      if (Number.isFinite(age) && age < graceMs) continue; // too soon
    }
    const sessionId = resolveSessionId(database, r.executor_id);
    const upd = database.prepare(
      `UPDATE workflow_steps SET recovery_status = 'interrupted', interrupted_at = ?, native_session_id = ?
       WHERE id = ? AND recovery_status = ''`
    ).run(nowIso, sessionId, r.id);
    if (upd.changes > 0) marked.push(r.id);
  }
  return marked;
}

/**
 * Fast path: the relay told us this agent is dying (SIGTERM), so mark its
 * running steps interrupted immediately without waiting for offline detection.
 */
export function markAgentStepsInterrupted(
  database: Database,
  agentId: string,
  opts: { now: number },
): string[] {
  const nowIso = new Date(opts.now).toISOString();
  const rows = database.prepare(
    `SELECT id FROM workflow_steps WHERE executor_id = ? AND status = 'running' AND recovery_status = ''`
  ).all(agentId) as { id: string }[];
  if (rows.length === 0) return [];
  const sessionId = resolveSessionId(database, agentId);
  const marked: string[] = [];
  for (const { id } of rows) {
    const upd = database.prepare(
      `UPDATE workflow_steps SET recovery_status = 'interrupted', interrupted_at = ?, native_session_id = ?
       WHERE id = ? AND recovery_status = ''`
    ).run(nowIso, sessionId, id);
    if (upd.changes > 0) marked.push(id);
  }
  return marked;
}

export interface RecoverResult {
  ok: boolean;
  reason: string;
  recoveryStatus?: string;
  attempts?: number;
  sessionId?: string;
  promptChars?: number;
}

/**
 * Recover one interrupted step: rebuild context from its session transcript and
 * dispatch it to the step's agent. CAS on `recovery_status` makes this safe to
 * call concurrently (from the Resume button and any auto path) and idempotent
 * across restarts. Caps retries at `maxAttempts`, then marks `recovery_failed`.
 */
export function recoverStep(
  database: Database,
  stepId: string,
  opts: { now: number; dispatch: (agentId: string, text: string) => void; maxAttempts?: number },
): RecoverResult {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const step = database.prepare('SELECT * FROM workflow_steps WHERE id = ?')
    .get(stepId) as Record<string, unknown> | undefined;
  if (!step) return { ok: false, reason: 'step not found' };

  // CAS: only a step that is interrupted (or a prior failed attempt) is recoverable.
  const cas = database.prepare(
    `UPDATE workflow_steps SET recovery_status = 'recovering'
     WHERE id = ? AND recovery_status IN ('interrupted', 'recovery_failed')`
  ).run(stepId);
  if (cas.changes === 0) {
    return { ok: false, reason: `step not in a recoverable state (${(step.recovery_status as string) || 'none'})` };
  }

  const attempts = ((step.recovery_attempts as number) ?? 0) + 1;
  if (attempts > maxAttempts) {
    database.prepare(
      `UPDATE workflow_steps SET recovery_status = 'recovery_failed', recovery_attempts = ? WHERE id = ?`
    ).run(attempts, stepId);
    return { ok: false, reason: `exceeded ${maxAttempts} recovery attempts`, recoveryStatus: 'recovery_failed', attempts };
  }

  const agentId = step.executor_id as string;
  const sessionId = (step.native_session_id as string) || resolveSessionId(database, agentId);
  const rows = database.prepare('SELECT role, content, seq FROM messages WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as MessageRow[];
  const prompt = renderReplayContext(rows);

  opts.dispatch(agentId, prompt);

  const nowIso = new Date(opts.now).toISOString();
  database.prepare(
    `UPDATE workflow_steps SET status = 'running', started_at = ?, recovery_status = 'recovered',
     recovery_attempts = ?, native_session_id = ? WHERE id = ?`
  ).run(nowIso, attempts, sessionId, stepId);

  return { ok: true, reason: 'dispatched transcript replay', recoveryStatus: 'recovered', attempts, sessionId, promptChars: prompt.length };
}
