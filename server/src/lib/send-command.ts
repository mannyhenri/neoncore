import { execSync } from 'child_process';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { getIO, getPrimarySocket } from '../ws.js';
import type { Activity, Agent, Command, CommandAttachmentInput } from '../types.js';
import { MEMORY_MAX_ITEMS, MEMORY_ITEM_MAX_CHARS, MEMORY_MAX_TOTAL_CHARS } from './context-budget.js';

/**
 * Shared command dispatch — used by the commands route.
 * Handles memory injection, activity logging, and socket emission.
 */
// Agents launched as a bare CLI in a terminal with NO relay socket — the only way to
// reach them is typing into the frontmost terminal. Codex is deliberately NOT here: it
// runs inside the relay PTY (same as Claude), so it takes the reliable, addressed socket
// path below and only falls back to terminal-typing when no relay socket is connected.
const CLI_AGENT_TYPES = new Set(['gemini', 'amazonq']);
const ATTACHMENT_MAX_FILES = 10;
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

function safeFilename(name: string, fallback: string): string {
  const base = path.basename(name || fallback)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : fallback;
}

function ensureGitignore(repoPath: string): void {
  const gitignorePath = path.join(repoPath, '.gitignore');
  const entry = '.neoncore/attachments/';
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (existing.split(/\r?\n/).includes(entry)) return;
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } catch (err) {
    console.warn(`[attachments] Could not update ${gitignorePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function materializeAttachments(
  repoPath: string,
  attachments: CommandAttachmentInput[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return '';
  if (!repoPath) throw new Error('Cannot attach files: agent has no repo path');
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`Cannot attach files: repo path does not exist (${repoPath})`);
  }

  const selected = attachments.slice(0, ATTACHMENT_MAX_FILES);
  const totalBytes = selected.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  if (totalBytes > ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachments are too large (${Math.ceil(totalBytes / 1024 / 1024)} MB, max 20 MB)`);
  }

  ensureGitignore(repoPath);
  const today = new Date().toISOString().slice(0, 10);
  const batchId = uuid().slice(0, 8);
  const relativeDir = path.join('.neoncore', 'attachments', today, batchId);
  const absoluteDir = path.join(repoPath, relativeDir);
  fs.mkdirSync(absoluteDir, { recursive: true });

  const entries: { originalName: string; path: string; mimeType: string; size: number }[] = [];
  const usedNames = new Set<string>();
  selected.forEach((file, index) => {
    if (!file?.dataBase64) return;
    const initialFilename = safeFilename(file.name, `attachment-${index + 1}`);
    const parsed = path.parse(initialFilename);
    let filename = initialFilename;
    let suffix = 2;
    while (usedNames.has(filename)) {
      filename = `${parsed.name}-${suffix}${parsed.ext}`;
      suffix += 1;
    }
    usedNames.add(filename);
    const buffer = Buffer.from(file.dataBase64, 'base64');
    if (buffer.length === 0) return;
    if (file.size && Math.abs(buffer.length - file.size) > 2) {
      throw new Error(`Attachment "${file.name}" size did not match uploaded data`);
    }
    const relativePath = path.join(relativeDir, filename);
    fs.writeFileSync(path.join(repoPath, relativePath), buffer, { flag: 'wx' });
    entries.push({
      originalName: file.name || filename,
      path: relativePath.replace(/\\/g, '/'),
      mimeType: file.mimeType || 'application/octet-stream',
      size: buffer.length,
    });
  });

  fs.writeFileSync(
    path.join(absoluteDir, 'metadata.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), attachments: entries }, null, 2) + '\n',
    { flag: 'wx' },
  );

  if (entries.length === 0) return '';
  const lines = entries.map((entry) => `- ${entry.originalName} (${entry.mimeType}, ${entry.size} bytes): ${entry.path}`);
  return [
    '',
    '',
    'Attached customer evidence has been copied into this repo:',
    ...lines,
    '',
    'Inspect these local files directly when they are relevant. Do not commit customer attachments.',
  ].join('\n');
}

/**
 * Type a command directly into the frontmost terminal via AppleScript (macOS only).
 * Tries iTerm2 first, then Terminal.app. Returns true if delivery succeeded.
 *
 * Used for CLI agents that have no WebSocket relay (gemini/codex/amazonq), and as a
 * fallback for `claude` agents running in a bare terminal with no VS Code extension
 * connected to receive the command_send socket event.
 */
function typeIntoTerminal(text: string): boolean {
  if (process.platform !== 'darwin') return false;

  // Escape for AppleScript string: backslash and double-quote
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

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
    return true;
  } catch (err) {
    // Do NOT swallow this. A silently-failed dispatch is how commands vanish into the void
    // while the workflow still reports the step as "running".
    console.warn(`[send-command] iTerm2 delivery failed, trying Terminal.app: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Try Terminal.app
  try {
    execSync(
      `osascript` +
      ` -e 'tell application "Terminal"'` +
      ` -e 'do script "${escaped}" in front window'` +
      ` -e 'end tell'`,
      { timeout: 5000 }
    );
    return true;
  } catch (err) {
    console.error(`[send-command] Terminal.app delivery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return false;
}

export function sendCommandToAgent(
  agentId: string,
  text: string,
  includeMemory = false,
  attachments?: CommandAttachmentInput[],
): Command | null {
  const agentCheck = db.prepare('SELECT id, repo_name, repo_path, status, agent_type, session_id FROM agents WHERE id = ?')
    .get(agentId) as { id: string; repo_name: string; repo_path: string; status: string; agent_type: string; session_id: string } | undefined;
  if (!agentCheck) return null;

  // Driving an agent un-dismisses it. Sending it a prompt (from the dashboard, the phone, or
  // a workflow step) is an unambiguous "I'm working on this again" — it must not stay hidden
  // while you're actively talking to it. The register() hook path covers activity the agent
  // originates; this covers activity YOU originate, which lands before any hook fires.
  const revived = db
    .prepare('UPDATE agents SET dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL')
    .run(agentId).changes > 0;

  // Clear 'waiting' status when user responds from dashboard
  const cleared = agentCheck.status === 'waiting';
  if (cleared) {
    const now2 = new Date().toISOString();
    db.prepare(`UPDATE agents SET status = 'working', pending_question = '', last_seen = ? WHERE id = ?`).run(now2, agentId);
  }

  // Broadcast if we changed anything the grid renders. Reviving MUST emit too — otherwise the
  // agent un-hides in the DB but the grid keeps hiding it until the next refresh.
  if (cleared || revived) {
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
      pendingQuestion: (updated.pending_question ?? '') as string,
      dismissedAt: (updated.dismissed_at ?? '') as string,
    };
    getIO().emit('agent_updated', normalized);
  }

  // Auto-inject relevant memories into command context (if enabled)
  let finalText = text;
  const attachmentBlock = materializeAttachments(agentCheck.repo_path, attachments);
  if (attachmentBlock) finalText += attachmentBlock;

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
    if (typeIntoTerminal(finalText)) {
      console.log(`[cmd] Typed command into terminal for ${agentCheck.agent_type}: ${finalText.slice(0, 80)}`);
      command.delivered = true;
    } else {
      console.error(`[cmd] NO COMMAND CHANNEL for ${agentCheck.agent_type} agent ${agentId} — command was not delivered`);
      command.delivered = false;
    }
    return command;
  }

  // Emit to the primary socket (most recently registered window) to avoid sending to
  // multiple VS Code windows that may share the same agent room.
  const agentRoom = `agent:${agentId}`;
  const primarySocketId = getPrimarySocket(agentId);
  const primarySocket = primarySocketId ? getIO().sockets.sockets.get(primarySocketId) : undefined;

  if (primarySocket) {
    console.log(`[cmd] Emitting command_send to primary socket ${primarySocketId} for agent ${agentId}`);
    primarySocket.emit('command_send', command);
    command.delivered = true;
  } else {
    const agentRoomSize = getIO().sockets.adapter.rooms.get(agentRoom)?.size ?? 0;
    if (agentRoomSize > 0) {
      console.log(`[cmd] No primary socket — falling back to room ${agentRoom} (${agentRoomSize} socket(s))`);
      getIO().to(agentRoom).emit('command_send', command);
      command.delivered = true;
    } else if ((agentCheck.agent_type === 'claude' || agentCheck.agent_type === 'codex') && typeIntoTerminal(finalText)) {
      // No relay/extension socket for this claude/codex agent — it's in a bare terminal with
      // no relay attached. Fall back to typing into the FRONTMOST terminal. NB: this is
      // unaddressed — it cannot target a specific window, so it lands wherever focus happens
      // to be. The socket path above is preferred whenever a relay is connected.
      console.log(`[cmd] Agent room ${agentRoom} empty — typed command into terminal for ${agentCheck.agent_type}: ${finalText.slice(0, 80)}`);
      command.delivered = true;
    } else {
      // Nothing is listening. The command row stays 'pending' and will drain if a socket
      // reconnects — but nothing guarantees that, and callers must be able to tell the
      // difference between "delivered" and "queued into the void".
      console.error(`[cmd] NO COMMAND CHANNEL for agent ${agentId} (${agentCheck.repo_name}) — command queued as pending, nothing is listening. Start a relay for this cartridge.`);
      command.delivered = false;
    }
  }

  return command;
}
