import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Activity, Command } from '../types.js';

const router = Router();

// Send a command to an agent (from dashboard)
router.post('/send', (req, res) => {
  const { agentId, text } = req.body;

  if (!agentId || !text) {
    return res.status(400).json({ error: 'agentId and text required' });
  }

  const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId) as { id: string } | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO commands (id, agent_id, text, source, status, created_at)
    VALUES (?, ?, ?, 'dashboard', 'pending', ?)
  `).run(id, agentId, text, now);

  const command: Command = {
    id,
    agentId,
    text,
    source: 'dashboard',
    status: 'pending',
    createdAt: now,
    deliveredAt: null,
  };

  // Log as activity so user commands appear in the activity feed
  const activityId = uuid();
  db.prepare(`
    INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(activityId, agentId, 'user_command', '', text, now);

  const activity: Activity = {
    id: activityId,
    agentId,
    eventType: 'user_command',
    toolName: '',
    toolInput: text,
    timestamp: now,
  };
  getIO().emit('activity_logged', activity);

  // Look up agent details so extensions can match by machine+repoPath
  const agentRow = db.prepare('SELECT machine, repo_path FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;

  // Emit to VS Code extension via WebSocket (include machine+repoPath for matching)
  const payload = {
    ...command,
    machine: (agentRow?.machine as string) ?? '',
    repoPath: (agentRow?.repo_path as string) ?? '',
  };
  const clientCount = getIO().engine.clientsCount;
  console.log(`[cmd] Emitting command_send to ${clientCount} client(s): machine=${payload.machine}, repoPath=${payload.repoPath}`);
  getIO().emit('command_send', payload);
  res.status(201).json(command);
});

// Mark command as delivered (called by VS Code extension)
router.post('/delivered/:id', (req, res) => {
  const now = new Date().toISOString();
  db.prepare('UPDATE commands SET status = ?, delivered_at = ? WHERE id = ?')
    .run('delivered', now, req.params.id);
  res.json({ status: 'delivered' });
});

// Get pending commands for an agent
router.get('/pending/:agentId', (req, res) => {
  const commands = db
    .prepare('SELECT * FROM commands WHERE agent_id = ? AND status = ? ORDER BY created_at ASC')
    .all(req.params.agentId, 'pending') as Command[];
  res.json(commands);
});

export default router;
