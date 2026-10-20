/**
 * The queue's kind registry — what can be queued, how it starts, and how we know it ended.
 *
 * DATA, NOT A SWITCH, deliberately. The queue's whole job is "when this finishes, start the
 * next one", so a kind that can be STARTED but not OBSERVED is not a partial feature — it is
 * a lane that stalls forever, or one that advances early and runs item N+1 on a cartridge
 * still working on item N. Both are silent overnight. Making the registry a table lets the
 * test iterate it, so a kind with a dispatcher and no detector cannot ship. (Same reason the
 * 44 routing functions are data in engine-capability.ts.)
 *
 * ── THE ADVANCE RULE: EXPLICIT SIGNAL, NEVER IDLE ──────────────────────────────────────
 * This codebase already answers "is it finished?" in two contradictory ways:
 *     epics.ts:13             idleThresholdMs: 45000       -> advance when the agent goes quiet
 *     confer-conductor.ts:29  "there is no idle inference"  -> advance only on an explicit signal
 * The queue follows the conductor, and the reason is written here because the next person
 * will find epics.ts first and reasonably assume idle is house style. Idle cannot distinguish
 * finished / stuck / crashed / blocked on a permission prompt / half-done-and-stopped. Running
 * unattended, idle-advance does not fail loudly: it stacks work on top of broken work all
 * night, and every morning the queue looks drained.
 *
 * ── WHAT "COMPLETE" HONESTLY MEANS HERE ────────────────────────────────────────────────
 * For a prompt we advance on a work-standard completion report. Be clear about its strength:
 * validateCompletionPayload (work-standard.ts:218) accepts when `scope` and `verify` are
 * merely non-placeholder strings. It does NOT run the verify command, compare scope counts, or
 * check that the pasted output is real. So the queue advances on an ASSERTION, not on a
 * VERIFICATION — an agent that writes a well-formed block without doing the work will drain a
 * lane. We are not solving truth here; we are naming it, so nobody later reads "explicit
 * signal" as "verified". The mitigation that does hold: a FAILING item halts its lane, so an
 * honest failure never propagates — only a confident lie does.
 */
import db from '../db.js';
import { libelleContexte } from './context-label.js';
import { workflowName, taskName, cartridgeNames } from './queue-item-name.js';

export const KIND_IDS = ['prompt', 'workflow', 'confer', 'task'] as const;
export type QueueKind = (typeof KIND_IDS)[number];

/**
 * THREE states, never a boolean.
 *
 * A bool forces "I cannot tell" into one of the two real answers, and "cannot tell" is exactly
 * the case that must stop the lane rather than advance it. Same reason the router has
 * INCONCLUSIVE alongside ELIGIBLE and INELIGIBLE.
 */
export type CompletionState = 'complete' | 'running' | 'needs_attention';

export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';

export interface QueueItem {
  id: string;
  kind: QueueKind;
  payload: Record<string, unknown>;
  /** Cartridge ids (prompt) or a single repo path (workflow/confer). */
  targets: string[];
  /** Serial execution unit. One cartridge runs one thing at a time. */
  lane: string;
  status: QueueStatus;
  position: number;
  /** What dispatch returned — a workflow run id, a confer session id, '' for a prompt. */
  handle: string;
  result: string;
  error: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Consecutive dispatch failures. A blip is retried; an exhausted budget halts. */
  attempts: number;
  /** Consecutive ticks a running item's target has been unreachable. */
  stallTicks: number;
  /** Parked by a human. Still queued, but skipped — the rest of the lane keeps draining. */
  paused: boolean;
  /** The persisted row could not be deserialized — quarantined, never silently skipped. */
  corrupt: boolean;
}

export interface Verdict {
  state: CompletionState;
  /** Always populated — a bare state with no reason is unactionable at 3am. */
  reason: string;
}

export interface QueueKindDef {
  kind: QueueKind;
  /** Rejected at ENQUEUE time, while a human is watching — not at 3am when it is next up. */
  validate(payload: Record<string, unknown>): string | null;
  describe(item: QueueItem): string;
  /** Start it. Returns the handle to observe, and the targets that must all report. */
  dispatch(item: QueueItem): Promise<{ handle: string; targets: string[] }>;
  isComplete(item: QueueItem): Verdict;
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * A row-status detector shared by workflow and confer: both persist a terminal status, so the
 * observation is a lookup rather than an inference.
 */
function detectByStatus(table: 'workflows' | 'confer_sessions', item: QueueItem, label: string): Verdict {
  if (!item.handle) return { state: 'running', reason: `${label} not dispatched yet` };
  const row = db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(item.handle) as { status?: string } | undefined;
  if (!row) {
    // Dispatched, then the row vanished. Never treat a missing row as success — that is an
    // advance on absence of evidence, which is how a queue drains without running anything.
    return { state: 'needs_attention', reason: `${label} ${item.handle} no longer exists` };
  }
  if (row.status === 'completed') return { state: 'complete', reason: `${label} completed` };
  if (row.status === 'failed' || row.status === 'cancelled') {
    return { state: 'needs_attention', reason: `${label} ${row.status}` };
  }
  return { state: 'running', reason: `${label} is ${row.status || 'pending'}` };
}

// ---------------------------------------------------------------------------
// prompt — the only kind whose completion is a REPORT rather than a row status
// ---------------------------------------------------------------------------

/**
 * Completions are bound to the DISPATCH, not merely to the agent.
 *
 * Without this, any completion report from cartridge X advances whatever X is currently
 * running: a late report from the previous item, a duplicate delivery, or work the user
 * started by hand in the same cartridge. That is the identical shape to the demotion bug we
 * just fixed — a signal arriving with no way to bind it to what produced it — and here the
 * consequence is worse, because it advances a queue rather than mis-scoring a function.
 *
 * PRIMARY KEY (item_id, agent_id) makes it idempotent: a report delivered twice counts once.
 */
export function recordQueueCompletion(agentId: string, ok: boolean, detail: string): void {
  const stamp = db.prepare('SELECT active_queue_item_id FROM agents WHERE id = ?')
    .get(agentId) as { active_queue_item_id?: string } | undefined;
  const itemId = stamp?.active_queue_item_id || '';
  if (!itemId) return; // not working for the queue — ignore, do not guess
  db.prepare(`
    INSERT INTO queue_completions (item_id, agent_id, ok, detail, reported_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(item_id, agent_id) DO NOTHING
  `).run(itemId, agentId, ok ? 1 : 0, detail.slice(0, 500), new Date().toISOString());
}

function detectPrompt(item: QueueItem): Verdict {
  if (item.status !== 'running') return { state: 'running', reason: 'not dispatched yet' };
  const rows = db.prepare('SELECT agent_id, ok, detail FROM queue_completions WHERE item_id = ?')
    .all(item.id) as { agent_id: string; ok: number; detail: string }[];

  // needs_review means the agent stopped WITHOUT filing a report (work-standard.ts). It is the
  // one condition a 24/7 loop must never read as success.
  const flagged = item.targets.filter((t) => {
    const a = db.prepare('SELECT standard_state FROM agents WHERE id = ?').get(t) as { standard_state?: string } | undefined;
    return a?.standard_state === 'needs_review';
  });
  if (flagged.length) {
    return { state: 'needs_attention', reason: `stopped without a completion report: ${flagged.join(', ')}` };
  }

  const failed = rows.filter((r) => !r.ok);
  if (failed.length) return { state: 'needs_attention', reason: `reported failure: ${failed[0].detail}` };

  // ALL, and specifically "every target REPORTED" rather than "none outstanding" — a target
  // that never started is not running, and counting absence as done completes an item having
  // performed a fraction of the work.
  const reported = new Set(rows.map((r) => r.agent_id));
  const missing = item.targets.filter((t) => !reported.has(t));
  if (missing.length) return { state: 'running', reason: `awaiting ${missing.length}/${item.targets.length} target(s)` };
  return { state: 'complete', reason: `all ${item.targets.length} target(s) reported` };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const QUEUE_KINDS: QueueKindDef[] = [
  {
    kind: 'prompt',
    validate: (p) => {
      if (!str(p, 'text')) return 'a prompt needs `text`';
      if (!Array.isArray(p.targets) || p.targets.length === 0) return 'a prompt needs at least one target cartridge';
      return null;
    },
    describe: (i) => `"${libelleContexte(str(i.payload, 'text'))}" -> ${cartridgeNames(i.targets)}`,
    dispatch: async (item) => {
      const { sendCommandToAgent } = await import('./send-command.js');
      const text = str(item.payload, 'text');
      // Stored by routes/commands.ts when the cartridge was busy. Items queued before this was
      // stored carry neither, and behave as they always did.
      const attachments = Array.isArray(item.payload.attachments)
        ? item.payload.attachments as import('../types.js').CommandAttachmentInput[]
        : undefined;
      const includeMemory = item.payload.includeMemory === true;
      const delivered: string[] = [];
      for (const agentId of item.targets) {
        // standard: true — a queued prompt is dispatched work, so it carries the work-standard
        // contract. That contract is also what produces the completion report we advance on.
        const cmd = sendCommandToAgent(agentId, text, includeMemory, attachments, { standard: true, trackObjective: true });
        // A command is PERSISTED even when no socket is attached, and the relay drains pending
        // commands on reconnect — so `delivered:false` means "not yet", not "never". Treating it
        // as a dispatch failure conflated liveness with handoff and turned a reconnect into a
        // permanent halt. Liveness now has its own budget in the runner (MAX_STALL_TICKS); this
        // only fails when the cartridge does not exist at all, which is genuinely permanent.
        if (cmd) delivered.push(agentId);
      }
      if (delivered.length === 0) throw new Error('no target cartridge exists');
      return { handle: '', targets: delivered };
    },
    isComplete: detectPrompt,
  },
  {
    kind: 'workflow',
    validate: (p) => (str(p, 'workflowId') ? null : 'a workflow needs `workflowId` (a template or run id)'),
    describe: (i) => workflowName(str(i.payload, 'workflowId')),
    dispatch: async (item) => {
      // DELIBERATE, AND A KNOWN WART: the v2 start logic is a ~320-line express handler
      // (routes/workflows.ts:596-917) doing template cloning, deferred assignment, attachments
      // and capability routing. There is no importable startWorkflowRun(), so the queue calls
      // its own server rather than duplicating that logic — duplicating it is how the two
      // paths drift. Extracting the handler into lib/ is the follow-up that deletes this.
      const { getServerBaseUrl } = await import('./server-url.js');
      // auth.ts rejects unauthenticated requests once strict mode is on — which is exactly what
      // you enable before leaving a machine unattended on a LAN, i.e. the scenario this feature
      // is FOR. Without this, turning on the security setting silently disables every workflow
      // item. The server knows its own token; a loopback exemption would be a hole.
      const { getFleetToken } = await import('./auth.js');
      const token = getFleetToken();
      const id = str(item.payload, 'workflowId');
      const res = await fetch(`${getServerBaseUrl()}/api/workflows/v2/${encodeURIComponent(id)}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // queueIfBusy:false is REQUIRED, not tidy. This posts to the very route that enqueued
        // the item; with the default opt-out the route would run its busy check again and
        // enqueue a second copy of the work being dispatched, and the lane would feed itself.
        body: JSON.stringify({ ...(item.payload.startOptions as object || {}), queueIfBusy: false }),
      });
      if (!res.ok) throw new Error(`workflow start failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { workflow?: { id?: string } };
      const runId = body.workflow?.id;
      if (!runId) throw new Error('workflow start returned no run id — nothing to observe');
      return { handle: runId, targets: [] };
    },
    isComplete: (item) => detectByStatus('workflows', item, 'workflow'),
  },
  {
    kind: 'confer',
    validate: (p) => {
      if (!str(p, 'task')) return 'a confer needs `task`';
      if (!Array.isArray(p.participantIds) || p.participantIds.length < 2) return 'a confer needs at least 2 participants';
      return null;
    },
    describe: (i) => `confer "${libelleContexte(str(i.payload, 'task'))}" with `
      + cartridgeNames((i.payload.participantIds as string[] | undefined) ?? []),
    dispatch: async (item) => {
      const { startConfer } = await import('./confer-conductor.js');
      const session = startConfer(item.payload as Parameters<typeof startConfer>[0]);
      if (!session?.id) throw new Error('confer did not start — nothing to observe');
      return { handle: session.id, targets: [] };
    },
    isComplete: (item) => detectByStatus('confer_sessions', item, 'confer'),
  },
  {
    // A dispatched task is a prompt with bookkeeping: the tasks row moves to in_progress and
    // the dashboard follows it. That bookkeeping is why this is its own kind rather than a
    // prompt — enqueueing it as a prompt would mark the task in_progress at ENQUEUE time,
    // so a task waiting behind three others would read as running for as long as it waited.
    kind: 'task',
    validate: (p) => {
      if (!str(p, 'taskId')) return 'a task needs `taskId`';
      if (!str(p, 'agentId')) return 'a task needs `agentId` — the cartridge it was aimed at';
      return null;
    },
    describe: (i) => taskName(str(i.payload, 'taskId')),
    dispatch: async (item) => {
      // Dynamic import: the dispatcher lives with the route that owns the tasks table, and a
      // static import from lib/ into routes/ would be a cycle. Same shape as the workflow
      // kind reaching for server-url.
      const { dispatchTaskToAgent, getTask } = await import('../routes/tasks.js');
      const taskId = str(item.payload, 'taskId');
      const agentId = str(item.payload, 'agentId');
      const task = getTask(taskId);
      // Cancelled or finished while it waited. Not an error — the queue did its job by not
      // running it, and failing the lane over it would halt everything behind it.
      if (!task) throw new Error(`task ${taskId} no longer exists`);
      if (task.status === 'done' || task.status === 'cancelled') {
        throw new Error(`task ${taskId} was already ${task.status} before its turn came`);
      }
      const updated = dispatchTaskToAgent(task, agentId);
      if (!updated) throw new Error(`task ${taskId} could not reach cartridge ${agentId}`);
      return { handle: taskId, targets: [agentId] };
    },
    isComplete: (item) => {
      if (!item.handle) return { state: 'running', reason: 'task not dispatched yet' };
      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(item.handle) as
        { status?: string } | undefined;
      if (!row) return { state: 'needs_attention', reason: `task ${item.handle} no longer exists` };
      if (row.status === 'done') return { state: 'complete', reason: 'task done' };
      if (row.status === 'cancelled') return { state: 'needs_attention', reason: 'task cancelled' };
      return { state: 'running', reason: `task is ${row.status || 'queued'}` };
    },
  },
];

export function getKind(kind: QueueKind): QueueKindDef {
  const def = QUEUE_KINDS.find((k) => k.kind === kind);
  // Throw rather than return undefined: a silently-skipped kind is an item that sits queued
  // forever with no error, which is the failure this whole registry exists to prevent.
  if (!def) throw new Error(`unknown queue kind: ${kind}`);
  return def;
}
