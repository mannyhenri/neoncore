import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Activity } from '../types.js';

const router = Router();

/** Normalize a repo path for cross-platform matching (Windows ↔ POSIX). */
function normalizeRepoPath(p: string): string {
  if (!p) return '';
  let n = p.replace(/\\/g, '/');
  n = n.replace(/^([a-zA-Z]):\//, '/$1/');
  n = n.replace(/\/+$/, '');
  return n.toLowerCase();
}

// Log an activity event (called by hooks)
router.post('/', (req, res) => {
  const { agentId, sessionId, machine, repoPath, eventType, toolName, toolInput, toolResult } = req.body;

  // Resolve agent by ID, machine+repoPath (with cross-platform normalization), or sessionId
  let resolvedAgentId = agentId;
  if (!resolvedAgentId && machine && repoPath) {
    const normalizedIncoming = normalizeRepoPath(repoPath);
    const candidates = db.prepare('SELECT id, repo_path FROM agents WHERE machine = ?').all(machine) as { id: string; repo_path: string }[];
    const match = candidates.find((a) => normalizeRepoPath(a.repo_path) === normalizedIncoming);
    resolvedAgentId = match?.id;
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
  const toolResultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || {});

  db.prepare(`
    INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, resolvedAgentId, eventType || 'tool_use', toolName || '', toolInputStr, toolResultStr, now);

  // Update agent's last_seen and status
  db.prepare(`UPDATE agents SET last_seen = ?, status = 'working' WHERE id = ?`).run(now, resolvedAgentId);

  const activity: Activity = {
    id,
    agentId: resolvedAgentId,
    eventType: eventType || 'tool_use',
    toolName: toolName || '',
    toolInput: toolInputStr,
    toolResult: toolResultStr,
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
    toolResult: (row.tool_result ?? row.toolResult ?? '{}') as string,
    timestamp: row.timestamp as string,
  };
}

// ── Token usage endpoints ──────────────────────────────────────────────────

// Report session token usage (called from Stop/SubagentStop hook)
router.post('/usage', (req, res) => {
  const { sessionId, machine, repoPath, inputTokens, outputTokens, model } = req.body;

  // Resolve agent
  let resolvedAgentId: string | undefined;
  if (machine && repoPath) {
    const normalizedIncoming = normalizeRepoPath(repoPath);
    const candidates = db.prepare('SELECT id, repo_path FROM agents WHERE machine = ?').all(machine) as { id: string; repo_path: string }[];
    const match = candidates.find((a) => normalizeRepoPath(a.repo_path) === normalizedIncoming);
    resolvedAgentId = match?.id;
  }
  if (!resolvedAgentId && sessionId) {
    const agent = db.prepare('SELECT id FROM agents WHERE session_id = ?').get(sessionId) as { id: string } | undefined;
    resolvedAgentId = agent?.id;
  }

  if (!resolvedAgentId) {
    return res.status(400).json({ error: 'Could not resolve agent' });
  }

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO session_usage (id, session_id, agent_id, input_tokens, output_tokens, model, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId || '', resolvedAgentId, inputTokens || 0, outputTokens || 0, model || '', now);

  res.status(201).json({ id });
});

// Get aggregate token usage for an agent (optionally since a timestamp)
router.get('/usage/:agentId', (req, res) => {
  const { agentId } = req.params;
  const since = req.query.since as string | undefined;

  const rows = since
    ? db.prepare('SELECT input_tokens, output_tokens, model, recorded_at FROM session_usage WHERE agent_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC').all(agentId, since) as { input_tokens: number; output_tokens: number; model: string; recorded_at: string }[]
    : db.prepare('SELECT input_tokens, output_tokens, model, recorded_at FROM session_usage WHERE agent_id = ? ORDER BY recorded_at DESC LIMIT 50').all(agentId) as { input_tokens: number; output_tokens: number; model: string; recorded_at: string }[];

  const totalInput = rows.reduce((sum, r) => sum + r.input_tokens, 0);
  const totalOutput = rows.reduce((sum, r) => sum + r.output_tokens, 0);
  const latestModel = rows[0]?.model || '';

  res.json({ agentId, totalInput, totalOutput, total: totalInput + totalOutput, latestModel, sessions: rows.length });
});

export default router;
