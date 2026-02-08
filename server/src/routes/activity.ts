import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Activity } from '../types.js';

const router = Router();

// Log an activity event (called by hooks)
router.post('/', (req, res) => {
  const { agentId, sessionId, machine, repoPath, eventType, toolName, toolInput } = req.body;

  // Resolve agent by ID, machine+repoPath, or sessionId
  let resolvedAgentId = agentId;
  if (!resolvedAgentId && machine && repoPath) {
    const agent = db.prepare('SELECT id FROM agents WHERE machine = ? AND repo_path = ?').get(machine, repoPath) as { id: string } | undefined;
    resolvedAgentId = agent?.id;
  }
  if (!resolvedAgentId && sessionId) {
    const agent = db.prepare('SELECT id FROM agents WHERE session_id = ?').get(sessionId) as { id: string } | undefined;
    resolvedAgentId = agent?.id;
  }

  if (!resolvedAgentId) {
    return res.status(400).json({ error: 'agentId, machine+repoPath, or valid sessionId required' });
  }

  const id = uuid();
  const now = new Date().toISOString();
  const toolInputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {});

  db.prepare(`
    INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, resolvedAgentId, eventType || 'tool_use', toolName || '', toolInputStr, now);

  // Update agent's last_seen and status
  db.prepare(`UPDATE agents SET last_seen = ?, status = 'working' WHERE id = ?`).run(now, resolvedAgentId);

  const activity: Activity = {
    id,
    agentId: resolvedAgentId,
    eventType: eventType || 'tool_use',
    toolName: toolName || '',
    toolInput: toolInputStr,
    timestamp: now,
  };

  getIO().emit('activity_logged', activity);
  res.status(201).json(activity);
});

// Get activity for an agent
router.get('/:agentId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const activities = db
    .prepare('SELECT * FROM activity WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?')
    .all(req.params.agentId, limit) as Record<string, unknown>[];

  res.json(activities.map(normalizeActivity));
});

// Get all recent activity
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const activities = db
    .prepare('SELECT * FROM activity ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];

  res.json(activities.map(normalizeActivity));
});

function normalizeActivity(row: Record<string, unknown>): Activity {
  return {
    id: row.id as string,
    agentId: (row.agent_id ?? row.agentId) as string,
    eventType: (row.event_type ?? row.eventType) as string,
    toolName: (row.tool_name ?? row.toolName) as string,
    toolInput: (row.tool_input ?? row.toolInput) as string,
    timestamp: row.timestamp as string,
  };
}

export default router;
