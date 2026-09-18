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
import { sendCommandToAgent } from '../lib/send-command.js';
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
 * The live long-polls, as a test seam. The "an agent is still blocked on this" guard in
 * closeQuestionsAnsweredElsewhere reads this map, and a guard that cannot be tested is a
 * guard nobody finds out has stopped working.
 */
export const __pendingPollsForTests = pendingPolls;

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
  const { agentId, sessionId, machine, repoPath, description, questionCallId } = req.body;
  const nativeQuestion = req.body.agentType === 'codex' &&
    ['request_user_input', 'request_user_input_async'].includes(req.body.toolName);
  const toolName = nativeQuestion ? 'AskUserQuestion' : req.body.toolName;
  const toolInput = nativeQuestion ? { ...req.body.toolInput,
    _codexQuestion: { tool: req.body.toolName, callId: questionCallId || '' },
  } : req.body.toolInput;
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
    const byRepo = resolveAgentId({ machine, repoPath, agentType: req.body.agentType });
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

  if (nativeQuestion && questionCallId) {
    const duplicate = db.prepare(`SELECT id, status FROM permissions WHERE agent_id = ?
      AND tool_name = 'AskUserQuestion' AND json_valid(tool_input)
      AND json_extract(tool_input, '$._codexQuestion.callId') = ?`).get(resolvedAgentId, questionCallId);
    if (duplicate) return res.json(duplicate);
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

  if (toolName === 'AskUserQuestion') {
    db.prepare('UPDATE agents SET pending_question = ? WHERE id = ?').run(toolInputStr, resolvedAgentId);
  }
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
  const previous = db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!previous) return null;
  if (previous.status !== 'pending') return normalizePermission(previous);
  let input: { questions?: unknown; _codexQuestion?: { tool: string; callId?: string } } = {};
  try { input = JSON.parse((previous.tool_input as string) || '{}') || {}; } catch { /* Ordinary approval payloads may be plain text. */ }
  if (input._codexQuestion) {
    const command = sendCommandToAgent(previous.agent_id as string,
      `The user answered your ${input._codexQuestion.tool} question(s) via NeonCore.\n` +
      `Questions: ${JSON.stringify(input.questions)}\nDecision: ${decision}\n` +
      `Answers: ${typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {})}\n` +
      'Use these answers and continue the task. Do not ask these questions again.', false,
      undefined, { deliverNow: true, trackObjective: false });
    if (!command) return null;
  }
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

  const remaining = db.prepare("SELECT tool_input FROM permissions WHERE agent_id = ? AND status = 'pending' AND tool_name = 'AskUserQuestion' ORDER BY created_at").get(perm.agent_id) as { tool_input: string } | undefined;
  if (remaining) db.prepare("UPDATE agents SET status = 'waiting', pending_question = ? WHERE id = ?").run(remaining.tool_input, perm.agent_id);
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

/**
 * Close the questions this cartridge already answered SOMEWHERE ELSE — almost always by the
 * human typing the answer straight into the terminal the agent is running in.
 *
 * THE PROBLEM THIS SOLVES. NeonCore learns about a question when a hook opens a `permissions`
 * row, and it learns about the ANSWER only when the answer comes back through NeonCore. Answer
 * it in the terminal instead and nothing ever tells the server: the row sat `pending` until the
 * 15-minute TTL sweep in index.ts marked it `expired`. For a quarter of an hour the approvals
 * inbox showed a question that was already answered, the cartridge wore a stale ❓ banner, and
 * the queue held its lane because `waiting` counts as busy (lib/queue-runner.ts).
 *
 * THE SIGNAL IS THE ONE THAT ALREADY EXISTS. `statusFromActivity` (lib/activity-status.ts)
 * classifies every incoming event as "this cartridge is executing", "this cartridge is blocked
 * on a human", or "don't know". A cartridge that is executing is not waiting for an answer — so
 * `working` is the proof, and no second list of event names is introduced to drift from the
 * first. `ask_user` and a "Claude is waiting for your input" notification both classify as
 * `waiting` and therefore never close anything, which is what keeps two concurrent Codex async
 * forms from wiping each other out.
 *
 * TWO GUARDS AGAINST CLOSING A LIVE QUESTION, because the failure mode here is worse than the
 * bug: close a question the agent is genuinely blocked on and the human's answer lands nowhere
 * while the hook keeps polling.
 *
 *   1. `before` — only rows created strictly earlier than the event that triggered this. Every
 *      hook posts its activity BEFORE it requests the permission (permission-proxy.py:243→255,
 *      codex-reporter.py:235→249), so the row the agent is blocked on right now is always newer
 *      than the event in hand and is never eligible.
 *   2. A live entry in `pendingPolls` means a hook is at this moment waiting on that exact id.
 *      That is not a question answered elsewhere; that is a question still being asked.
 *
 * `answered_elsewhere` rather than reusing `expired`: "you ran out of time" and "you answered
 * this at your keyboard" are different facts, and the one the reader needs is which.
 *
 * Returns the rows it closed.
 */
export function closeQuestionsAnsweredElsewhere(
  agentId: string,
  opts: { before: string; reason?: string },
): PermissionRequest[] {
  if (!agentId || !opts.before) return [];

  const open = db.prepare(
    `SELECT * FROM permissions
      WHERE agent_id = ? AND status = 'pending' AND created_at < ?`,
  ).all(agentId, opts.before) as Record<string, unknown>[];

  const closable = open.filter((row) => !pendingPolls.has(row.id as string));
  if (closable.length === 0) return [];

  const now = new Date().toISOString();
  const mark = db.prepare(
    `UPDATE permissions SET status = 'answered_elsewhere', decided_at = ?
      WHERE id = ? AND status = 'pending'`,
  );

  const closed: PermissionRequest[] = [];
  for (const row of closable) {
    if (mark.run(now, row.id).changes === 0) continue;
    const fresh = db.prepare('SELECT * FROM permissions WHERE id = ?').get(row.id) as Record<string, unknown>;
    const normalized = normalizePermission(fresh);
    closed.push(normalized);
    // The app is TOLD, not left to discover it on the next poll — this is the event the
    // dashboard and the mobile approvals screen both already use to drop a row.
    getIO().emit('permission_decided', normalized);
  }
  if (closed.length === 0) return [];

  // The banner mirrors the inbox, so it goes with it — unless something is still genuinely
  // open, in which case it shows THAT question rather than being blanked.
  const stillOpen = db.prepare(
    `SELECT tool_input FROM permissions
      WHERE agent_id = ? AND status = 'pending' AND tool_name = 'AskUserQuestion'
      ORDER BY created_at`,
  ).get(agentId) as { tool_input: string } | undefined;
  db.prepare('UPDATE agents SET pending_question = ? WHERE id = ?')
    .run(stillOpen?.tool_input ?? '', agentId);

  console.log(
    `[permissions] Closed ${closed.length} question(s) for ${agentId.slice(0, 8)} `
    + `— answered outside NeonCore (${opts.reason || 'agent moved on'})`,
  );
  return closed;
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
