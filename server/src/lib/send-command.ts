import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Activity, Command } from '../types.js';

/**
 * Shared command dispatch — used by both the commands route and workflow executor.
 * Handles memory injection, activity logging, and socket emission.
 */
export function sendCommandToAgent(agentId: string, text: string, includeMemory = false): Command | null {
  const agentCheck = db.prepare('SELECT id, repo_name FROM agents WHERE id = ?')
    .get(agentId) as { id: string; repo_name: string } | undefined;
  if (!agentCheck) return null;

  // Auto-inject relevant memories into command context (if enabled)
  let finalText = text;
  if (includeMemory) {
    const project = agentCheck.repo_name || '';
    const memories = (project
      ? db.prepare(
          'SELECT category, content FROM agent_memory WHERE active = 1 AND (agent_id = ? OR (project = ? AND project != \'\')) ORDER BY created_at DESC LIMIT 20'
        ).all(agentId, project)
      : db.prepare(
          'SELECT category, content FROM agent_memory WHERE active = 1 AND agent_id = ? ORDER BY created_at DESC LIMIT 20'
        ).all(agentId)
    ) as { category: string; content: string }[];

    if (memories.length > 0) {
      const memoryBlock = memories.map((m) => `${m.category}: ${m.content}`).join(' | ');
      finalText = `[Memory: ${memoryBlock}]\n${text}`;
    }
  }

  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO commands (id, agent_id, text, source, status, created_at)
    VALUES (?, ?, ?, 'dashboard', 'pending', ?)
  `).run(id, agentId, finalText, now);

  const command: Command = {
    id,
    agentId,
    text: finalText,
    source: 'dashboard',
    status: 'pending',
    createdAt: now,
    deliveredAt: null,
  };

  // Log as activity — show original text (without memory prefix) in feed
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
    const agentFallback = db.prepare('SELECT machine, repo_path FROM agents WHERE id = ?')
      .get(agentId) as Record<string, unknown> | undefined;
    const machine = (agentFallback?.machine as string) ?? '';
    const repoPath = (agentFallback?.repo_path as string) ?? '';
    const pathRoom = `ext:${machine}:${repoPath}`;
    const pathRoomSize = getIO().sockets.adapter.rooms.get(pathRoom)?.size ?? 0;

    console.log(`[cmd] Agent room empty, trying path room ${pathRoom} (${pathRoomSize} socket(s))`);
    if (pathRoomSize > 0) {
      getIO().to(pathRoom).emit('command_send', command);
    } else {
      console.log(`[cmd] No sockets in any room for agent ${agentId} — command queued as pending`);
    }
  }

  return command;
}
