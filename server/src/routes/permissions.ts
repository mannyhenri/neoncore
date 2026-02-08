import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { PermissionRequest} from '../types.js';

const router = Router();

// Pending permission decisions waiting for long-poll responses
const pendingPolls = new Map<string, {
  resolve: (decision: 'allowed' | 'denied') => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// Request a permission decision (called by hook scripts)
router.post('/request', (req, res) => {
  const { agentId, sessionId, toolName, toolInput, description } = req.body;

  // Resolve agent
  let resolvedAgentId = agentId;
  let trustMode = false;
  if (sessionId) {
    const agent = db.prepare('SELECT id, trust_mode, agent_mode FROM agents WHERE session_id = ?').get(sessionId) as { id: string; trust_mode: number; agent_mode: string } | undefined;
    if (agent) {
      resolvedAgentId = agent.id;
      trustMode = agent.agent_mode === 'trust';
    }
  } else if (resolvedAgentId) {
    const agent = db.prepare('SELECT trust_mode, agent_mode FROM agents WHERE id = ?').get(resolvedAgentId) as { trust_mode: number; agent_mode: string } | undefined;
    trustMode = agent?.agent_mode === 'trust';
  }

  if (!resolvedAgentId) {
    return res.status(400).json({ error: 'agentId or valid sessionId required' });
  }

  // If trust mode is ON, immediately allow
  if (trustMode) {
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
  };

  getIO().emit('permission_requested', request);
  res.status(201).json({ id, status: 'pending' });
});

// Long-poll for a permission decision (called by hook scripts)
router.get('/poll/:id', (req, res) => {
  const { id } = req.params;
  const timeoutMs = Math.min(parseInt(req.query.timeout as string) || 30000, 120000);

  // Check if already decided
  const existing = db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'Permission request not found' });
  }
  if (existing.status !== 'pending') {
    return res.json({ decision: existing.status });
  }

  // Long-poll: wait for decision
  const timer = setTimeout(() => {
    pendingPolls.delete(id);
    res.json({ decision: 'timeout' });
  }, timeoutMs);

  pendingPolls.set(id, {
    resolve: (decision) => {
      clearTimeout(timer);
      pendingPolls.delete(id);
      res.json({ decision });
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
  const { id, decision } = req.body;

  if (!id || !['allowed', 'denied'].includes(decision)) {
    return res.status(400).json({ error: 'id and decision (allowed|denied) required' });
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE permissions SET status = ?, decided_at = ? WHERE id = ?`).run(decision, now, id);

  const perm = db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!perm) return res.status(404).json({ error: 'Permission not found' });

  // Update agent status back to working
  db.prepare(`UPDATE agents SET status = 'working', last_seen = ? WHERE id = ?`).run(now, perm.agent_id);

  const normalized = normalizePermission(perm);
  getIO().emit('permission_decided', normalized);

  // Resolve any pending long-poll
  const poll = pendingPolls.get(id);
  if (poll) {
    poll.resolve(decision);
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
  };
}

export default router;
