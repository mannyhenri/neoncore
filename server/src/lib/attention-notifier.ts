/**
 * Attention events → notices — N3 of docs/plans/build-order.md.
 *
 * "This is the phase that ends work stalling while you are away", and it is written once
 * against `Notice`. Nothing here knows Discord exists; a run blocked on a decision reaches
 * every configured channel, and a second app is a registration, not an edit to this file.
 *
 * ── THE HARD PART IS NOT SENDING, IT IS NOT RE-SENDING ─────────────────────────────────
 * `workflowNeedsAttention` is DERIVED — computed from the rows every time it is asked, which
 * is what makes "is this waiting on me right now?" answerable at any moment. A notice is the
 * opposite: one shot, at a moment. Sweeping derived state and notifying on every pass would
 * send the same "waiting for your choice" every minute until you answered it, which trains you
 * to ignore the channel and defeats the phase.
 *
 * So this notifies on TRANSITION. The key is reason+step, not just the workflow: a run that
 * fails while you were deciding something is a genuinely new thing to tell you, and a run that
 * moves from one held step to the next is too. Resolution clears the key, so the same gate
 * reached twice in one run notifies twice — correctly.
 *
 * The map is in memory. A restart re-announces anything still blocked, which is the right
 * failure direction: being told twice about a stalled run costs you a glance, being told zero
 * times costs you the afternoon.
 */
import db from '../db.js';
import { notifyAll, type Notice } from './channels.js';
import { workflowNeedsAttention, ATTENTION_REASONS, type Attention, type AttentionReason } from './workflow-attention.js';
import {
  decisionOptions, decideStep, advanceStep, workflowIdOfStep,
  unadvanceStep, undecideStep, executorConfigOf,
} from './workflow-resolve.js';
import { recoverStep } from './recovery.js';
import { sendCommandToAgent } from './send-command.js';
// The single decision path, reused rather than reimplemented. It lives under routes/ because
// that is where a decision has always been recorded; a second copy is how the dashboard and a
// channel start disagreeing about what an answered request looks like.
import { applyDecision } from '../routes/permissions.js';
import { answerPayloadFor, parseQuestions } from './permission-notice.js';
import { registerAction } from './commands-registry.js';
import {
  effectiveAutonomy, canAutoResolve, recordAutoResolution, recommendationOf,
  getAutoResolution, isOverridable, markOverridden, OVERRIDE_WINDOW_MS,
  type AutonomyLevel,
} from './autonomy.js';

/**
 * Action id prefixes. SHORT on purpose: a Discord customId is capped at 100 characters and a
 * step id alone is a 36-character uuid, so `wfdecide:<workflowId>:<stepId>:<optionId>` would
 * overflow before the option was even named. Ids carry the STEP only and the run is looked up.
 */
export const ACTION_PREFIX = {
  decide: 'wfdecide',
  advance: 'wfadvance',
  recover: 'wfrecover',
  /** Reverse an auto-resolution. Payload is the audit row's id, not the step's. */
  undo: 'wfundo',
} as const;

/** Discord's hard cap. Asserted in the test rather than discovered in production. */
export const MAX_ACTION_ID = 100;

export interface WorkflowRow { id: string; name: string; run_number: number }

function runLabel(wf: WorkflowRow): string {
  return `${wf.name}${wf.run_number ? ` #${wf.run_number}` : ''}`;
}

/**
 * What can resolve each reason, as buttons.
 *
 * TWO REASONS DELIBERATELY CARRY NONE, and that is a decision rather than an omission:
 *
 *  - `failed` is breakage, not a gate. The plan is explicit that it "is never auto-resolved at
 *    any level"; the honest remote affordance is being TOLD, not a one-tap button that skips a
 *    step or cancels a run from a lock screen.
 *  - `agent-waiting` needs an ANSWER, and an answer is free text. A button cannot carry it, so
 *    the notice names the exact `!prompt` line to reply with instead of offering a control that
 *    could not do the job.
 */
export function actionsFor(attention: Attention): Notice['actions'] {
  switch (attention.reason) {
    case 'decision':
      return decisionOptions(attention.stepId).map((o) => ({
        id: `${ACTION_PREFIX.decide}:${attention.stepId}:${o.id}`,
        label: o.label,
        style: 'primary',
      }));
    case 'manual-advance':
      return [{ id: `${ACTION_PREFIX.advance}:${attention.stepId}`, label: 'Advance', style: 'success' }];
    case 'interrupted':
      return [{ id: `${ACTION_PREFIX.recover}:${attention.stepId}`, label: 'Recover', style: 'primary' }];
    case 'failed':
    case 'agent-waiting':
      return [];
  }
}

/** How to resolve a reason that has no button, in the words you would type. */
function hint(attention: Attention, cartridge: string | null): string | null {
  if (attention.reason === 'agent-waiting') {
    return cartridge
      ? `Reply: \`!prompt ${cartridge} <your answer>\``
      : 'Answer it from the dashboard.';
  }
  if (attention.reason === 'failed') return 'Open the run to skip the step or cancel.';
  if (attention.reason === 'agent-idle') {
    return cartridge
      ? `The cartridge went quiet without reporting. Nudge it: \`!prompt ${cartridge} finish the step and report\``
      : 'The cartridge went quiet without reporting. Re-dispatch the step from the dashboard.';
  }
  return null;
}

function cartridgeForStep(stepId: string): string | null {
  const row = db.prepare(`
    SELECT a.repo_name AS repo, a.name AS name FROM workflow_steps s
    JOIN agents a ON a.id = s.executor_id WHERE s.id = ?
  `).get(stepId) as { repo: string; name: string } | undefined;
  return row?.repo || row?.name || null;
}

export function attentionNotice(wf: WorkflowRow, attention: Attention): Notice {
  const cartridge = cartridgeForStep(attention.stepId);
  const tip = hint(attention, cartridge);

  const detail: Record<string, string> = {
    Run: runLabel(wf),
    Step: attention.stepName,
    Reason: attention.reason,
  };
  if (cartridge) detail.Cartridge = cartridge;
  if (tip) detail.Resolve = tip;

  return {
    title: `${runLabel(wf)} needs you`,
    body: attention.detail,
    detail,
    actions: actionsFor(attention),
    data: {
      type: 'workflow_attention',
      reason: attention.reason,
      workflowId: wf.id,
      stepId: attention.stepId,
    },
  };
}

/** reason+step, so a run moving to a different blocker is a new thing to say. */
const lastNotified = new Map<string, string>();
const keyOf = (a: Attention) => `${a.reason}:${a.stepId}`;

export function __resetAttentionStateForTest(): void {
  lastNotified.clear();
}

/**
 * One pass over the running workflows. Exported so the test can drive it deterministically
 * rather than waiting on the interval.
 */
export async function sweepAttention(): Promise<number> {
  const runs = db.prepare(
    "SELECT id, name, run_number FROM workflows WHERE status = 'running'",
  ).all() as WorkflowRow[];

  const live = new Set(runs.map((r) => r.id));
  // A run that finished, or that is no longer blocked, must forget its key — otherwise
  // reaching the same gate again later would be silently swallowed as a duplicate.
  for (const id of [...lastNotified.keys()]) if (!live.has(id)) lastNotified.delete(id);

  let sent = 0;
  for (const wf of runs) {
    let attention: Attention | null = null;
    try {
      attention = workflowNeedsAttention(wf.id);
    } catch (err) {
      console.warn(`[attention] ${wf.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!attention) { lastNotified.delete(wf.id); continue; }

    // N4: may this run settle this for itself? Checked BEFORE the dedupe key, because an
    // auto-resolution is a different event from a request for attention and must not be
    // suppressed by a key set when the run was still asking.
    const resolved = tryAutoResolve(wf, attention);
    if (resolved) {
      lastNotified.delete(wf.id);   // it is no longer blocked on this; the next block is news
      await notifyAll(resolved);
      sent += 1;
      continue;
    }

    const key = keyOf(attention);
    if (lastNotified.get(wf.id) === key) continue;
    lastNotified.set(wf.id, key);

    await notifyAll(attentionNotice(wf, attention));
    sent += 1;
  }
  return sent;
}

/**
 * Settle a gate the run's autonomy level permits, and return the notice that SAYS SO.
 *
 * It still notifies. An autonomous action you are not told about is indistinguishable from a
 * run that never blocked, and the audit table only helps someone who already knows to look.
 * The difference from a normal attention notice is the tense: this reports what happened, and
 * carries no button, because there is nothing left to press.
 *
 * Returns null when the level does not permit it — including for every reason in NEVER_AUTO,
 * at every level.
 */
function tryAutoResolve(wf: WorkflowRow, attention: Attention): Notice | null {
  const { level, source, expiresAt } = effectiveAutonomy(wf.id);
  if (!canAutoResolve(level, attention.reason)) return null;

  // Only `manual-advance` is auto-resolvable today; the switch is exhaustive so a reason added
  // to AUTO_RESOLVABLE without an implementation here fails to compile rather than silently
  // doing nothing while the audit claims otherwise.
  let chose = '';
  let what = '';

  switch (attention.reason) {
    case 'manual-advance': {
      const r = advanceStep(attention.stepId);
      if (!r.ok) {
        console.warn(`[autonomy] ${wf.id}: advance failed: ${r.error}`);
        return null;   // fall through to asking a person, which is the safe direction
      }
      chose = 'advance';
      what = `"${attention.stepName}" finished and was released without you.`;
      break;
    }

    case 'decision': {
      // THE CONFIGURED DEFAULT, or nothing. A gate with no recommendation — or one naming an
      // option that no longer exists — HOLDS AND NOTIFIES. Inventing a branch is the one thing
      // a level must never do; it is the difference between taking your default and guessing.
      const rec = recommendationOf(executorConfigOf(attention.stepId));
      if (!rec) return null;

      const r = decideStep(attention.stepId, rec);
      if (!r.ok) {
        console.warn(`[autonomy] ${wf.id}: decide failed: ${r.error}`);
        return null;
      }
      const label = decisionOptions(attention.stepId).find((o) => o.id === rec)?.label || rec;
      chose = label;
      what = `Took the recommended option at "${attention.stepName}": ${label}.`;
      break;
    }

    case 'agent-waiting': {
      // ANSWER IT. `full` holding at every question made it a slower manual — see autonomy.ts.
      const perm = db.prepare(`
        SELECT p.id, p.tool_name, p.tool_input FROM permissions p
        JOIN workflow_steps s ON s.executor_id = p.agent_id
        WHERE s.id = ? AND p.status = 'pending' ORDER BY p.created_at DESC LIMIT 1
      `).get(attention.stepId) as { id: string; tool_name: string; tool_input: string } | undefined;
      if (!perm) return null;   // nothing pending to answer; ask a person rather than guess

      if (perm.tool_name === 'AskUserQuestion') {
        // The FIRST option — AskUserQuestion lists the recommended choice first by convention.
        const answer = answerPayloadFor(perm.tool_input, 0);
        if (answer) {
          applyDecision(perm.id, 'allowed', answer);
          chose = Object.values(answer.answers)[0];
        } else {
          // Free text, or several questions at once. Say "use your judgement" plainly rather
          // than fabricating a specific answer that reads like a decision someone made.
          const q = parseQuestions(perm.tool_input)[0];
          applyDecision(perm.id, 'allowed', {
            answers: { [q?.question || 'answer']: 'Proceed on your best judgement and record the choice you made.' },
          });
          chose = 'proceed on best judgement';
        }
      } else {
        applyDecision(perm.id, 'allowed');
        chose = `approved ${perm.tool_name}`;
      }
      what = `Answered a question from "${attention.stepName}" without you: ${chose}.`;
      break;
    }

    case 'agent-idle': {
      // NUDGE, never re-run. The prompt was delivered and may be half-done, so re-sending it
      // would duplicate work; this asks the cartridge to finish and report what it owes.
      //
      // Capped at one attempt per step via recovery_attempts, the same counter the orphan guard
      // uses. Without the cap a cartridge that ignores the first nudge is pestered every sweep
      // forever — and a stall that survives a nudge is a person's problem, not a louder loop's.
      const row = db.prepare(
        'SELECT executor_id, recovery_attempts FROM workflow_steps WHERE id = ?',
      ).get(attention.stepId) as { executor_id: string; recovery_attempts: number } | undefined;
      if (!row?.executor_id || (row.recovery_attempts || 0) >= 1) return null;

      db.prepare('UPDATE workflow_steps SET recovery_attempts = COALESCE(recovery_attempts,0) + 1 WHERE id = ?')
        .run(attention.stepId);

      const sent = sendCommandToAgent(row.executor_id,
        `You went idle without completing the workflow step "${attention.stepName}", so the run is `
        + 'stalled and nothing behind it can start. Finish it now: produce the output its prompt '
        + 'asked for and POST it to the completion webhook in that prompt. Do not ask anything — '
        + 'decide from what you already have and proceed.', false);
      if (!sent) return null;

      chose = 'nudged';
      what = `"${attention.stepName}" was dispatched and went quiet; the cartridge was asked to finish and report.`;
      break;
    }

    default:
      return null;
  }

  const resolutionId = recordAutoResolution({
    workflowId: wf.id, stepId: attention.stepId,
    reason: attention.reason, chose, autonomy: level,
  });

  return {
    title: `${runLabel(wf)} — resolved automatically`,
    body: what,
    detail: {
      Run: runLabel(wf),
      Step: attention.stepName,
      Chose: chose,
      Autonomy: `${level} (${source}${expiresAt ? `, until ${expiresAt}` : ''})`,
      Override: `available for ${Math.round(OVERRIDE_WINDOW_MS / 60_000)} minutes`,
    },
    // THE SOFT GATE. Work continued immediately; this is the window in which you can take it
    // back. An auto-resolution with no way to reverse it is automation you watch rather than
    // automation you trust — and the `overridden` audit column would have no writer.
    actions: [{ id: `${ACTION_PREFIX.undo}:${resolutionId}`, label: 'Override', style: 'danger' }],
    data: {
      type: 'workflow_auto_resolved',
      reason: attention.reason,
      workflowId: wf.id,
      stepId: attention.stepId,
      autonomy: level as AutonomyLevel,
      chose,
      resolutionId,
    },
  };
}

let timer: NodeJS.Timeout | null = null;

export function startAttentionNotifier(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    sweepAttention().catch((err) => {
      console.warn(`[attention] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalMs);
  timer.unref?.();
}

export function stopAttentionNotifier(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * Button handlers. Registered against the shared registry, so any driver dispatches them.
 * A reply is always sent: a button that silently does nothing is indistinguishable from a
 * server that has died, which is the note discord-bot.ts already makes about missing handlers.
 */
export function registerAttentionActions(): void {
  registerAction(ACTION_PREFIX.decide, async ({ payload, reply }) => {
    const [stepId, ...optionParts] = payload.split(':');
    const optionId = optionParts.join(':');
    if (!stepId || !optionId) return reply('Malformed decision action.');
    const r = decideStep(stepId, optionId);
    await reply(r.ok ? `Decided: ${optionId}.` : `Could not decide: ${r.error}`);
  });

  registerAction(ACTION_PREFIX.advance, async ({ payload, reply }) => {
    const stepId = payload.split(':')[0];
    if (!stepId) return reply('Malformed advance action.');
    const r = advanceStep(stepId);
    await reply(r.ok ? 'Advanced.' : `Could not advance: ${r.error}`);
  });

  registerAction(ACTION_PREFIX.undo, async ({ payload, reply }) => {
    const id = payload.split(':')[0];
    const row = id ? getAutoResolution(id) : null;
    if (!row) return reply('That auto-resolution is not on record.');

    if (row.overridden) return reply('Already overridden.');
    if (!isOverridable(row)) {
      const mins = Math.round(OVERRIDE_WINDOW_MS / 60_000);
      return reply(
        `The ${mins}-minute override window has closed. The run has built on this since — ` +
        'reverse it from the dashboard, with the rest of the run in front of you.',
      );
    }

    const r = row.reason === 'decision' ? undecideStep(row.stepId) : unadvanceStep(row.stepId);
    if (!r.ok) return reply(`Could not override: ${r.error}`);

    markOverridden(row.id);
    await reply(
      row.reason === 'decision'
        ? `Overridden. The gate is open again — choose with \`!cartridges\` or the dashboard.`
        : 'Overridden. The step is held again.',
    );
  });

  registerAction(ACTION_PREFIX.recover, async ({ payload, reply }) => {
    const stepId = payload.split(':')[0];
    if (!stepId) return reply('Malformed recover action.');
    if (!workflowIdOfStep(stepId)) return reply('That step no longer exists.');
    const r = recoverStep(stepId);
    await reply(r.ok ? 'Recovery started.' : `Could not recover: ${'error' in r ? r.error : 'unknown'}`);
  });
}

export { ATTENTION_REASONS, type AttentionReason };
