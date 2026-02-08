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
    INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp)
    VALUES (?, ?, ?, ?, ?, '{}', ?)
  `).run(activityId, agentId, 'user_command', '', text, now);

  const activity: Activity = {
    id: activityId,
    agentId,
    eventType: 'user_command',
    toolName: '',
    toolInput: text,
    toolResult: '{}',
    timestamp: now,
  };
  getIO().emit('activity_logged', activity);

  // Try agent-specific room first, fall back to path-based room
  const agentRoom = `agent:${agentId}`;
  const agentRoomSize = getIO().sockets.adapter.rooms.get(agentRoom)?.size ?? 0;

  if (agentRoomSize > 0) {
    console.log(`[cmd] Emitting command_send to agent room ${agentRoom} (${agentRoomSize} socket(s))`);
    getIO().to(agentRoom).emit('command_send', command);
  } else {
    // Fallback: resolve agent's machine+repoPath and try the path-based room
    const agentRow = db.prepare('SELECT machine, repo_path FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
    const machine = (agentRow?.machine as string) ?? '';
    const repoPath = (agentRow?.repo_path as string) ?? '';
    const pathRoom = `ext:${machine}:${repoPath}`;
    const pathRoomSize = getIO().sockets.adapter.rooms.get(pathRoom)?.size ?? 0;

    console.log(`[cmd] Agent room empty, trying path room ${pathRoom} (${pathRoomSize} socket(s))`);
    if (pathRoomSize > 0) {
      getIO().to(pathRoom).emit('command_send', command);
    } else {
      console.log(`[cmd] No sockets in any room for agent ${agentId} — command queued as pending`);
    }
  }
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
