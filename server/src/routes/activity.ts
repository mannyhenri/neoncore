import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Activity } from '../types.js';
import { totalCostUsd, type UsageRow } from '../lib/pricing.js';
import { autoCompleteDispatchedTask } from '../lib/task-autocomplete.js';
import { resolveAgentId } from '../lib/resolve-agent.js';

const router = Router();

// Log an activity event (called by hooks)
router.post('/', (req, res) => {
  const { agentId, sessionId, machine, repoPath, eventType, toolName, toolInput, toolResult, agentType } = req.body;

  // Resolution lives in lib/resolve-agent.ts — this route used to carry its own copy,
  // which drifted: the shared helper gained an untyped-payload default while this one
  // still fell through to insertion order, so Claude hook events landed on the Codex
  // cartridge whenever Codex's row happened to be created first.
  const resolvedAgentId = resolveAgentId({ agentId, machine, repoPath, sessionId, agentType });

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

  // Stop-hook auto-complete (path B): the agent finished a turn — close out any
  // task we dispatched into its terminal that it didn't self-report (path C).
  if ((eventType || '') === 'Stop') {
    try { autoCompleteDispatchedTask(resolvedAgentId); } catch { /* non-fatal */ }
  }

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
  const { sessionId, machine, repoPath, inputTokens, outputTokens, model, agentType } = req.body;

  // Same shared resolver as the activity route. This path used to take the FIRST
  // repo match with no agentType consideration at all, so in a two-engine repo the
  // token spend of one engine was billed to the other.
  const resolvedAgentId = resolveAgentId({ machine, repoPath, sessionId, agentType });

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

  // No LIMIT — the card shows lifetime "total tokens consumed", so sum every row
  // (optionally bounded by `since`). Cache tokens are summed for accurate cost.
  const cols = 'input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, recorded_at';
  const rows = since
    ? db.prepare(`SELECT ${cols} FROM session_usage WHERE agent_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC`).all(agentId, since) as (UsageRow & { recorded_at: string })[]
    : db.prepare(`SELECT ${cols} FROM session_usage WHERE agent_id = ? ORDER BY recorded_at DESC`).all(agentId) as (UsageRow & { recorded_at: string })[];

  const totalInput = rows.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
  const totalOutput = rows.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
  const totalCacheRead = rows.reduce((sum, r) => sum + (r.cache_read_tokens || 0), 0);
  const totalCacheCreation = rows.reduce((sum, r) => sum + (r.cache_creation_tokens || 0), 0);
  const latestModel = rows[0]?.model || '';

  res.json({
    agentId,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheCreation,
    total: totalInput + totalOutput,
    costUsd: totalCostUsd(rows),
    latestModel,
    sessions: rows.length,
  });
});

export default router;
