import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO, upgradeSocketsToAgentRoom } from '../ws.js';
import type { Agent, AgentType, Activity } from '../types.js';
import { startSession, endSession } from '../lib/session-manager.js';
import { injectProjectContext, buildSelectiveContext } from '../lib/context-injector.js';
import { sendCommandToAgent } from '../lib/send-command.js';

const router = Router();

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
  const { name, machine, repoPath, repoName, branch, currentTask, sessionId, agentType, status: reqStatus, pendingQuestion } = req.body;
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

    db.prepare(`
      UPDATE agents SET name = ?, machine = ?, repo_path = ?, repo_name = ?,
        branch = ?, current_task = ?, status = ?, pending_question = ?, last_seen = ?, session_id = ?,
        agent_type = ?
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

  db.prepare(`
    INSERT INTO agents (id, name, machine, repo_path, repo_name, branch, current_task, status, pending_question, trust_mode, last_seen, session_id, agent_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
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

// Delete an agent (cascade related records)
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM activity WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM permissions WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM commands WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
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
    mode,
    agentType: ((row.agent_type ?? row.agentType ?? 'claude') as AgentType),
    lastSeen: (row.last_seen ?? row.lastSeen ?? '') as string,
    sessionId: (row.session_id ?? row.sessionId ?? '') as string,
    lastMessage: (row.last_message ?? row.lastMessage ?? '') as string,
    pendingQuestion: (row.pending_question ?? '') as string,
  };
}

export default router;
