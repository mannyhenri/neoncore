import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { PermissionRequest} from '../types.js';

const router = Router();

// Pending permission decisions waiting for long-poll responses
const pendingPolls = new Map<string, {
  resolve: (decision: 'allowed' | 'denied', response?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Resolve a pending long-poll by ID. Called from trust.ts when auto-approving
 * permissions so the hook gets an immediate response instead of timing out.
 */
export function resolvePendingPoll(id: string, decision: 'allowed' | 'denied', response = '') {
  const poll = pendingPolls.get(id);
  if (poll) {
    poll.resolve(decision, response);
  }
}

// Request a permission decision (called by hook scripts)
router.post('/request', (req, res) => {
  const { agentId, sessionId, toolName, toolInput, description } = req.body;
  console.log(`[permissions] Permission request: tool=${toolName} sessionId=${sessionId?.slice(0, 20)} agentId=${agentId || 'none'}`);

  // Resolve agent — try sessionId first, then fall back to agentId.
  // Both lookups are needed because hooks may register under a different
  // session_id than the one stored when agentType differs (e.g. gridlight).
  let resolvedAgentId = agentId;
  let trustMode = false;
  let resolvedBySession = false;

  if (sessionId) {
    const agent = db.prepare('SELECT id, trust_mode, agent_mode FROM agents WHERE session_id = ?').get(sessionId) as { id: string; trust_mode: number; agent_mode: string } | undefined;
    if (agent) {
      resolvedAgentId = agent.id;
      trustMode = agent.agent_mode === 'trust';
      resolvedBySession = true;
    }
  }

  // Fallback: if sessionId didn't find the agent, try by agentId
  if (!resolvedBySession && resolvedAgentId) {
    const agent = db.prepare('SELECT trust_mode, agent_mode FROM agents WHERE id = ?').get(resolvedAgentId) as { trust_mode: number; agent_mode: string } | undefined;
    trustMode = agent?.agent_mode === 'trust';
  }

  if (!resolvedAgentId) {
    console.log(`[permissions] Failed to resolve agent — sessionId=${sessionId} agentId=${agentId}`);
    return res.status(400).json({ error: 'agentId or valid sessionId required' });
  }

  // If trust mode is ON, immediately allow — EXCEPT ExitPlanMode and
  // AskUserQuestion, which must go through the dashboard for human review/answers.
  if (trustMode && toolName !== 'ExitPlanMode' && toolName !== 'AskUserQuestion') {
    return res.json({ decision: 'allowed', trustMode: true });
  }

  const id = uuid();
  const now = new Date().toISOString();
  const toolInputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {});

  db.prepare(`
    INSERT INTO permissions (id, agent_id, tool_name, tool_input, description, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, resolvedAgentId, toolName || '', toolInputStr, description || '', now);

  // Update agent status to waiting
  db.prepare(`UPDATE agents SET status = 'waiting', last_seen = ? WHERE id = ?`).run(now, resolvedAgentId);

  const request: PermissionRequest = {
    id,
    agentId: resolvedAgentId,
    toolName: toolName || '',
    toolInput: toolInputStr,
    description: description || `${toolName}(${toolInputStr.slice(0, 100)})`,
    status: 'pending',
    createdAt: now,
    decidedAt: null,
    response: '',
  };

  getIO().emit('permission_requested', request);
  res.status(201).json({ id, status: 'pending' });
});

// Long-poll for a permission decision (called by hook scripts)
router.get('/poll/:id', (req, res) => {
  const { id } = req.params;
  const timeoutMs = Math.min(parseInt(req.query.timeout as string) || 30000, 180000);

  // Check if already decided
  const existing = db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'Permission request not found' });
  }
  if (existing.status !== 'pending') {
    return res.json({ decision: existing.status, response: (existing.response as string) || '' });
  }

  // Long-poll: wait for decision
  const timer = setTimeout(() => {
    pendingPolls.delete(id);
    res.json({ decision: 'timeout' });
  }, timeoutMs);

  pendingPolls.set(id, {
    resolve: (decision, response) => {
      clearTimeout(timer);
      pendingPolls.delete(id);
      res.json({ decision, response: response || '' });
    },
    timer,
  });

  // Clean up if client disconnects
  req.on('close', () => {
    clearTimeout(timer);
    pendingPolls.delete(id);
  });
});

// Decide on a permission (called from dashboard)
router.post('/decide', (req, res) => {
  const { id, decision, response: responseData } = req.body;

  if (!id || !['allowed', 'denied'].includes(decision)) {
    return res.status(400).json({ error: 'id and decision (allowed|denied) required' });
  }

  const now = new Date().toISOString();
  const responseStr = responseData ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData)) : '';
  db.prepare(`UPDATE permissions SET status = ?, decided_at = ?, response = ? WHERE id = ?`).run(decision, now, responseStr, id);

  const perm = db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!perm) return res.status(404).json({ error: 'Permission not found' });

  // Update agent status back to working
  db.prepare(`UPDATE agents SET status = 'working', last_seen = ? WHERE id = ?`).run(now, perm.agent_id);

  const normalized = normalizePermission(perm);
  getIO().emit('permission_decided', normalized);

  // Resolve any pending long-poll (pass response for hook to use)
  const poll = pendingPolls.get(id);
  if (poll) {
    console.log(`[permissions] Resolving long-poll for ${id}: decision=${decision} tool=${perm.tool_name} response_len=${responseStr.length}`);
    poll.resolve(decision, responseStr);
  } else {
    console.log(`[permissions] No pending long-poll for ${id} (hook may have timed out)`);
  }

  // Auto-approve Claude Code's built-in plan confirmation prompt via the VS Code extension
  if (decision === 'allowed' && (perm.tool_name as string) === 'ExitPlanMode') {
    const agentId = perm.agent_id as string;
    const agentRoom = `agent:${agentId}`;
    const io = getIO();
    const payload = { agentId };
    const agentRoomSize = io.sockets.adapter.rooms.get(agentRoom)?.size ?? 0;

    if (agentRoomSize > 0) {
      console.log(`[permissions] ExitPlanMode approved — emitting auto_approve_plan to ${agentRoom} (${agentRoomSize} socket(s))`);
      io.to(agentRoom).emit('auto_approve_plan', payload);
    } else {
      const agent = db.prepare('SELECT machine, repo_path FROM agents WHERE id = ?').get(agentId) as { machine?: string; repo_path?: string } | undefined;
      const machine = agent?.machine || '';
      const repoPath = agent?.repo_path || '';
      const pathRoom = `ext:${machine}:${repoPath}`;
      const pathRoomSize = io.sockets.adapter.rooms.get(pathRoom)?.size ?? 0;

      if (pathRoomSize > 0) {
        console.log(`[permissions] ExitPlanMode approved — agent room empty, emitting auto_approve_plan to ${pathRoom} (${pathRoomSize} socket(s))`);
        io.to(pathRoom).emit('auto_approve_plan', payload);
      } else {
        console.log(`[permissions] ExitPlanMode approved but no extension sockets found for agent ${agentId}`);
      }
    }
  }

  res.json(normalized);
});

// Get pending permissions
router.get('/pending', (_req, res) => {
  const perms = db
    .prepare('SELECT * FROM permissions WHERE status = ? ORDER BY created_at DESC')
    .all('pending') as Record<string, unknown>[];
  res.json(perms.map(normalizePermission));
});

// Get all permissions for an agent
router.get('/agent/:agentId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const perms = db
    .prepare('SELECT * FROM permissions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(req.params.agentId, limit) as Record<string, unknown>[];
  res.json(perms.map(normalizePermission));
});

function normalizePermission(row: Record<string, unknown>): PermissionRequest {
  return {
    id: row.id as string,
    agentId: (row.agent_id ?? row.agentId) as string,
    toolName: (row.tool_name ?? row.toolName) as string,
    toolInput: (row.tool_input ?? row.toolInput) as string,
    description: row.description as string,
    status: row.status as PermissionRequest['status'],
    createdAt: (row.created_at ?? row.createdAt) as string,
    decidedAt: (row.decided_at ?? row.decidedAt) as string | null,
    response: ((row.response as string) ?? '') as string,
  };
}

export default router;
