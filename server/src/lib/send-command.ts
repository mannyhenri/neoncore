import { execSync } from 'child_process';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Activity, Agent, Command } from '../types.js';
import { MEMORY_MAX_ITEMS, MEMORY_ITEM_MAX_CHARS, MEMORY_MAX_TOTAL_CHARS } from './context-budget.js';

/**
 * Shared command dispatch — used by the commands route.
 * Handles memory injection, activity logging, and socket emission.
 */
const CLI_AGENT_TYPES = new Set(['gemini', 'amazonq', 'codex']);

export function sendCommandToAgent(agentId: string, text: string, includeMemory = false): Command | null {
  const agentCheck = db.prepare('SELECT id, repo_name, status, agent_type, session_id FROM agents WHERE id = ?')
    .get(agentId) as { id: string; repo_name: string; status: string; agent_type: string; session_id: string } | undefined;
  if (!agentCheck) return null;

  // Clear 'waiting' status when user responds from dashboard
  if (agentCheck.status === 'waiting') {
    const now2 = new Date().toISOString();
    db.prepare(`UPDATE agents SET status = 'working', pending_question = '', last_seen = ? WHERE id = ?`).run(now2, agentId);
    // Broadcast the status change
    const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown>;
    const mode = (updated.agent_mode ?? 'manual') as Agent['mode'];
    const normalized: Agent = {
      id: updated.id as string,
      name: updated.name as string,
      machine: updated.machine as string,
      repoPath: (updated.repo_path ?? '') as string,
      repoName: (updated.repo_name ?? '') as string,
      branch: (updated.branch ?? '') as string,
      currentTask: (updated.current_task ?? '') as string,
      status: (updated.status ?? 'idle') as Agent['status'],
      trustMode: mode === 'trust',
      plansIncluded: Boolean(updated.plans_included),
      mode,
      agentType: (updated.agent_type ?? 'claude') as Agent['agentType'],
      lastSeen: (updated.last_seen ?? '') as string,
      sessionId: (updated.session_id ?? '') as string,
      lastMessage: (updated.last_message ?? '') as string,
      pendingQuestion: '',
    };
    getIO().emit('agent_updated', normalized);
  }

  // Auto-inject relevant memories into command context (if enabled)
  let finalText = text;
  if (includeMemory) {
    const project = agentCheck.repo_name || '';
    const memories = (project
      ? db.prepare(
          `SELECT category, content FROM agent_memory WHERE active = 1 AND (agent_id = ? OR (project = ? AND project != '')) ORDER BY created_at DESC LIMIT ${MEMORY_MAX_ITEMS}`
        ).all(agentId, project)
      : db.prepare(
          `SELECT category, content FROM agent_memory WHERE active = 1 AND agent_id = ? ORDER BY created_at DESC LIMIT ${MEMORY_MAX_ITEMS}`
        ).all(agentId)
    ) as { category: string; content: string }[];

    if (memories.length > 0) {
      let memoryBlock = memories
        .map((m) => `${m.category}: ${m.content.slice(0, MEMORY_ITEM_MAX_CHARS)}`)
        .join(' | ');
      if (memoryBlock.length > MEMORY_MAX_TOTAL_CHARS) {
        memoryBlock = memoryBlock.slice(0, MEMORY_MAX_TOTAL_CHARS) + '...';
      }
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

  // ── CLI tools (gemini / codex / amazonq): type into the terminal via AppleScript ──
  if (CLI_AGENT_TYPES.has(agentCheck.agent_type)) {
    if (process.platform === 'darwin') {
      // Escape for AppleScript string: backslash and double-quote
      const escaped = finalText.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      let sent = false;

      // Try iTerm2 first
      try {
        execSync(
          `osascript` +
          ` -e 'tell application "iTerm2"'` +
          ` -e 'tell current session of current window'` +
          ` -e 'write text "${escaped}"'` +
          ` -e 'end tell'` +
          ` -e 'end tell'`,
          { timeout: 5000 }
        );
        sent = true;
      } catch { /* fall through */ }

      // Try Terminal.app
      if (!sent) {
        try {
          execSync(
            `osascript` +
            ` -e 'tell application "Terminal"'` +
            ` -e 'do script "${escaped}" in front window'` +
            ` -e 'end tell'`,
            { timeout: 5000 }
          );
          sent = true;
        } catch { /* ignore */ }
      }

      if (sent) {
        console.log(`[cmd] Typed command into terminal for ${agentCheck.agent_type}: ${finalText.slice(0, 80)}`);
      } else {
        console.warn(`[cmd] Could not send command to terminal — no supported terminal found`);
      }
    }
    return command;
  }

  // Emit to the agent-specific room only — no fallback to path room to prevent misdelivery
  const agentRoom = `agent:${agentId}`;
  const agentRoomSize = getIO().sockets.adapter.rooms.get(agentRoom)?.size ?? 0;

  if (agentRoomSize > 0) {
    console.log(`[cmd] Emitting command_send to agent room ${agentRoom} (${agentRoomSize} socket(s))`);
    getIO().to(agentRoom).emit('command_send', command);
  } else {
    console.log(`[cmd] Agent room ${agentRoom} empty — command queued as pending (will drain on reconnect)`);
  }

  return command;
}
