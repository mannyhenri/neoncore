import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO, getPrimarySocket } from '../ws.js';
import type { Activity, Agent, Command, CommandAttachmentInput, DeliveryTransport } from '../types.js';
import { MEMORY_MAX_ITEMS, MEMORY_ITEM_MAX_CHARS, MEMORY_MAX_TOTAL_CHARS } from './context-budget.js';
import { materializeAttachments } from './attachments.js';
import { postToInbox, inboxReachable } from './inbox-client.js';
import { isLocalMachine, machineLabel } from './machine-locality.js';
import { WORK_STANDARD_SHORT, isAnswerToPendingQuestion, shouldInjectForDispatch } from './work-standard.js';
import { goalBriefForAgent } from './goal-brief.js';
import { noteBudgetOnDispatch } from './goal-budget.js';

/**
 * Shared command dispatch — used by the commands route.
 * Handles memory injection, activity logging, and socket emission.
 */
// Agents launched as a bare CLI in a terminal with NO relay socket — the only way to
// reach them is typing into the frontmost terminal. Codex is deliberately NOT here: it
// runs inside the relay PTY (same as Claude), so it takes the reliable, addressed socket
// path below and only falls back to terminal-typing when no relay socket is connected.

/**
 * Type a command directly into the frontmost terminal via AppleScript (macOS only).
 * Tries iTerm2 first, then Terminal.app. Returns true if delivery succeeded.
 *
 * Used for CLI agents that have no WebSocket relay (codex), and as a
 * fallback for `claude` agents running in a bare terminal with no VS Code extension
 * connected to receive the command_send socket event.
 */
/*
 * ADX-008 — the terminal fallback is DELETED, not disabled.
 *
 * It ran AppleScript that wrote a dispatch into the FRONTMOST terminal window,
 * and its own comment admitted the flaw: it could not target a specific window,
 * so it landed wherever focus happened to be. That put mystery text in the
 * user's session for two days, and hit test suites hardest — they use a stub io
 * with no sockets, so every prompt they dispatched typed into a real terminal.
 *
 * It survived until now only because there was no ADDRESSED fallback. There is
 * one: the inbox socket below reaches the same cartridge precisely, so an
 * unaddressed one has no remaining justification.
 *
 * `no-keystroke-injection.test.ts` now asserts its ABSENCE across the whole
 * server source rather than asserting a gate inside it — a guard that needs the
 * hazard to exist in order to test it is a guard that keeps the hazard alive.
 */


export function sendCommandToAgent(
  agentId: string,
  text: string,
  includeMemory = false,
  attachments?: CommandAttachmentInput[],
  opts: { trackObjective?: boolean; standard?: boolean; deliverNow?: boolean } = {},
): Command | null {
  const agentCheck = db.prepare('SELECT id, repo_name, repo_path, status, pending_question, agent_type, session_id, machine, inbox_pid, inbox_token FROM agents WHERE id = ?')
    .get(agentId) as { id: string; repo_name: string; repo_path: string; status: string; pending_question: string; agent_type: string; session_id: string; machine: string; inbox_pid: number; inbox_token: string } | undefined;
  if (!agentCheck) return null;

  // Driving an agent un-dismisses it. Sending it a prompt (from the dashboard, the phone, or
  // a workflow step) is an unambiguous "I'm working on this again" — it must not stay hidden
  // while you're actively talking to it. The register() hook path covers activity the agent
  // originates; this covers activity YOU originate, which lands before any hook fires.
  const revived = db
    .prepare('UPDATE agents SET dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL')
    .run(agentId).changes > 0;

  // Is this an ANSWER to a question the agent is blocked on, rather than a new ask?
  // MUST be computed before the 'waiting' clear below, which erases the signal.
  const answeringQuestion = isAnswerToPendingQuestion({
    status: agentCheck.status,
    pendingQuestion: agentCheck.pending_question,
  });

  // Clear 'waiting' status when user responds from dashboard
  const cleared = agentCheck.status === 'waiting';
  if (cleared) {
    const now2 = new Date().toISOString();
    db.prepare(`UPDATE agents SET status = 'working', pending_question = '', last_seen = ? WHERE id = ?`).run(now2, agentId);
  }

  // Broadcast if we changed anything the grid renders. Reviving MUST emit too — otherwise the
  // agent un-hides in the DB but the grid keeps hiding it until the next refresh.
  const trackObjective = opts.trackObjective !== false;
  // A continuation ("continue", "yes") is not a new objective — it is more of the current
  // one. Overwriting on every command meant the live objective decayed to the last word
  // typed, so the dashboard showed "continue" as the task and the work-standard gate quoted
  // it back to the agent as the thing it had failed to finish. Keep the real ask; only a
  // genuine new ask replaces it.
  const isNewObjective = shouldInjectForDispatch(text, { status: agentCheck.status, pendingQuestion: agentCheck.pending_question });
  const objectiveChanged = trackObjective
    ? db.prepare(
        `UPDATE agents
         SET active_objective = CASE
               WHEN ? = 1 OR TRIM(COALESCE(active_objective, '')) = '' THEN ?
               ELSE active_objective
             END,
             recovery_status = '', interrupted_at = NULL, recovery_session_id = ''
         WHERE id = ?`,
      ).run(isNewObjective ? 1 : 0, text.slice(0, 4000), agentId).changes > 0
    : false;

  if (cleared || revived || objectiveChanged) {
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
      recoveryStatus: ((updated.recovery_status ?? '') as string) as Agent['recoveryStatus'],
      interruptedAt: (updated.interrupted_at ?? '') as string,
      activeObjective: (updated.active_objective ?? '') as string,
      standardState: ((updated.standard_state ?? '') as string) as Agent['standardState'],
    };
    getIO().emit('agent_updated', normalized);
  }

  // Auto-inject relevant memories into command context (if enabled)
  let finalText = text;
  // Same rule as confer/workflow launches: this server can only write into checkouts on its
  // own disk. A cartridge relaying in from another Mac is reachable (its socket is right
  // here) but its repo is not, and the raw fs error names a path from the OTHER user's home.
  if (attachments && attachments.length > 0 && !isLocalMachine(agentCheck.machine)) {
    throw new Error(
      `Attachments cannot be sent to a cartridge on another machine yet — ` +
      `${agentCheck.repo_name || agentCheck.id} runs on ${machineLabel(agentCheck.machine)}.`,
    );
  }
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
      // Prefix onto finalText, not `text` — rebuilding from `text` here used to drop the
      // attachment block whenever memory happened to be non-empty, so an attached file
      // silently vanished from the prompt.
      finalText = `[Memory: ${memoryBlock}]\n${finalText}`;
    }
  }

  // ── Goal brief injection (lib/goal-brief.ts) ───────────────────────────────
  //
  // Sits beside the work standard and for the same reason: this is the one funnel every
  // prompt passes through, so nine call sites inherit the goal without being touched.
  // Gated on the same condition as the standard — a dispatch, not a reply. Re-stating the
  // goal on every "yes"/"continue" would burn context to say what the agent was told when
  // the task began.
  if (opts.standard !== false && !answeringQuestion && shouldInjectForDispatch(text, {
    status: agentCheck.status,
    pendingQuestion: agentCheck.pending_question,
  })) {
    const brief = goalBriefForAgent(agentId);
    if (brief) finalText = `${brief}\n\n${finalText}`;
  }

  // ── Work-standard injection (docs/WORK-STANDARD.md) ────────────────────────
  //
  // Every prompt in the fleet funnels through here — dashboard, mobile, workflow steps,
  // queued tasks, agent-to-agent handoffs — so this is the one place that can guarantee
  // the contract travels with the work.
  //
  // Dispatch OFFERS the contract; it becomes binding only when the agent actually edits
  // something (armOnWork, from the activity route). Arming here instead made questions
  // binding — a long question looks exactly like an ask, so answering one and stopping was
  // treated as abandoning a task. Prompts that are replies ("yes", "continue") inject
  // nothing and leave any existing offer alone: a continuation mid-task is the same task.
  //
  // Answering a pending question injects NOTHING and touches no gate state: the agent is
  // already under the contract, so re-stating it wastes tokens and resetting the arming
  // would release an agent that is mid-edit. `answeringQuestion` is captured above, before
  // the waiting-status clear erases it.
  if (opts.standard !== false && !answeringQuestion && shouldInjectForDispatch(text, {
    status: agentCheck.status,
    pendingQuestion: agentCheck.pending_question,
  })) {
    finalText = `${finalText}\n\n${WORK_STANDARD_SHORT}`;
    db.prepare(
      `UPDATE agents SET standard_offered = 1, standard_armed = 0, standard_blocks = 0, standard_state = '' WHERE id = ?`,
    ).run(agentId);
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

  // Emit to the primary socket (most recently registered window) to avoid sending to
  // multiple VS Code windows that may share the same agent room.
  /*
   * ONE place sets the transport, because a branch that sets the field and
   * forgets the row — or the reverse — is exactly the drift this task exists to
   * remove. Every conclusion below goes through here.
   */
  const conclude = (t: DeliveryTransport, delivered: boolean) => {
    command.delivered = delivered;
    command.transport = t;
    db.prepare('UPDATE commands SET transport = ? WHERE id = ?').run(t, id);
  };

  /**
   * ADX-007 — `deliverNow` takes the inbox socket AHEAD of the relay, and only here.
   *
   * The relay is the better transport in every ordinary case and remains the default below.
   * But it writes into the PTY as a bracketed paste, so it lands in the input buffer BEHIND
   * whatever the session is doing — it arrives when the current turn ends, which is exactly
   * what "now" is not. The inbox socket is delivered between tool calls during an active turn.
   *
   * So this is not an optimisation and not a preference: it is the only transport that
   * satisfies the request. A deliverNow that used the relay would report success while doing
   * nothing a queue would not have done.
   *
   * With no inbox there is no mid-turn road, and this falls through to the ordinary chain
   * rather than claiming a delivery it cannot make.
   */
  /*
   * REACHABLE, not merely recorded — `inbox_pid` is written once at relay start
   * and never cleared when the session exits. Measured: with a stale pid this
   * branch claimed 'inbox-socket', skipped a relay that WAS connected and could
   * have carried it, and the dispatch was silently lost. That is the exact
   * failure the epic exists to remove, reintroduced by the new option.
   */
  if (opts.deliverNow && inboxReachable(agentCheck.inbox_pid)) {
    conclude('inbox-socket', false);
    const cmdId = command.id;
    void postToInbox({
      pid: agentCheck.inbox_pid,
      token: agentCheck.inbox_token || null,
      text: finalText,
    }).then((res) => {
      if (res.ok) {
        db.prepare(`UPDATE commands SET status = 'delivered', delivered_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), cmdId);
        console.log(`[cmd] deliverNow reached ${agentCheck.repo_name} mid-turn over its inbox (pid ${agentCheck.inbox_pid})`);
      } else {
        console.error(`[cmd] deliverNow failed for ${agentCheck.repo_name} (${res.kind}): ${res.detail}`);
      }
    });
    return command;
  }

  const agentRoom = `agent:${agentId}`;
  const primarySocketId = getPrimarySocket(agentId);
  const primarySocket = primarySocketId ? getIO().sockets.sockets.get(primarySocketId) : undefined;

  if (primarySocket) {
    console.log(`[cmd] Emitting command_send to primary socket ${primarySocketId} for agent ${agentId}`);
    primarySocket.emit('command_send', command);
    conclude('primary-socket', true);
  } else {
    const agentRoomSize = getIO().sockets.adapter.rooms.get(agentRoom)?.size ?? 0;
    if (agentRoomSize > 0) {
      console.log(`[cmd] No primary socket — falling back to room ${agentRoom} (${agentRoomSize} socket(s))`);
      getIO().to(agentRoom).emit('command_send', command);
      conclude('agent-room', true);
    } else if (agentCheck.inbox_pid > 0) {
      /**
       * ADX-005 — THE ADDRESSED INBOX, tried where the only alternative is giving up.
       *
       * No relay socket is connected, so today this cartridge would be written off with
       * NO COMMAND CHANNEL. It is very likely still alive: the relay's websocket and the
       * cartridge's own inbox socket fail independently, and the inbox is bound by the Claude
       * process itself rather than by our relay.
       *
       * WHY THIS POSITION AND NOWHERE EARLIER. `postToInbox` is async and this function is
       * synchronous with 22 call sites depending on that. A branch in the middle of the chain
       * would need the socket's answer before deciding whether to fall through — impossible
       * without changing the signature. Here, nothing follows: success rescues a dispatch that
       * would have been lost, failure lands exactly where the code already ended up. The
       * asynchrony costs nothing because there is no next branch to reach.
       *
       * `delivered` STAYS FALSE on the synchronous return. ADX-001 measured that a session
       * parked on the trust-this-folder prompt accepts the connection, takes the write, and
       * delivers nothing, with no error either side — so a socket that swallowed our bytes is
       * not proof anyone saw them. The ROW is updated when the post actually resolves, which is
       * the first moment anything true is known.
       */
      conclude('inbox-socket', false);
      const cmdId = command.id;
      void postToInbox({
        pid: agentCheck.inbox_pid,
        token: agentCheck.inbox_token || null,
        text: finalText,
      }).then((res) => {
        if (res.ok) {
          db.prepare(`UPDATE commands SET status = 'delivered', delivered_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), cmdId);
          console.log(`[cmd] Delivered to ${agentCheck.repo_name} over its addressed inbox (pid ${agentCheck.inbox_pid})`);
        } else {
          // Named, not swallowed: 'no-socket' means the session exited, 'stale-pid' means the
          // pid was recycled and we refused to write to a stranger. Those are different repairs.
          console.error(`[cmd] Inbox delivery failed for ${agentCheck.repo_name} (${res.kind}): ${res.detail}`);
        }
      });
    } else {
      // Nothing is listening. The command row stays 'pending' and will drain if a socket
      // reconnects — but nothing guarantees that, and callers must be able to tell the
      // difference between "delivered" and "queued into the void".
      console.error(`[cmd] NO COMMAND CHANNEL for agent ${agentId} (${agentCheck.repo_name}) — command queued as pending, nothing is listening. Start a relay for this cartridge.`);
      conclude('no-channel', false);
    }
  }

  /**
   * BUDGET, at the one point every dispatch passes through.
   *
   * The cap used to be consulted only by the heartbeat scheduler, so it covered scheduled runs
   * and nothing else — manual launches, queued tasks, confer turns, workflow steps and
   * dashboard prompts all ignored it. Nine call sites inherit from this function, so one check
   * here covers all of them.
   *
   * WARNS, never blocks: the user's decision, and blocking mid-session would strand work
   * someone is actively doing. Deliberately after the send, so a fault in accounting can never
   * prevent a dispatch — and wrapped, because a warning is not worth an exception.
   */
  try {
    const alert = noteBudgetOnDispatch(agentId);
    if (alert) {
      console.warn(`[budget] ${alert.message}`);
      // Reuses the channel the dashboard's notification centre already listens on, rather
      // than inventing a second one nobody has wired a UI to.
      getIO().emit('workflow_notification' as any, {
        id: uuid(),
        workflowId: '',
        workflowName: alert.goalName,
        title: alert.state === 'over' ? 'Goal over budget' : 'Goal approaching budget',
        body: alert.message,
        projects: [] as string[],
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[budget] check failed (dispatch unaffected):', err);
  }

  return command;
}

