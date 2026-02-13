import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO, upgradeSocketsToAgentRoom } from '../ws.js';
import type { Agent, AgentType, Activity } from '../types.js';

const router = Router();

// Register or update an agent
// Deduplicates on machine + repoPath + agentType so each extension per repo per machine = 1 agent
router.post('/register', (req, res) => {
  const { name, machine, repoPath, repoName, branch, currentTask, sessionId, agentType, status: reqStatus, pendingQuestion } = req.body;
  const resolvedType = agentType || 'claude';
  const resolvedStatus = reqStatus || 'working';
  const resolvedQuestion = resolvedStatus === 'waiting' ? (pendingQuestion || '') : '';

  const now = new Date().toISOString();

  // First try: find by machine + repoPath + agentType (canonical dedup key)
  let existing: Record<string, unknown> | undefined;
  if (machine && repoPath) {
    existing = db
      .prepare('SELECT * FROM agents WHERE machine = ? AND repo_path = ? AND agent_type = ?')
      .get(machine, repoPath, resolvedType) as Record<string, unknown> | undefined;
  }

  // Fallback: find by sessionId (for backward compat)
  if (!existing && sessionId) {
    existing = db
      .prepare('SELECT * FROM agents WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
  }

  if (existing) {
    db.prepare(`
      UPDATE agents SET name = ?, machine = ?, repo_path = ?, repo_name = ?,
        branch = ?, current_task = ?, status = ?, pending_question = ?, last_seen = ?, session_id = ?,
        agent_type = ?
      WHERE id = ?
    `).run(
      name || existing.name, machine || existing.machine,
      repoPath || existing.repo_path, repoName || existing.repo_name,
      branch || existing.branch, currentTask || existing.current_task,
      resolvedStatus, resolvedQuestion,
      now, sessionId || existing.session_id,
      resolvedType,
      existing.id
    );

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(existing.id) as Record<string, unknown>;
    const normalized = normalizeAgent(agent);

    // Upgrade any extension sockets in the path room to the agent room (closes race condition)
    const agentMachine = (agent.machine as string) || '';
    const agentRepoPath = (agent.repo_path as string) || '';
    if (agentMachine && agentRepoPath) {
      upgradeSocketsToAgentRoom(agentMachine, agentRepoPath, existing.id as string);
    }

    getIO().emit('agent_updated', normalized);
    return res.json(normalized);
  }

  const id = uuid();
  const agentName = name || (repoName ? `${machine || 'unknown'}/${repoName}` : `Agent ${id.slice(0, 6)}`);

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
    resolvedStatus,
    resolvedQuestion,
    now,
    sessionId || '',
    resolvedType
  );

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
  const normalized = normalizeAgent(agent);

  // Upgrade any extension sockets in the path room to the agent room (closes race condition)
  if (machine && repoPath) {
    upgradeSocketsToAgentRoom(machine, repoPath, id);
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
    // If agentType provided, find the exact agent; otherwise fall back to any match
    if (agentType) {
      agent = db.prepare('SELECT * FROM agents WHERE machine = ? AND repo_path = ? AND agent_type = ?')
        .get(machine, repoPath, agentType) as Record<string, unknown> | undefined;
    }
    if (!agent) {
      agent = db.prepare('SELECT * FROM agents WHERE machine = ? AND repo_path = ?')
        .get(machine, repoPath) as Record<string, unknown> | undefined;
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
  db.prepare('UPDATE agents SET last_message = ?, last_seen = ?, status = ? WHERE id = ?')
    .run(shortMessage, now, 'idle', agent.id);

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

// Focus an agent's VS Code window
router.post('/:id/focus', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  getIO().to(`agent:${req.params.id}`).emit('focus_window' as any);
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
