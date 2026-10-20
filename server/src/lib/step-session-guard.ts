/**
 * A PROMPT DELIVERED INTO A SESSION THAT IS ALREADY GONE IS A PROMPT NOBODY READ.
 *
 * The failure, observed end to end: a cartridge was launched at 17:41, a workflow step was
 * dispatched to it at 17:45, and the command recorded `delivered: true` — because the RELAY
 * socket accepted it. The engine inside that freshly-launched relay had not attached yet, so
 * nothing consumed the prompt. At 17:49 the user typed "hello", which started a DIFFERENT
 * session, and only then did the cartridge do anything. The step sat `running` for eight
 * minutes holding a prompt nobody had read, and no surface reported a problem.
 *
 * ── WHY NOTHING CAUGHT IT ──────────────────────────────────────────────────────────────
 * Every existing staleness check judges `last_seen`, and `last_seen` is a RELAY heartbeat. A
 * relay with no engine attached keeps that timestamp fresh while doing absolutely nothing, so
 * the cartridge looked healthy for the entire window. `delivered` is equally weak: it means the
 * socket accepted the emit, not that an engine received it. Neither signal can see this.
 *
 * ── THE SIGNAL THAT CAN ────────────────────────────────────────────────────────────────
 * The session a prompt was sent into is recorded at dispatch. If the cartridge is now running a
 * DIFFERENT session while the step still waits, the prompt went somewhere that no longer
 * exists — that is a fact, not an inference, and it is exactly the race. The step is re-sent to
 * the live session.
 *
 * Deliberately conservative in three ways, because a wrong re-send duplicates real work:
 *  - only `running` steps with a stored prompt,
 *  - only when a dispatch session was recorded AND differs from the current one,
 *  - at most once per step (`recovery_attempts`), so a re-send that does not take cannot loop.
 */
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { sendCommandToAgent, noChannel } from './send-command.js';

// ── CONSUMED IS NOT ORPHANED ─────────────────────────────────────────────────────────────
// "Session changed" is not proof the prompt was lost: the prompt itself usually STARTS the new
// session, and the session id recorded at dispatch is the row's previous one. On 2026-10-18 the
// guard re-sent a step 9s after the engine's prompt hook had logged it — the agent got the same
// task twice, mid-work. The engine's UserPromptSubmit hook (activity 'user_prompt') is the proof
// of receipt, so every step prompt carries a unique marker on LINE 1: the hook stores only the
// first 4,000 chars, and a step id at the end of a 5k prompt was invisible to it.
const MARKER_RE = /^\[neoncore step [^\]\n]+\]$/;

/** Prefix a step prompt with its dispatch marker. Unique per dispatch, so a loop's second pass
 *  is never mistaken for the first. */
export function markStepPrompt(stepId: string, prompt: string): string {
  return `[neoncore step ${stepId} #${randomUUID().slice(0, 8)}]\n${prompt}`;
}

/** The marker on a stored prompt's first line, or null for prompts dispatched before markers. */
export function stepMarkerOf(prompt: string): string | null {
  const first = (prompt || '').split('\n', 1)[0];
  return MARKER_RE.test(first) ? first : null;
}

/** Did the target engine's own prompt hook log this exact dispatch? */
function engineReceived(agentId: string, prompt: string): boolean {
  const marker = stepMarkerOf(prompt);
  if (!marker) return false;
  return Boolean(db.prepare(
    `SELECT 1 FROM activity WHERE agent_id = ? AND event_type = 'user_prompt' AND INSTR(tool_input, ?) > 0 LIMIT 1`,
  ).get(agentId, marker));
}

interface OrphanedStep {
  id: string;
  workflow_id: string;
  name: string;
  executor_id: string;
  target_agent: string;
  dispatched_prompt: string;
  dispatch_session_id: string;
  recovery_attempts: number;
  current_session: string;
}

/**
 * Re-send steps whose target cartridge has moved to a different session. Returns the step ids
 * that were re-sent, so the caller can log exactly what it did.
 */
export function redispatchOrphanedSteps(): string[] {
  const rows = db.prepare(`
    SELECT s.id, s.workflow_id, s.name, s.executor_id, s.dispatched_prompt,
           s.dispatch_session_id, s.recovery_attempts,
           a.id AS target_agent,
           COALESCE(a.session_id, '') AS current_session
      FROM workflow_steps s
      -- The cartridge the prompt WENT to. A review gate may dispatch to a reviewer, not the
      -- executor; rows from before dispatch_agent_id fall back to the executor.
      JOIN agents a ON a.id = COALESCE(NULLIF(s.dispatch_agent_id, ''), s.executor_id)
     WHERE s.status = 'running'
       AND COALESCE(s.dispatched_prompt, '') != ''
       -- A blank recorded session predates this guard: nothing to compare, and guessing would
       -- re-send work that may well be in progress.
       AND COALESCE(s.dispatch_session_id, '') != ''
       AND COALESCE(a.session_id, '') != ''
       AND a.session_id != s.dispatch_session_id
       -- One re-send only. If the live session ignores it too, the problem is not the race.
       AND COALESCE(s.recovery_attempts, 0) < 1
  `).all() as OrphanedStep[];

  const resent: string[] = [];
  for (const s of rows) {
    if (engineReceived(s.target_agent, s.dispatched_prompt)) {
      // Received — the session change was the prompt starting a new session. Adopt it so this
      // step is not re-judged every sweep, and spend no recovery attempt.
      db.prepare('UPDATE workflow_steps SET dispatch_session_id = ? WHERE id = ?').run(s.current_session, s.id);
      continue;
    }

    // Count the attempt and move the step onto the live session BEFORE sending, so a throw
    // mid-dispatch cannot leave the row eligible again on the next sweep.
    db.prepare(
      `UPDATE workflow_steps
          SET dispatch_session_id = ?, recovery_attempts = COALESCE(recovery_attempts, 0) + 1
        WHERE id = ?`,
    ).run(s.current_session, s.id);

    try {
      const cmd = sendCommandToAgent(s.target_agent, s.dispatched_prompt, false);
      // Counted as re-sent on the ATTEMPT, deliberately not gated on `cmd.delivered`.
      // `delivered` only means a socket accepted the emit — trusting it is precisely the
      // mistake that produced this bug, and gating here would reintroduce it one level up.
      // Delivery is reported, never used as the success condition.
      resent.push(s.id);
      console.log(
        `[session-guard] re-sent step "${s.name}" (${s.id.slice(0, 8)}) — its prompt had gone to ` +
        `session ${s.dispatch_session_id.slice(0, 12)}, cartridge is now on ${s.current_session.slice(0, 12)}`,
      );
      if (noChannel(cmd)) {
        console.warn(`[session-guard] ...and the re-send found no live channel on ${s.target_agent}`);
      }
    } catch (err) {
      console.error(`[session-guard] re-send failed for step ${s.id.slice(0, 8)}:`, err);
    }
  }
  return resent;
}
