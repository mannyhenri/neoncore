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
import { decisionOptions, decideStep, advanceStep, workflowIdOfStep } from './workflow-resolve.js';
import { recoverStep } from './recovery.js';
import { registerAction } from './commands-registry.js';
import {
  effectiveAutonomy, canAutoResolve, recordAutoResolution, type AutonomyLevel,
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
  let chose: string;
  switch (attention.reason) {
    case 'manual-advance': {
      const r = advanceStep(attention.stepId);
      if (!r.ok) {
        console.warn(`[autonomy] ${wf.id}: advance failed: ${r.error}`);
        return null;   // fall through to asking a person, which is the safe direction
      }
      chose = 'advance';
      break;
    }
    default:
      return null;
  }

  recordAutoResolution({
    workflowId: wf.id, stepId: attention.stepId,
    reason: attention.reason, chose, autonomy: level,
  });

  return {
    title: `${runLabel(wf)} — advanced automatically`,
    body: `"${attention.stepName}" finished and was released without you.`,
    detail: {
      Run: runLabel(wf),
      Step: attention.stepName,
      Autonomy: `${level} (${source}${expiresAt ? `, until ${expiresAt}` : ''})`,
      Recorded: 'workflow_auto_resolutions',
    },
    actions: [],
    data: {
      type: 'workflow_auto_resolved',
      reason: attention.reason,
      workflowId: wf.id,
      stepId: attention.stepId,
      autonomy: level as AutonomyLevel,
      chose,
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

  registerAction(ACTION_PREFIX.recover, async ({ payload, reply }) => {
    const stepId = payload.split(':')[0];
    if (!stepId) return reply('Malformed recover action.');
    if (!workflowIdOfStep(stepId)) return reply('That step no longer exists.');
    const r = recoverStep(stepId);
    await reply(r.ok ? 'Recovery started.' : `Could not recover: ${'error' in r ? r.error : 'unknown'}`);
  });
}

export { ATTENTION_REASONS, type AttentionReason };
