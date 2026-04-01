import { Router } from 'express';
import db from '../db.js';
import { getIO, hasActiveSocket } from '../ws.js';
import { resolvePendingPoll } from './permissions.js';
import type { Agent, AgentMode, AgentType } from '../types.js';

const router = Router();

// Set agent mode (plan / manual / trust)
router.put('/:agentId/mode', (req, res) => {
  const { agentId } = req.params;
  const { mode } = req.body as { mode: AgentMode };

  if (!mode || !['manual', 'trust', 'plan'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be manual, trust, or plan' });
  }

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const now = new Date().toISOString();
  const trustMode = mode === 'trust' ? 1 : 0;

  db.prepare('UPDATE agents SET agent_mode = ?, trust_mode = ?, last_seen = ? WHERE id = ?')
    .run(mode, trustMode, now, agentId);

  // If switching to trust, auto-approve all pending permissions and resolve long-polls
  if (mode === 'trust') {
    autoApprovePending(agentId, now);
  }

  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown>;
  const normalized = normalizeAgent(updated);
  getIO().emit('agent_updated', normalized);
  res.json(normalized);
});

// Toggle trust mode for an agent (backward compat for hooks)
router.put('/:agentId', (req, res) => {
  const { agentId } = req.params;
  const { trustMode } = req.body;

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const newTrustMode = trustMode !== undefined ? (trustMode ? 1 : 0) : (agent.trust_mode ? 0 : 1);
  const newMode = newTrustMode ? 'trust' : 'manual';
  const now = new Date().toISOString();

  db.prepare('UPDATE agents SET trust_mode = ?, agent_mode = ?, last_seen = ? WHERE id = ?')
    .run(newTrustMode, newMode, now, agentId);

  // If turning on trust mode, auto-approve all pending permissions and resolve long-polls
  if (newTrustMode) {
    autoApprovePending(agentId, now);
  }

  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown>;
  const normalized = normalizeAgent(updated);
  getIO().emit('agent_updated', normalized);
  res.json(normalized);
});

// Get trust mode for an agent
router.get('/:agentId', (req, res) => {
  const agent = db.prepare('SELECT id, trust_mode, agent_mode FROM agents WHERE id = ?')
    .get(req.params.agentId) as { id: string; trust_mode: number; agent_mode: string } | undefined;
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ agentId: agent.id, trustMode: Boolean(agent.trust_mode), mode: agent.agent_mode });
});

/** Auto-approve all pending permissions for an agent and resolve any active long-polls. */
function autoApprovePending(agentId: string, now: string) {
  const pending = db
    .prepare('SELECT id FROM permissions WHERE agent_id = ? AND status = ?')
    .all(agentId, 'pending') as { id: string }[];

  for (const perm of pending) {
    db.prepare('UPDATE permissions SET status = ?, decided_at = ? WHERE id = ?')
      .run('allowed', now, perm.id);
    // Resolve the hook's HTTP long-poll immediately (instead of 120s timeout)
    resolvePendingPoll(perm.id, 'allowed');
    // Notify dashboard to clear permission card (only `id` is used for filtering)
    getIO().emit('permission_decided', { id: perm.id, agentId, status: 'allowed' } as any);
  }
}

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
    connected: hasActiveSocket(row.id as string),
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
