import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO, upgradeSocketsToAgentRoom } from '../ws.js';
import type { Agent, AgentType, Activity } from '../types.js';
import { startSession, endSession } from '../lib/session-manager.js';
import { injectProjectContext, buildSelectiveContext } from '../lib/context-injector.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import { resolveAgentId } from '../lib/resolve-agent.js';
import { deleteAgentCascade } from '../lib/agent-cleanup.js';
import { handleAgentInterrupted } from '../lib/recovery.js';
import { markAgentSessionInterrupted } from '../lib/agent-session-state.js';
import { renderReplayContext, type MessageRow } from '../lib/recovery-core.js';
import type { TranscriptEvent, TranscriptEngine, TranscriptRole, TurnUsage } from '../types.js';

const router = Router();

// Relay fast-path: the agent's relay caught a SIGTERM (parent quit / kill) and
// reports it is dying BEFORE the PTY is torn down. We immediately flag any of
// this agent's running workflow steps as interrupted, instead of waiting for the
// 5-minute offline sweep. Best-effort: the reconciler backstops a missed POST.
router.post('/interrupted', (req, res) => {
  const { agentId, machine, repoPath, sessionId } = req.body || {};
  const resolved = resolveAgentId({ agentId, machine, repoPath, sessionId });
  if (!resolved) return res.status(404).json({ error: 'agent not found' });
  markAgentSessionInterrupted(resolved, 'disconnect');
  const count = handleAgentInterrupted(resolved);
  res.json({ agentId: resolved, interruptedSteps: count });
});

/**
 * Dismiss / restore — "I'm done with this one for now, put it away."
 *
 * This is a VIEW preference, not a lifecycle event: it does not touch `status`, does not
 * end the session, and does not stop the agent. A dismissed cartridge is very often still
 * running. It is hidden from the grid until either the user restores it, or the session
 * does literally anything — see the `dismissed_at = NULL` in register() above.
 *
 * Keeping this out of `status` is deliberate. `status` conflating "quiet" with "hide it"
 * is exactly what made live cartridges disappear from the grid mid-session.
 */
router.post('/:id/dismiss', (req, res) => {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'agent not found' });

  db.prepare('UPDATE agents SET dismissed_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);
  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  getIO().emit('agent_updated', normalizeAgent(updated));
  res.json(normalizeAgent(updated));
});

router.post('/:id/restore', (req, res) => {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'agent not found' });

  db.prepare('UPDATE agents SET dismissed_at = NULL WHERE id = ?').run(req.params.id);
  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  getIO().emit('agent_updated', normalizeAgent(updated));
  res.json(normalizeAgent(updated));
});

/**
 * Claude Code's SessionEnd hook: the session is genuinely gone (quit, /clear,
 * logout). This is the ONLY honest death signal a hooks-only agent has — `Stop`
 * fires at the end of every assistant turn, so it can never mean "dead".
 *
 * Having it is what lets us delete the old 5-minute idle→offline timer, which
 * was a crude proxy for death and made cartridges vanish out of the grid while
 * the session was still sitting right there, open.
 */
router.post('/session-end', (req, res) => {
  const { agentId, machine, repoPath, sessionId, reason } = req.body || {};
  const resolved = resolveAgentId({ agentId, machine, repoPath, sessionId });
  if (!resolved) return res.status(404).json({ error: 'agent not found' });

  markAgentSessionInterrupted(resolved, 'session-end');
  endSession(resolved);
  db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(resolved);
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(resolved) as Record<string, unknown>;
  if (row) getIO().emit('agent_updated', normalizeAgent(row));

  console.log(`[session-end] Agent ${resolved} offline (reason: ${reason || 'unspecified'})`);
  res.json({ agentId: resolved, reason: reason ?? '' });
});

/**
 * Normalize a repo path for cross-platform matching.
 * Handles Windows backslashes vs POSIX forward slashes and drive-letter formats:
 *   c:\Users\Manny\repo  →  /c/users/manny/repo
 *   /c/Users/Manny/repo  →  /c/users/manny/repo
 */
function normalizeRepoPath(p: string): string {
  if (!p) return '';
  let n = p.replace(/\\/g, '/');
  // c:/ → /c/
  n = n.replace(/^([a-zA-Z]):\//, '/$1/');
  // Strip trailing slash
  n = n.replace(/\/+$/, '');
  return n.toLowerCase();
}

// Register or update an agent
// Deduplicates on machine + repoPath (with cross-platform path normalization)
router.post('/register', (req, res) => {
  const { name, machine, repoPath, repoName, branch, currentTask, sessionId, agentType, status: reqStatus, pendingQuestion, trustMode } = req.body;
  const resolvedType = agentType || 'claude';

  const now = new Date().toISOString();

  // Find existing agent using cross-platform path normalization.
  // On Windows, hooks (Git Bash) send POSIX paths like /c/Users/... while the
  // extension sends Windows paths like c:\Users\... — both must match the same agent.
  let existing: Record<string, unknown> | undefined;
  if (machine && repoPath) {
    const normalizedIncoming = normalizeRepoPath(repoPath);
    const candidates = db
      .prepare('SELECT * FROM agents WHERE machine = ?')
      .all(machine) as Record<string, unknown>[];

    // Exact match: same normalized path + same agentType
    existing = candidates.find(
      (a) => normalizeRepoPath(a.repo_path as string) === normalizedIncoming
        && (a.agent_type as string) === resolvedType
    );

    // No fuzzy match across agent types — each type (claude, gridlight) gets its
    // own DB record.  Hooks that omit agentType default to resolvedType='claude'
    // and will exact-match or create a new Claude agent, never hijack a Gridlight one.
  }

  // Fallback: find by sessionId (for backward compat)
  if (!existing && sessionId) {
    existing = db
      .prepare('SELECT * FROM agents WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
  }

  if (existing) {
    // When no status is explicitly provided, preserve the existing status & pendingQuestion.
    // This prevents reporter.sh (PostToolUse, background) from racing with
    // permission-proxy.sh (PreToolUse) and overwriting status='waiting'.
    // Exception: if the agent was offline, a re-registration means it's back online.
    const statusToSet = reqStatus
      || ((existing.status as string) === 'offline' ? 'idle' : (existing.status as string))
      || 'working';
    const questionToSet = reqStatus === 'waiting'
      ? (pendingQuestion || '')
      : reqStatus
        ? ''  // explicit non-waiting status clears the question
        : (existing.pending_question as string) || '';  // no status provided → preserve

    // Preserve existing agent_type when the caller didn't explicitly set one
    // (hooks default to 'claude' but shouldn't overwrite 'gridlight')
    const typeToSet = agentType ? resolvedType : (existing.agent_type as string) || resolvedType;

    // Auto-revive: any hook firing means this session is in use again, so a cartridge the
    // user put away comes straight back. Every tool call passes through register(), which
    // makes this the one choke point that reliably means "this agent is being used".
    // `dismissed_at = NULL` below is what does it.
    db.prepare(`
      UPDATE agents SET name = ?, machine = ?, repo_path = ?, repo_name = ?,
        branch = ?, current_task = ?, status = ?, pending_question = ?, last_seen = ?, session_id = ?,
        agent_type = ?, dismissed_at = NULL
      WHERE id = ?
    `).run(
      name || existing.name, machine || existing.machine,
      repoPath || existing.repo_path, repoName || existing.repo_name,
      branch || existing.branch, currentTask || existing.current_task,
      statusToSet, questionToSet,
      now, sessionId || existing.session_id,
      typeToSet,
      existing.id
    );

    // Detect session boundary: sessionId changed → end old session, start new one
    const oldSessionId = (existing.session_id as string) || '';
    if (sessionId && sessionId !== oldSessionId) {
      if (oldSessionId) {
        endSession(existing.id as string);
      }
      startSession(
        existing.id as string,
        sessionId,
        (repoName || existing.repo_name || '') as string,
        (repoPath || existing.repo_path || '') as string,
        (machine || existing.machine || '') as string,
        (branch || existing.branch || '') as string,
      );
    }

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(existing.id) as Record<string, unknown>;
    const normalized = normalizeAgent(agent);

    // Upgrade any extension sockets in the path room to the agent room (closes race condition)
    const agentMachine = (agent.machine as string) || '';
    const agentRepoPath = (agent.repo_path as string) || '';
    const agentTypeStr = (agent.agent_type as string) || 'claude';
    if (agentMachine && agentRepoPath) {
      upgradeSocketsToAgentRoom(agentMachine, agentRepoPath, existing.id as string, agentTypeStr);
    }

    getIO().emit('agent_updated', normalized);
    return res.json(normalized);
  }

  const id = uuid();
  const agentName = name || (repoName ? `${machine || 'unknown'}/${repoName}` : `Agent ${id.slice(0, 6)}`);

  const newStatus = reqStatus || 'working';
  const newQuestion = newStatus === 'waiting' ? (pendingQuestion || '') : '';

  // Per-machine opt-in: hooks installed with NEONCORE_TRUST=1 send trustMode:true,
  // so newly-discovered agents from that machine start in trust mode (auto-approve)
  // instead of the default 'manual'. Only applies on creation — once the agent exists,
  // the dashboard mode toggle is authoritative (the UPDATE path never touches it).
  const initialTrust = trustMode ? 1 : 0;
  const initialMode = initialTrust ? 'trust' : 'manual';

  db.prepare(`
    INSERT INTO agents (id, name, machine, repo_path, repo_name, branch, current_task, status, pending_question, trust_mode, agent_mode, last_seen, session_id, agent_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    agentName,
    machine || 'unknown',
    repoPath || '',
    repoName || '',
    branch || '',
    currentTask || '',
    newStatus,
    newQuestion,
    initialTrust,
    initialMode,
    now,
    sessionId || '',
    resolvedType
  );

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
  const normalized = normalizeAgent(agent);

  // Upgrade any extension sockets in the path room to the agent room (closes race condition)
  if (machine && repoPath) {
    upgradeSocketsToAgentRoom(machine, repoPath, id, resolvedType);
  }

  // Start initial session for the new agent
  if (sessionId) {
    startSession(id, sessionId, repoName || '', repoPath || '', machine || '', branch || '');
  }

  getIO().emit('agent_registered', normalized);
  res.status(201).json(normalized);
});

// List all agents
router.get('/', (_req, res) => {
  const agents = db.prepare('SELECT * FROM agents ORDER BY last_seen DESC').all() as Record<string, unknown>[];
  res.json(agents.map(normalizeAgent));
});

// Get a single agent
router.get('/:id', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(normalizeAgent(agent));
});

// Update agent status
router.patch('/:id', (req, res) => {
  const { status, currentTask, branch, lastMessage } = req.body;
  const now = new Date().toISOString();

  const updates: string[] = ['last_seen = ?'];
  const values: unknown[] = [now];

  if (status) { updates.push('status = ?'); values.push(status); }
  if (currentTask !== undefined) { updates.push('current_task = ?'); values.push(currentTask); }
  if (branch) { updates.push('branch = ?'); values.push(branch); }
  if (lastMessage !== undefined) { updates.push('last_message = ?'); values.push(lastMessage); }

  values.push(req.params.id);
  db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const normalized = normalizeAgent(agent);
  getIO().emit('agent_updated', normalized);
  res.json(normalized);
});

// Post a message (agent's response) for an agent
router.post('/message', (req, res) => {
  const { sessionId, machine, repoPath, message, agentType } = req.body;

  let agent: Record<string, unknown> | undefined;
  if (machine && repoPath) {
    const normalizedIncoming = normalizeRepoPath(repoPath);
    const candidates = db.prepare('SELECT * FROM agents WHERE machine = ?')
      .all(machine) as Record<string, unknown>[];

    if (agentType) {
      agent = candidates.find(
        (a) => normalizeRepoPath(a.repo_path as string) === normalizedIncoming
          && (a.agent_type as string) === agentType
      );
    }
    if (!agent) {
      agent = candidates.find(
        (a) => normalizeRepoPath(a.repo_path as string) === normalizedIncoming
      );
    }
  }
  if (!agent && sessionId) {
    agent = db.prepare('SELECT * FROM agents WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
  }

  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const now = new Date().toISOString();
  const fullMessage = (message || '').slice(0, 4000);
  const shortMessage = fullMessage.slice(0, 500);
  // Receiving a message from Claude is real activity — set working + last_seen.
  // The periodic timer in index.ts handles the working→idle transition after
  // the 2-minute grace period once all activity stops.
  db.prepare('UPDATE agents SET last_message = ?, last_seen = ?, status = ? WHERE id = ?')
    .run(shortMessage, now, 'working', agent.id);

  // Also log as activity so it appears in the feed
  const activityId = uuid();
  db.prepare(`
    INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp)
    VALUES (?, ?, ?, ?, ?, '{}', ?)
  `).run(activityId, agent.id as string, 'assistant_message', '', fullMessage, now);

  const activity: Activity = {
    id: activityId,
    agentId: agent.id as string,
    eventType: 'assistant_message',
    toolName: '',
    toolInput: fullMessage,
    toolResult: '{}',
    timestamp: now,
  };
  getIO().emit('activity_logged', activity);

  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as Record<string, unknown>;
  const normalized = normalizeAgent(updated);
  getIO().emit('agent_updated', normalized);
  res.json(normalized);
});

// Ingest a batch of parsed transcript events (sent by the reporter hook on
// PostToolUse/Stop/SubagentStop, and by the Gridlight extension for its own
// sessions). Idempotent: INSERT OR IGNORE on the unique (session_id, seq) index
// means retries / overlapping byte ranges never create duplicates.
router.post('/transcript', (req, res) => {
  const { sessionId, machine, repoPath, engine, events, triggeredBy } = req.body as {
    sessionId?: string;
    machine?: string;
    repoPath?: string;
    engine?: TranscriptEngine;
    triggeredBy?: string; // hook event name, e.g. 'Stop'
    events?: Array<{
      seq: number;
      role: TranscriptRole;
      content: unknown; // array of blocks or string
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }>;
  };

  // `engine` doubles as the agentType hint so a Codex transcript resolves to the
  // Codex cartridge, not a Claude one sharing the same repo.
  const agentId = resolveAgentId({ sessionId, machine, repoPath, agentType: engine });
  if (!agentId) return res.status(404).json({ error: 'Agent not found' });
  if (!Array.isArray(events) || events.length === 0) return res.json({ inserted: 0 });

  const KNOWN_ENGINES: TranscriptEngine[] = ['gridlight', 'codex', 'gemini'];
  const resolvedEngine: TranscriptEngine = KNOWN_ENGINES.includes(engine as TranscriptEngine)
    ? (engine as TranscriptEngine)
    : 'claude';
  const now = new Date().toISOString();

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, agent_id, session_id, seq, role, content, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, engine, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUsage = db.prepare(`
    INSERT INTO session_usage
      (id, session_id, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const io = getIO();
  let inserted = 0;
  let lastAssistantText = '';
  const turnUsage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: '' };

  const ingest = db.transaction(() => {
    for (const ev of events) {
      if (typeof ev.seq !== 'number' || !ev.role) continue;
      const contentStr = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content ?? []);
      const u = ev.usage || {};
      const inTok = Number(u.input_tokens) || 0;
      const outTok = Number(u.output_tokens) || 0;
      const cacheRead = Number(u.cache_read_input_tokens) || 0;
      const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
      const model = ev.model || '';
      const id = uuid();

      const info = insertMessage.run(
        id, agentId, sessionId || '', ev.seq, ev.role, contentStr, model,
        inTok, outTok, cacheRead, cacheCreate, resolvedEngine, now,
      );

      if (info.changes === 0) continue; // duplicate seq — already ingested
      inserted++;

      // Mirror token usage into session_usage so existing cost endpoints keep working.
      // This is now the authoritative token source (the stdin-usage path was unreliable).
      if (inTok > 0 || outTok > 0 || cacheRead > 0 || cacheCreate > 0) {
        insertUsage.run(uuid(), sessionId || '', agentId, inTok, outTok, cacheRead, cacheCreate, model, now);
        turnUsage.inputTokens += inTok;
        turnUsage.outputTokens += outTok;
        turnUsage.cacheReadTokens += cacheRead;
        turnUsage.cacheCreationTokens += cacheCreate;
        if (model) turnUsage.model = model;
      }

      // Track latest assistant text for the agent summary line.
      if (ev.role === 'assistant') {
        const text = extractTextFromContent(ev.content);
        if (text) lastAssistantText = text;
      }

      const event: TranscriptEvent = {
        id,
        agentId,
        sessionId: sessionId || '',
        seq: ev.seq,
        role: ev.role,
        content: contentStr,
        model,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        engine: resolvedEngine,
        ts: now,
      };
      io.emit('transcript_event', event);
    }
  });
  ingest();

  // Update the agent's summary line + activity heartbeat when we got new assistant text.
  if (lastAssistantText) {
    db.prepare('UPDATE agents SET last_message = ?, last_seen = ?, status = ? WHERE id = ?')
      .run(lastAssistantText.slice(0, 500), now, 'working', agentId);
    const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
    if (updated) io.emit('agent_updated', normalizeAgent(updated));
  }

  // A completed turn (Stop hook) gets a dedicated signal carrying turn usage —
  // this is what workflow step-gating / cost meters subscribe to.
  // Each engine signals turn-end differently: Claude/Codex fire `Stop`, Gemini
  // fires `AfterAgent`. All mean "a turn just finished" for cost/step-gating.
  if (inserted > 0 && (triggeredBy === 'Stop' || triggeredBy === 'AfterAgent')) {
    io.emit('turn_complete', { agentId, sessionId: sessionId || '', engine: resolvedEngine, usage: turnUsage });
  }

  res.status(201).json({ inserted });
});

/** Map a `messages` row to the TranscriptEvent shape clients already consume. */
function normalizeMessage(row: Record<string, unknown>): TranscriptEvent {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionId: (row.session_id as string) ?? '',
    seq: (row.seq as number) ?? 0,
    role: (row.role as TranscriptRole) ?? 'assistant',
    content: (row.content as string) ?? '[]',
    model: (row.model as string) ?? '',
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    cacheReadTokens: (row.cache_read_tokens as number) ?? 0,
    cacheCreationTokens: (row.cache_creation_tokens as number) ?? 0,
    engine: ((row.engine as string) ?? 'claude') as TranscriptEngine,
    ts: (row.ts as string) ?? '',
  };
}

// Transcript history for an agent — the mobile/web client's "load messages on
// open" path (live updates still arrive via the `transcript_event` socket event).
// Returns the most recent `limit` messages in chronological order (oldest first).
// Pass `before` (an ISO ts cursor) to page further back for infinite scroll.
router.get('/:id/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const before = (req.query.before as string) || '';

  const rows = before
    ? db.prepare(
        'SELECT * FROM messages WHERE agent_id = ? AND ts < ? ORDER BY ts DESC, seq DESC LIMIT ?'
      ).all(req.params.id, before, limit) as Record<string, unknown>[]
    : db.prepare(
        'SELECT * FROM messages WHERE agent_id = ? ORDER BY ts DESC, seq DESC LIMIT ?'
      ).all(req.params.id, limit) as Record<string, unknown>[];

  // Reverse to chronological (oldest first) for direct rendering.
  res.json(rows.reverse().map(normalizeMessage));
});

/** Pull plain text out of a transcript content value (string or block array). */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim().slice(0, 4000);
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text || '');
    return texts.join('\n').trim().slice(0, 4000);
  }
  return '';
}

// Signal that ExitPlanMode has completed (sent by PostToolUse reporter hook).
// The extension uses this to time the auto-approve keystroke after Claude generates
// its follow-up plan prompt — much more reliable than guessing from permission grant time.
router.post('/plan-executed', (req, res) => {
  const { machine, repoPath } = req.body;
  if (!machine || !repoPath) return res.json({ ok: true });

  const normalizedIncoming = normalizeRepoPath(repoPath);
  const candidates = db
    .prepare('SELECT * FROM agents WHERE machine = ?')
    .all(machine) as Record<string, unknown>[];
  const agent = candidates.find(
    (a) => normalizeRepoPath(a.repo_path as string) === normalizedIncoming
  );

  if (!agent) return res.json({ ok: true });

  const agentId = agent.id as string;
  const io = getIO();
  const agentRoom = `agent:${agentId}`;
  const agentRoomSize = io.sockets.adapter.rooms.get(agentRoom)?.size ?? 0;
  const payload = { agentId };

  if (agentRoomSize > 0) {
    console.log(`[agents] plan_executed — emitting to ${agentRoom} (${agentRoomSize} socket(s))`);
    io.to(agentRoom).emit('plan_executed', payload);
  } else {
    const pathRoom = `ext:${machine}:${repoPath}`;
    const pathRoomSize = io.sockets.adapter.rooms.get(pathRoom)?.size ?? 0;
    if (pathRoomSize > 0) {
      console.log(`[agents] plan_executed — agent room empty, emitting to ${pathRoom} (${pathRoomSize} socket(s))`);
      io.to(pathRoom).emit('plan_executed', payload);
    } else {
      console.log(`[agents] plan_executed — no extension sockets found for agent ${agentId}`);
    }
  }

  res.json({ ok: true });
});

// Focus an agent's VS Code window
router.post('/:id/focus', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  getIO().to(`agent:${req.params.id}`).emit('focus_window' as any);
  res.json({ ok: true });
});

// Get available context options for the Send Context popup
router.get('/:id/context-options', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const project = (agent.repo_name as string) || '';
  if (!project) return res.json({ sessions: [], hasProgress: false, hasGotchas: false, hasDecisions: false, hasDetails: false });

  const sessions = db.prepare(
    "SELECT id, started_at, summary, branch FROM sessions WHERE project = ? AND status = 'summarized' AND summary != '' ORDER BY started_at DESC LIMIT 10"
  ).all(project) as { id: string; started_at: string; summary: string; branch: string }[];

  const knowledgeFiles = ['progress.md', 'gotchas.md', 'decisions.md', 'details.md'];
  const hasContent: Record<string, boolean> = {};
  for (const f of knowledgeFiles) {
    const row = db.prepare(
      'SELECT content FROM project_knowledge WHERE project = ? AND filename = ?'
    ).get(project, f) as { content: string } | undefined;
    hasContent[f] = !!(row?.content?.trim());
  }

  res.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      startedAt: s.started_at,
      summary: s.summary.slice(0, 200),
      branch: s.branch,
    })),
    hasProgress: hasContent['progress.md'],
    hasGotchas: hasContent['gotchas.md'],
    hasDecisions: hasContent['decisions.md'],
    hasDetails: hasContent['details.md'],
  });
});

// Manually send selective project context to an agent
router.post('/:id/send-context', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const project = (agent.repo_name as string) || '';
  if (!project) return res.status(400).json({ error: 'No project associated with agent' });

  const { sessionIds, includeProgress, includeGotchas, includeDecisions, includeDetails } = req.body || {};

  // If no selections provided, fall back to full context
  if (!sessionIds && !includeProgress && !includeGotchas && !includeDecisions && !includeDetails) {
    injectProjectContext(req.params.id, project);
  } else {
    const context = buildSelectiveContext(project, { sessionIds, includeProgress, includeGotchas, includeDecisions, includeDetails });
    if (context) {
      sendCommandToAgent(req.params.id, context, false);
    }
  }
  res.json({ ok: true });
});

function renderAgentRecoveryPrompt(agent: Record<string, unknown>, rows: MessageRow[], sessionId: string): string {
  const activeObjective = ((agent.active_objective as string) || '').trim();
  const repoName = ((agent.repo_name as string) || '').trim();
  const repoPath = ((agent.repo_path as string) || '').trim();
  const lastMessage = ((agent.last_message as string) || '').trim();

  const header = [
    '--- recovered cartridge state ---',
    `Cartridge: ${repoName || agent.name || agent.id}`,
    repoPath ? `Repo path: ${repoPath}` : '',
    sessionId ? `Recovered session id: ${sessionId}` : '',
    activeObjective ? `Last active objective:\n${activeObjective}` : '',
    lastMessage ? `Last assistant summary:\n${lastMessage.slice(0, 1000)}` : '',
    '--- end recovered cartridge state ---',
  ].filter(Boolean).join('\n\n');

  return `${header}\n\n${renderReplayContext(rows, { verbatimTurns: 16, maxChars: 18_000 })}`;
}

// Resume an ordinary ad hoc cartridge session. Unlike workflow recovery, this
// has no workflow step/objective row, so it replays the latest captured session
// plus the last dashboard command tracked as active_objective.
router.post('/:id/recover-session', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.status === 'offline') {
    db.prepare(
      `UPDATE agents
       SET recovery_status = CASE WHEN recovery_status = '' THEN 'interrupted' ELSE recovery_status END
       WHERE id = ?`,
    ).run(req.params.id);
    return res.status(409).json({ error: 'Relaunch this cartridge before resuming its session', delivered: false });
  }

  const requestedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  const sessionId = requestedSessionId
    || (agent.recovery_session_id as string)
    || (agent.session_id as string)
    || ((db.prepare(
      'SELECT session_id FROM messages WHERE agent_id = ? ORDER BY ts DESC LIMIT 1',
    ).get(req.params.id) as { session_id?: string } | undefined)?.session_id || '');

  if (!sessionId) {
    return res.status(400).json({ error: 'No captured transcript is available for this cartridge' });
  }

  const rows = db.prepare(
    'SELECT role, content, seq FROM messages WHERE agent_id = ? AND session_id = ? ORDER BY seq ASC',
  ).all(req.params.id, sessionId) as MessageRow[];

  const prompt = renderAgentRecoveryPrompt(agent, rows, sessionId);
  const command = sendCommandToAgent(req.params.id, prompt, true, undefined, { trackObjective: false });
  if (!command) return res.status(404).json({ error: 'Agent not found' });
  if (command.delivered === false) {
    db.prepare(
      `UPDATE agents SET recovery_status = 'interrupted', recovery_session_id = ? WHERE id = ?`,
    ).run(sessionId, req.params.id);
    return res.status(409).json({
      error: 'No command channel is connected for this cartridge. Relaunch the terminal first, then retry Resume session.',
      delivered: false,
    });
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agents
     SET recovery_status = 'recovered',
         recovery_session_id = ?,
         interrupted_at = COALESCE(interrupted_at, ?)
     WHERE id = ?`,
  ).run(sessionId, now, req.params.id);

  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  const normalized = normalizeAgent(updated);
  getIO().emit('agent_updated', normalized);
  res.json({ ok: true, reason: 'dispatched transcript replay', sessionId, promptChars: prompt.length });
});

// Delete an agent (cascade related records)
router.delete('/:id', (req, res) => {
  deleteAgentCascade(req.params.id);
  res.status(204).send();
});

function normalizeAgent(row: Record<string, unknown>): Agent {
  const mode = (row.agent_mode ?? 'manual') as Agent['mode'];
  return {
    id: row.id as string,
    name: row.name as string,
    machine: row.machine as string,
    repoPath: (row.repo_path ?? row.repoPath ?? '') as string,
    repoName: (row.repo_name ?? row.repoName ?? '') as string,
    branch: (row.branch ?? '') as string,
    currentTask: (row.current_task ?? row.currentTask ?? '') as string,
    status: (row.status ?? 'idle') as Agent['status'],
    trustMode: mode === 'trust',
    plansIncluded: Boolean(row.plans_included),
    mode,
    agentType: ((row.agent_type ?? row.agentType ?? 'claude') as AgentType),
    lastSeen: (row.last_seen ?? row.lastSeen ?? '') as string,
    sessionId: (row.session_id ?? row.sessionId ?? '') as string,
    lastMessage: (row.last_message ?? row.lastMessage ?? '') as string,
    pendingQuestion: (row.pending_question ?? '') as string,
    dismissedAt: (row.dismissed_at ?? '') as string,
    recoveryStatus: ((row.recovery_status ?? '') as string) as Agent['recoveryStatus'],
    interruptedAt: (row.interrupted_at ?? '') as string,
    activeObjective: (row.active_objective ?? '') as string,
  };
}

export default router;
