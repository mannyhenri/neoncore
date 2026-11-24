/**
 * BACKGROUND WORK — what a cartridge has running after its turn ended (plan part 6,
 * docs/plans/epic-qa-any-project.md).
 *
 * An agent that starts a suite in the background and ends its turn is not idle and not waiting
 * on you: it is paused on its own work. Without this, NeonCore saw Stop + "Claude is waiting for
 * your input" and showed `waiting` (Ravinia Prep, 2026-11-23: a 10+ minute gateway suite under
 * Monitor), the reaper and recovery aged it toward dead, and the stop gate counted a refusal.
 *
 *   PostToolUse Bash  backgroundTaskId ─┐  (undocumented: start time + deadline, never alone)
 *   PostToolUse Monitor taskId+timeoutMs ┤
 *                                        ▼
 *   Stop / SubagentStop  background_tasks[] ──► sync: listed → open · unlisted → finished
 *                                        │                    (the documented source of truth)
 *            open tasks? ── yes ──► agent.status = 'background'   (busy; not reaped; gate allows)
 *                                        │
 *   tool use ──► 'working' (as always)   │  no hook fires when background work ends:
 *   deadline passed ──► overran ──► 'idle' + agent_stuck alert    the next Stop, or the deadline.
 */
import db from '../db.js';
import { getIO } from '../ws.js';
import { notifyAll } from './channels.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_background_tasks (
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    ended_at TEXT NOT NULL DEFAULT '',
    end_reason TEXT NOT NULL DEFAULT '',     -- '' open · finished · overran
    PRIMARY KEY (agent_id, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_background_open ON agent_background_tasks (agent_id, ended_at);
`);

/** A task with no stated limit (a background shell, a subagent) is presumed running this long. */
export const BACKGROUND_DEFAULT_MS = 2 * 60 * 60 * 1000;
/** Past a stated limit (Monitor timeoutMs), how long before it counts as overran. */
export const BACKGROUND_GRACE_MS = 2 * 60 * 1000;

export interface BackgroundTask {
  taskId: string;
  kind: string;
  description: string;
  startedAt: string;
  deadlineAt: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {}; } catch { return {}; } }
  return {};
};
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/**
 * The start of a background task, read off a PostToolUse. Undocumented fields, seen in our live
 * activity data: Bash `backgroundTaskId`, Monitor `taskId` + `timeoutMs`. They give the start time
 * and, for Monitor, the real deadline; the task only counts as running once a Stop lists it or —
 * until the first Stop — from this record. Returns whether anything was recorded.
 */
export function recordBackgroundStart(agentId: string, toolName: string, toolInput: unknown, toolResult: unknown, nowIso: string): boolean {
  const result = obj(toolResult);
  const input = obj(toolInput);
  let taskId = '';
  let kind = '';
  let limitMs = 0;
  if (toolName === 'Bash' && str(result.backgroundTaskId)) {
    taskId = str(result.backgroundTaskId); kind = 'shell';
  } else if (toolName === 'Monitor' && str(result.taskId)) {
    taskId = str(result.taskId); kind = 'monitor';
    const t = Number(result.timeoutMs ?? input.timeout_ms);
    if (Number.isFinite(t) && t > 0) limitMs = t;
  }
  if (!taskId) return false;
  const description = (str(input.description) || str(input.command)).slice(0, 300);
  const deadline = limitMs ? plus(nowIso, limitMs + BACKGROUND_GRACE_MS) : plus(nowIso, BACKGROUND_DEFAULT_MS);
  db.prepare(`
    INSERT INTO agent_background_tasks (agent_id, task_id, kind, description, started_at, deadline_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (agent_id, task_id) DO UPDATE SET kind = excluded.kind, description = excluded.description,
      started_at = excluded.started_at, deadline_at = excluded.deadline_at, ended_at = '', end_reason = ''
  `).run(agentId, taskId, kind, description, nowIso, deadline);
  return true;
}

/**
 * Reconcile with a Stop's `background_tasks` — the documented list of what is still in flight.
 * `tasks` undefined (an older Claude Code, or a hook that did not send it) changes nothing: no
 * field is not an empty list. Listed tasks are opened (kept as they are if already known); open
 * tasks it no longer lists finished. Returns how many are open now.
 */
export function syncBackgroundTasks(agentId: string, tasks: unknown, nowIso: string): number {
  if (!Array.isArray(tasks)) return openBackgroundTasks(agentId).length;
  const listedIds = new Set<string>();
  const upsert = db.prepare(`
    INSERT INTO agent_background_tasks (agent_id, task_id, kind, description, started_at, deadline_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (agent_id, task_id) DO UPDATE SET
      kind = CASE WHEN agent_background_tasks.kind = '' THEN excluded.kind ELSE agent_background_tasks.kind END,
      description = CASE WHEN agent_background_tasks.description = '' THEN excluded.description ELSE agent_background_tasks.description END,
      ended_at = '', end_reason = ''
  `);
  db.transaction(() => {
    for (const raw of tasks) {
      const t = obj(raw);
      const id = str(t.id) || str(t.task_id);
      if (!id) continue;
      const status = str(t.status).toLowerCase();
      // A listed task that already says it is done is not open work.
      if (['completed', 'failed', 'killed', 'stopped', 'cancelled'].includes(status)) continue;
      listedIds.add(id);
      const description = (str(t.description) || str(t.name) || str(t.command) || str(t.agent_type)).slice(0, 300);
      upsert.run(agentId, id, str(t.type), description, nowIso, plus(nowIso, BACKGROUND_DEFAULT_MS));
    }
    const open = db.prepare("SELECT task_id FROM agent_background_tasks WHERE agent_id = ? AND ended_at = ''").all(agentId) as { task_id: string }[];
    const finish = db.prepare("UPDATE agent_background_tasks SET ended_at = ?, end_reason = 'finished' WHERE agent_id = ? AND task_id = ?");
    for (const { task_id } of open) if (!listedIds.has(task_id)) finish.run(nowIso, agentId, task_id);
  })();
  return listedIds.size;
}

export function openBackgroundTasks(agentId: string): BackgroundTask[] {
  return (db.prepare(`SELECT task_id, kind, description, started_at, deadline_at FROM agent_background_tasks
                       WHERE agent_id = ? AND ended_at = '' ORDER BY started_at`).all(agentId) as Record<string, string>[])
    .map((r) => ({ taskId: r.task_id, kind: r.kind, description: r.description, startedAt: r.started_at, deadlineAt: r.deadline_at }));
}

export function hasOpenBackground(agentId: string): boolean {
  return !!db.prepare("SELECT 1 FROM agent_background_tasks WHERE agent_id = ? AND ended_at = '' LIMIT 1").get(agentId);
}

/**
 * Close every open task past its deadline (`overran`); a cartridge left with nothing open goes
 * from `background` back to `idle`, where the normal staleness, reaper and recovery rules apply
 * again; an alert names what overran. Returns the agents that had something overrun.
 */
export function sweepBackgroundDeadlines(nowMs = Date.now()): string[] {
  const nowIso = new Date(nowMs).toISOString();
  const late = db.prepare(`SELECT agent_id, task_id, description, kind FROM agent_background_tasks
                            WHERE ended_at = '' AND deadline_at < ?`).all(nowIso) as { agent_id: string; task_id: string; description: string; kind: string }[];
  if (late.length === 0) return [];
  const byAgent = new Map<string, string[]>();
  const close = db.prepare("UPDATE agent_background_tasks SET ended_at = ?, end_reason = 'overran' WHERE agent_id = ? AND task_id = ?");
  for (const t of late) {
    close.run(nowIso, t.agent_id, t.task_id);
    byAgent.set(t.agent_id, [...(byAgent.get(t.agent_id) ?? []), t.description || `${t.kind} ${t.task_id}`]);
  }
  for (const [agentId, what] of byAgent) {
    if (!hasOpenBackground(agentId)) {
      db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND status = 'background'").run(agentId);
    }
    const agent = db.prepare('SELECT repo_name, name FROM agents WHERE id = ?').get(agentId) as { repo_name?: string; name?: string } | undefined;
    const label = agent?.repo_name || agent?.name || agentId;
    const pattern = `Background task overran its time limit: ${what.join(', ')}`;
    try {
      (getIO() as unknown as { emit: (event: string, payload: unknown) => void }).emit('agent_stuck', {
        agentId, pattern, severity: 'medium',
        suggestion: 'Check the cartridge: the work it was waiting on never reported back.',
        detectedAt: nowIso,
      });
    } catch { /* no socket server (tests without one) */ }
    notifyAll({
      title: `${label} — background task overran`,
      body: pattern,
      detail: { Cartridge: label, Task: what.join(', ') },
      data: { type: 'agent_stuck', agentId },
    }).catch(() => {});
    console.log(`[background] ${agentId.slice(0, 8)}: ${pattern}`);
  }
  return [...byAgent.keys()];
}

/** No hook event for this long while `working` reads as quiet (index.ts runs the sweep every 30 s). */
export const IDLE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * working → idle after IDLE_THRESHOLD_MS with no hook event — unless the cartridge has background
 * work open, in which case it is `background`: quiet because its suite is running, not because it
 * stopped (Ravinia Prep, 23:16 — G3's suite running, the cartridge shown idle). last_seen is NOT
 * touched: it means "when did this agent last actually do something". Returns the agents changed.
 */
export function sweepQuietWorking(nowMs = Date.now()): string[] {
  const cutoff = new Date(nowMs - IDLE_THRESHOLD_MS).toISOString();
  const quiet = db.prepare("SELECT id FROM agents WHERE status = 'working' AND last_seen < ?").all(cutoff) as { id: string }[];
  const set = db.prepare('UPDATE agents SET status = ? WHERE id = ?');
  for (const { id } of quiet) set.run(hasOpenBackground(id) ? 'background' : 'idle', id);
  return quiet.map((q) => q.id);
}
