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
const JOURNAL_LIMIT = 30;
const STEP_RESULT_MAX_CHARS = 3000;
const JOURNAL_MESSAGE_MAX_CHARS = 1000;

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

function hasTable(database: Database, name: string): boolean {
  const row = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) as { name?: string } | undefined;
  return !!row;
}

function tableColumns(database: Database, table: string): Set<string> {
  if (!hasTable(database, table)) return new Set();
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n[…truncated…]' : s;
}

function renderWorkflowRecoveryContext(database: Database, step: Record<string, unknown>): string {
  const workflowId = (step.workflow_id as string) || '';
  if (!workflowId) return '';

  const parts: string[] = ['--- recovered workflow state ---'];

  const workflowColumns = tableColumns(database, 'workflows');
  const workflowSelect = ['name', 'description', 'initial_context', 'status']
    .filter((column) => workflowColumns.has(column));
  const wf = workflowSelect.length > 0
    ? database.prepare(`SELECT ${workflowSelect.join(', ')} FROM workflows WHERE id = ?`)
      .get(workflowId) as Record<string, string | undefined> | undefined
    : undefined;
  if (wf) {
    parts.push(`Workflow: ${wf.name || workflowId}`);
    if (wf.status) parts.push(`Workflow status: ${wf.status}`);
    if (wf.description) parts.push(`Workflow objective:\n${truncate(wf.description, STEP_RESULT_MAX_CHARS)}`);
    if (wf.initial_context) parts.push(`Initial context:\n${truncate(wf.initial_context, STEP_RESULT_MAX_CHARS)}`);
  }

  const currentPrompt = (step.dispatched_prompt as string) || '';
  if (currentPrompt) {
    parts.push(`Interrupted step: ${String(step.name || step.id)}\nOriginal dispatched prompt:\n${truncate(currentPrompt, STEP_RESULT_MAX_CHARS)}`);
  }

  const stepColumns = tableColumns(database, 'workflow_steps');
  if (stepColumns.has('result')) {
    const orderBy = [
      stepColumns.has('completed_at') ? 'completed_at ASC' : '',
      stepColumns.has('created_at') ? 'created_at ASC' : '',
      'id ASC',
    ].filter(Boolean).join(', ');
    const completed = database.prepare(`
      SELECT id, name, result
      FROM workflow_steps
      WHERE workflow_id = ? AND status = 'completed' AND result != ''
      ORDER BY ${orderBy}
    `).all(workflowId) as { id: string; name: string; result: string }[];
    if (completed.length > 0) {
      parts.push('Completed step outputs:');
      for (const row of completed) {
        parts.push(`## ${row.name}\n${truncate(row.result, STEP_RESULT_MAX_CHARS)}`);
      }
    }
  }

  if (hasTable(database, 'workflow_journal')) {
    const journal = database.prepare(`
      SELECT step_name, event_type, message, created_at
      FROM workflow_journal
      WHERE workflow_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(workflowId, JOURNAL_LIMIT) as { step_name: string; event_type: string; message: string; created_at: string }[];

    if (journal.length > 0) {
      parts.push('Recent workflow journal events:');
      for (const row of journal.reverse()) {
        const label = row.step_name ? `${row.step_name}: ` : '';
        parts.push(`- ${row.created_at} [${row.event_type}] ${label}${truncate(row.message, JOURNAL_MESSAGE_MAX_CHARS)}`);
      }
    }
  }

  parts.push('--- end recovered workflow state ---');
  return parts.join('\n\n');
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

    // BLOCKED IS NOT DEAD. An agent that stopped to ask a question emits no tool events by
    // definition, so it crosses the staleness threshold every time while behaving perfectly.
    // `offline` is a real death signal and outranks this, so an agent that died mid-question
    // is still caught. The self-heal (clearInterruptOnLife) cannot cover this case: it fires
    // on the agent's NEXT activity, and a waiting agent emits nothing until a human acts —
    // the false interrupt would stand for exactly as long as you took to answer.
    if (agent?.status === 'waiting') continue;

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
  const workflowContext = renderWorkflowRecoveryContext(database, step);
  const transcriptContext = renderReplayContext(rows);
  const prompt = workflowContext ? `${workflowContext}\n\n${transcriptContext}` : transcriptContext;

  opts.dispatch(agentId, prompt);

  const nowIso = new Date(opts.now).toISOString();
  database.prepare(
    `UPDATE workflow_steps SET status = 'running', started_at = ?, recovery_status = 'recovered',
     recovery_attempts = ?, native_session_id = ? WHERE id = ?`
  ).run(nowIso, attempts, sessionId, stepId);

  return { ok: true, reason: 'dispatched transcript replay', recoveryStatus: 'recovered', attempts, sessionId, promptChars: prompt.length };
}
