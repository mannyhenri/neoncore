import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { PermissionRequest} from '../types.js';
import { resolveAgentId } from '../lib/resolve-agent.js';
import { clearInterruptOnLife } from '../lib/recovery.js';
import { notifyAll } from '../lib/channels.js';
import { buildPermissionParts, answerPayloadFor, PERM_PREFIX } from '../lib/permission-notice.js';
import { registerAction } from '../lib/commands-registry.js';

const router = Router();

/** Read the most recent plan file from ~/.claude/plans/ */
function readLatestPlan(): string {
  try {
    const plansDir = path.join(process.env.HOME || '~', '.claude', 'plans');
    if (!fs.existsSync(plansDir)) return '';
    const files = fs.readdirSync(plansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return '';
    const content = fs.readFileSync(path.join(plansDir, files[0].f), 'utf8');
    return content.length > 12000 ? content.slice(0, 12000) + '\n\n...(truncated)' : content;
  } catch { return ''; }
}

/** When ExitPlanMode fires with plansIncluded, store plan content in any running workflow step for this agent */
function capturePlanForWorkflow(agentId: string): void {
  const plan = readLatestPlan();
  if (!plan) return;
  const runningStep = db.prepare(
    "SELECT id FROM workflow_steps WHERE executor_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1"
  ).get(agentId) as { id: string } | undefined;
  if (runningStep) {
    db.prepare('UPDATE workflow_steps SET plan_content = ? WHERE id = ?').run(plan, runningStep.id);
    console.log(`[permissions] Captured plan content (${plan.length} chars) for workflow step ${runningStep.id}`);
  }
}

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
  const { agentId, sessionId, machine, repoPath, toolName, toolInput, description } = req.body;
  console.log(`[permissions] Permission request: tool=${toolName} sessionId=${sessionId?.slice(0, 20)} agentId=${agentId || 'none'}`);

  // Resolve agent — try sessionId first, then fall back to agentId.
  // Both lookups are needed because hooks may register under a different
  // session_id than the one stored when agentType differs (e.g. gridlight).
  let resolvedAgentId = agentId;
  let trustMode = false;
  let resolvedBySession = false;

  let plansIncluded = false;

  if (sessionId) {
    const agent = db.prepare('SELECT id, trust_mode, agent_mode, plans_included FROM agents WHERE session_id = ?').get(sessionId) as { id: string; trust_mode: number; agent_mode: string; plans_included: number } | undefined;
    if (agent) {
      resolvedAgentId = agent.id;
      trustMode = agent.agent_mode === 'trust';
      plansIncluded = Boolean(agent.plans_included);
      resolvedBySession = true;
    }
  }

  // Fallback: if sessionId didn't find the agent, try by machine + repoPath
  // (cross-platform normalized). A relay-launched CLI registers under the
  // relay's own session_id, so a terminal CLI that only knows its repo — e.g.
  // gridlight — would otherwise fail to resolve. Mirrors the transcript route.
  if (!resolvedBySession && !resolvedAgentId && (machine || repoPath)) {
    const byRepo = resolveAgentId({ machine, repoPath });
    if (byRepo) resolvedAgentId = byRepo;
  }

  // Fallback: if still unresolved, try by agentId / the repo-resolved id.
  if (!resolvedBySession && resolvedAgentId) {
    const agent = db.prepare('SELECT trust_mode, agent_mode, plans_included FROM agents WHERE id = ?').get(resolvedAgentId) as { trust_mode: number; agent_mode: string; plans_included: number } | undefined;
    trustMode = agent?.agent_mode === 'trust';
    plansIncluded = Boolean(agent?.plans_included);
  }

  if (!resolvedAgentId) {
    console.log(`[permissions] Failed to resolve agent — sessionId=${sessionId} agentId=${agentId} machine=${machine} repoPath=${repoPath}`);
    return res.status(400).json({ error: 'agentId, valid sessionId, or machine+repoPath required' });
  }

  // If trust mode is ON, immediately allow — EXCEPT AskUserQuestion (always needs human answer)
  // and ExitPlanMode (needs human review UNLESS plansIncluded is also enabled).
  if (trustMode && toolName !== 'AskUserQuestion') {
    if (toolName !== 'ExitPlanMode' || plansIncluded) {
      // For ExitPlanMode with plansIncluded: capture plan content and store in any running workflow step
      if (toolName === 'ExitPlanMode' && plansIncluded && resolvedAgentId) {
        capturePlanForWorkflow(resolvedAgentId);
      }
      return res.json({ decision: 'allowed', trustMode: true });
    }
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
  // An agent that stops to ask permission is plainly running. Waiting on a human is exactly
  // the silence the staleness sweep cannot distinguish from death.
  clearInterruptOnLife(resolvedAgentId);

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

  // Fire mobile push notification — agent needs human attention
  const agentRow = db.prepare('SELECT repo_name, name, repo_path FROM agents WHERE id = ?')
    .get(resolvedAgentId) as { repo_name: string; name: string; repo_path: string } | undefined;
  const projectLabel = agentRow?.repo_name || agentRow?.name || 'Agent';

  let pushTitle: string;
  let pushBody: string;
  if (toolName === 'AskUserQuestion') {
    pushTitle = `${projectLabel} — Question`;
    pushBody = (description || 'Agent has a question for you').slice(0, 300);
  } else if (toolName === 'ExitPlanMode') {
    pushTitle = `${projectLabel} — Plan Ready`;
    pushBody = 'Agent completed planning and is waiting for your review.';
  } else {
    pushTitle = `${projectLabel} — Approval Needed`;
    pushBody = `${toolName} is waiting for your approval.`;
  }
  // Every configured channel, carrying the QUESTION and its OPTIONS — not just the fact that
  // one exists. This shipped with `actions: []` and a note deferring buttons to N3; N3 covered
  // workflow attention events, so permission requests arrived as "gridlight — Question /
  // AskUserQuestion" with no way to reply. A notification you cannot act on is a worse version
  // of the dashboard you were not at.
  //
  // Fire-and-forget: a notification failure must never block the agent's request, which is why
  // notifyAll swallows per-channel errors rather than rejecting.
  const parts = buildPermissionParts(id, toolName, toolInput, description || '');
  notifyAll({
    title: pushTitle,
    body: pushBody,
    detail: {
      Cartridge: projectLabel,
      ...parts.detail,
      ...(parts.needsDashboard ? { Answer: 'Open NeonCore — this one needs the dashboard.' } : {}),
    },
    actions: parts.actions,
    data: { type: 'permission_request', permissionId: id, agentId: resolvedAgentId },
  }).catch(() => {});

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
/**
 * Record a decision. ONE implementation, called by the route and by the channel buttons.
 *
 * Extracted when permission requests became answerable from Discord. A second copy of "record
 * the decision" is how the two paths drift into disagreeing about what an answered request looks
 * like — and this one also resolves the agent's long-poll, clears the question banner, and
 * releases the plan prompt. Half of that missing from one caller is a hook that hangs.
 *
 * Returns the normalized permission, or null when the id is unknown.
 */
export function applyDecision(
  id: string,
  decision: 'allowed' | 'denied',
  responseData?: unknown,
): PermissionRequest | null {
  const now = new Date().toISOString();
  const responseStr = responseData ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData)) : '';
  db.prepare(`UPDATE permissions SET status = ?, decided_at = ?, response = ? WHERE id = ?`).run(decision, now, responseStr, id);

  const perm = db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!perm) return null;

  // Update agent status back to working, and clear the question banner. `pending_question`
  // is set by the hook when AskUserQuestion fires; nothing used to clear it, so a cartridge
  // kept showing "❓ <already-answered question>" indefinitely and the detail screen pointed
  // at an approvals inbox that no longer had anything in it.
  db.prepare(
    `UPDATE agents SET status = 'working', pending_question = '', last_seen = ? WHERE id = ?`
  ).run(now, perm.agent_id);

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

  return normalized;
}

router.post('/decide', (req, res) => {
  const { id, decision, response: responseData } = req.body;

  if (!id || !['allowed', 'denied'].includes(decision)) {
    return res.status(400).json({ error: 'id and decision (allowed|denied) required' });
  }

  const normalized = applyDecision(id, decision, responseData);
  if (!normalized) return res.status(404).json({ error: 'Permission not found' });
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

/**
 * Answer a permission from any channel.
 *
 * Routed through the SAME code path as the dashboard's decide — not a copy of it. The payload
 * shape is the agent's contract (lib/permission-notice.ts explains why), and a second
 * implementation of "record the decision" is how the two drift into disagreeing about what an
 * answered request looks like.
 */
export function registerPermissionActions(): void {
  const settle = (id: string, decision: 'allowed' | 'denied', response?: unknown): string => {
    const perm = db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!perm) return 'That request is no longer on record.';
    if (perm.status !== 'pending') return `Already ${perm.status as string}.`;
    applyDecision(id, decision, response);
    return '';
  };

  registerAction(PERM_PREFIX.answer, async ({ payload, reply }) => {
    const [id, idxRaw] = payload.split(':');
    const perm = id ? db.prepare('SELECT tool_input, status FROM permissions WHERE id = ?').get(id) as
      { tool_input: string; status: string } | undefined : undefined;
    if (!perm) return reply('That question is no longer on record.');
    if (perm.status !== 'pending') return reply(`Already answered (${perm.status}).`);

    const answer = answerPayloadFor(perm.tool_input, Number.parseInt(idxRaw || '', 10));
    if (!answer) return reply('That option no longer exists — answer it in the dashboard.');

    const err = settle(id, 'allowed', answer);
    if (err) return reply(err);
    await reply(`Answered: ${Object.values(answer.answers)[0]}`);
  });

  registerAction(PERM_PREFIX.approve, async ({ payload, reply }) => {
    const err = settle(payload.split(':')[0], 'allowed');
    await reply(err || 'Approved.');
  });

  registerAction(PERM_PREFIX.reject, async ({ payload, reply }) => {
    const err = settle(payload.split(':')[0], 'denied');
    await reply(err || 'Rejected.');
  });
}

export default router;
