/**
 * The NeonCore Work Standard — enforcement primitives. See docs/WORK-STANDARD.md.
 *
 * The standard exists because of two recurring failure modes: an agent fixes SOME of the
 * cases an ask covers and reports success, or it silently declines part of the ask. Both
 * come from starting at the symptom instead of enumerating the set. The doc states the
 * contract; this file is what makes it more than prose.
 *
 * Three primitives, used by three layers:
 *
 *   WORK_STANDARD_SHORT   → injected into dispatched prompts (send-command.ts)
 *   parseCompletionBlock  → reads the NEONCORE-DONE block an agent must end with
 *   evaluateStop          → decides whether an agent is allowed to stop (agents route,
 *                           called by the Stop hook in agent/hooks/reporter.py)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OFFERED, THEN ARMED — WHY IT IS TWO STEPS
 *
 * `agents.active_objective` is set by EVERY dispatched command, including "yes" and
 * "continue", so it cannot decide who is under the contract. The first version armed at
 * dispatch instead, keyed on the same predicate that injects the standard — but that made a
 * QUESTION binding: "did we open a PR for X?" is long enough to look like an ask, so the
 * agent answered it, changed nothing, tried to stop, and was refused for not filing a
 * completion report on a conversation.
 *
 * Work is what the agent DID, not how the prompt was phrased. So:
 *
 *   dispatch  → standard_offered = 1   (the contract rides along in the prompt)
 *   first edit → standard_armed  = 1   (armOnWork, from the activity ingest route)
 *   report/cap → both cleared          (evaluateStop)
 *
 * Investigate and answer freely; change a file and you owe a completion report.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Database as DatabaseType } from 'better-sqlite3';

/** The literal an agent must emit to close out a task. Greppable on purpose. */
export const COMPLETION_MARKER = 'NEONCORE-DONE';

/**
 * How many times a single objective may be blocked before we let the agent stop anyway.
 *
 * A gate that can never yield is worse than no gate: an agent that genuinely cannot satisfy
 * the contract (ambiguous ask, environment broken, no test runner) would be pinned in a
 * loop, burning tokens against a wall. After the cap the agent stops and the cartridge is
 * flagged `needs_review` instead — the half-done state becomes VISIBLE, which was the goal.
 * Trapping the agent was never the goal.
 */
export const MAX_STOP_BLOCKS = 2;

/** The standard, compressed for injection. Same contract as the doc, not a weaker one. */
export const WORK_STANDARD_SHORT = `[NeonCore work standard — this task is executed under it]
1. SCOPE: restate the ask in one line, then enumerate the COMPLETE set of things it touches — derived from the CODE (registry, schema, enum, call sites), not from the description — and state the count. State now the test that will prove it done.
2. REPRODUCE: write that test FIRST and watch it fail. Make it SET-BASED (iterate the registry) — an example-based test passes on a half-done fix, which is the exact failure this prevents.
3. FIX: every item in the set, one pass. No partial fixes. No silent deferrals — anything you do not do is named in \`deferred:\` with a reason.
4. VERIFY: run the test you stated and paste the REAL output. A failing verify never ends the task.
5. REPORT: end your final message with this block, verbatim:
${COMPLETION_MARKER}
scope: <done>/<total> — <what the set was>
verify: <exact command run> → <actual result>
deferred: none`;

/**
 * Tools whose use means the agent CHANGED something, as opposed to investigating.
 *
 * This registry is what arms the gate (see armOnWork). It is deliberately narrow:
 *
 *  - Bash is NOT here. Most Bash in a session is read-only investigation — grep, ls, git
 *    status, running a test — and there is no reliable way to tell those from `sed -i` or
 *    `rm`. Including it would re-create the bug this exists to fix: answering a question
 *    with a dozen greps would demand a completion report.
 *  - The cost is a task performed ENTIRELY through Bash never arming the gate. That is the
 *    safer direction to fail: a missed gate is a return to the old behaviour, whereas a
 *    false arm blocks a conversation. Dispatched tasks and workflow steps are still covered
 *    by the completion checks in the tasks/workflows routes, which do not depend on arming.
 *
 * Non-Claude names are here for future-proofing only: the stop gate itself is Claude Code
 * only, so an engine whose edit tool is missing from this list loses nothing today.
 */
export const MUTATING_TOOLS = new Set([
  // Claude Code
  'edit', 'write', 'multiedit', 'notebookedit',
  // Codex CLI
  'apply_patch',
  // Gemini CLI
  'write_file', 'replace',
]);

/** Prompts that are replies, not asks — injecting the standard into these is noise. */
const CONTINUATION_RE = /^(y|n|yes|no|ok|okay|k|sure|go|go ahead|proceed|continue|next|stop|wait|thanks|thank you|ty|done|nice|good|great|perfect)\b[\s.!]*$/i;

/** Server-generated blocks that are context, not instructions. */
const NON_ASK_PREFIXES = ['[Project Context for', '[Memory:', '[NeonCore work standard'];

/** Opt-out an operator can type into any prompt to send it raw. */
export const STANDARD_OPT_OUT = '[no-standard]';

/**
 * Does this dispatched text represent real work, i.e. should it carry the standard?
 *
 * Deliberately conservative: when in doubt, inject. A standard on a prompt that didn't need
 * it costs a few hundred tokens; a missing standard on a prompt that did is the bug.
 */
export function shouldInjectStandard(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  if (trimmed.includes(STANDARD_OPT_OUT)) return false;
  if (trimmed.includes(COMPLETION_MARKER)) return false; // already carries the contract
  if (NON_ASK_PREFIXES.some((p) => trimmed.startsWith(p))) return false;
  if (CONTINUATION_RE.test(trimmed)) return false;
  // Short enough to be an interjection rather than an ask ("try again", "the other one").
  if (trimmed.length < 25) return false;
  return true;
}

export interface CompletionBlock {
  scope: string;
  verify: string;
  deferred: string;
}

/** Values that look like a filled-in field but carry no information. */
function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (/^<.*>$/.test(v)) return true;           // the template left unedited
  return ['tbd', 'todo', 'n/a', 'na', '-', '...', 'pending', 'unknown'].includes(v);
}

/**
 * Extract the completion block from an agent's final message.
 *
 * Returns null when the block is absent OR when `scope`/`verify` are empty or placeholders —
 * a report claiming completion with `verify: <exact command>` still in it is not a report.
 * `deferred:` may legitimately be absent; it defaults to "none".
 *
 * The LAST marker in the text wins: an agent that quotes the template earlier in its message
 * (e.g. while restating the contract) and files a real block at the end is honoured, not
 * penalised for having explained itself.
 */
export function parseCompletionBlock(text: string): CompletionBlock | null {
  if (!text) return null;
  const idx = text.lastIndexOf(COMPLETION_MARKER);
  if (idx === -1) return null;

  const after = text.slice(idx + COMPLETION_MARKER.length);
  const field = (name: string): string => {
    // Anchored to a line start so "verify:" inside a pasted log doesn't hijack the field.
    //
    // Horizontal whitespace ONLY ([ \t], never \s). With \s the padding after the colon
    // swallowed the newline, so an EMPTY field matched the following line instead — an
    // omitted `scope:` silently inherited the text of `verify:` and an omitted `verify:`
    // inherited `deferred: none`, both of which then sailed through the placeholder check.
    // A blank field must read as blank.
    const m = after.match(new RegExp(`^[ \\t]*${name}[ \\t]*:[ \\t]*(.+)$`, 'im'));
    return m ? m[1].trim() : '';
  };

  const scope = field('scope');
  const verify = field('verify');
  const deferred = field('deferred') || 'none';

  if (isPlaceholder(scope) || isPlaceholder(verify)) return null;
  return { scope, verify, deferred };
}

/**
 * Validate a structured completion payload (MCP / webhook shape).
 *
 * Accepts either explicit fields or a legacy free-text result that happens to contain a
 * completion block — one code path, both shapes, so agents mid-flight on the old contract
 * are not hard-failed for a protocol change they never saw.
 *
 * Returns the normalized block, or a reason string explaining what is missing.
 */
export function validateCompletionPayload(payload: {
  result?: string;
  scope?: string;
  verify?: string;
  deferred?: string;
}): { ok: true; block: CompletionBlock } | { ok: false; reason: string } {
  const scope = (payload.scope || '').trim();
  const verify = (payload.verify || '').trim();

  if (!isPlaceholder(scope) && !isPlaceholder(verify)) {
    return { ok: true, block: { scope, verify, deferred: (payload.deferred || 'none').trim() } };
  }

  const fromResult = parseCompletionBlock(payload.result || '');
  if (fromResult) return { ok: true, block: fromResult };

  const missing: string[] = [];
  if (isPlaceholder(scope)) missing.push('scope (how many items the ask covered, and how many you completed)');
  if (isPlaceholder(verify)) missing.push('verify (the exact command you ran and its real output)');
  return {
    ok: false,
    reason:
      `Completion rejected — missing ${missing.join(' and ')}. ` +
      `Under the NeonCore work standard a task is not done until it is verified: run the test you ` +
      `defined at the start, then report again with scope + verify filled in from the actual output. ` +
      `If something was intentionally left out, name it in deferred.`,
  };
}

/**
 * Arm the gate the first time an offered agent actually changes something.
 *
 * Called from the activity ingest route, which every engine's reporter posts to. Dispatch
 * only OFFERS the contract (`standard_offered`); this is what makes it binding.
 *
 * The split exists because arming at dispatch time meant a question armed the gate: the
 * agent answered, touched nothing, tried to stop, and was refused for not filing a
 * completion report on a conversation. Work is defined by what the agent DID, not by how
 * long the prompt was.
 *
 * Returns true if this call armed the gate (useful for logging); idempotent afterwards.
 */
export function armOnWork(
  db: DatabaseType,
  opts: { agentId: string; toolName: string },
): boolean {
  if (!opts.agentId || !opts.toolName) return false;
  if (!MUTATING_TOOLS.has(opts.toolName.trim().toLowerCase())) return false;

  const changed = db.prepare(
    `UPDATE agents SET standard_armed = 1
     WHERE id = ? AND standard_offered = 1 AND standard_armed = 0`,
  ).run(opts.agentId).changes;

  return changed > 0;
}

export type StopDecision =
  | { decision: 'allow'; cleared: boolean }
  | { decision: 'block'; reason: string };

interface StopGateRow {
  id: string;
  active_objective: string;
  standard_armed: number;
  standard_blocks: number;
}

/**
 * Decide whether an agent may stop, and record the consequence.
 *
 * Called from POST /api/agents/completion-check, which the Stop hook consults on every
 * end-of-turn. Four outcomes:
 *
 *   unknown agent / not armed / no objective → allow  (never interfere with free conversation)
 *   valid completion block                   → allow, objective cleared, gate disarmed
 *   no block, under the cap                  → BLOCK with the checklist; the agent continues
 *   no block, cap reached                    → allow, but flag the cartridge needs_review
 *
 * `stopHookActive` is Claude Code telling us this turn is ALREADY the product of a previous
 * block. Blocking again on the same continuation is how a hook loop starts, so it is an
 * immediate allow — the cap alone is not enough, because the cap counts our decisions while
 * this flag reflects the harness's actual state.
 */
export function evaluateStop(
  db: DatabaseType,
  opts: {
    sessionId: string;
    agentType?: string;
    finalText: string;
    stopHookActive?: boolean;
    maxBlocks?: number;
  },
): StopDecision {
  const maxBlocks = opts.maxBlocks ?? MAX_STOP_BLOCKS;

  if (!opts.sessionId) return { decision: 'allow', cleared: false };

  const row = (opts.agentType
    ? db.prepare(
        'SELECT id, active_objective, standard_armed, standard_blocks FROM agents WHERE session_id = ? AND agent_type = ? LIMIT 1',
      ).get(opts.sessionId, opts.agentType)
    : db.prepare(
        'SELECT id, active_objective, standard_armed, standard_blocks FROM agents WHERE session_id = ? LIMIT 1',
      ).get(opts.sessionId)) as StopGateRow | undefined;

  if (!row) return { decision: 'allow', cleared: false };
  if (!row.standard_armed) return { decision: 'allow', cleared: false };
  if (!row.active_objective?.trim()) return { decision: 'allow', cleared: false };

  const block = parseCompletionBlock(opts.finalText);
  if (block) {
    // Contract satisfied: close the objective so the next turn starts clean.
    db.prepare(
      `UPDATE agents SET active_objective = '', standard_armed = 0, standard_offered = 0, standard_blocks = 0, standard_state = '' WHERE id = ?`,
    ).run(row.id);
    return { decision: 'allow', cleared: true };
  }

  if (opts.stopHookActive || row.standard_blocks >= maxBlocks) {
    db.prepare(
      `UPDATE agents SET standard_armed = 0, standard_offered = 0, standard_blocks = 0, standard_state = 'needs_review' WHERE id = ?`,
    ).run(row.id);
    return { decision: 'allow', cleared: false };
  }

  db.prepare('UPDATE agents SET standard_blocks = standard_blocks + 1 WHERE id = ?').run(row.id);

  return {
    decision: 'block',
    reason: buildBlockReason(row.active_objective, row.standard_blocks + 1, maxBlocks),
  };
}

/** The message handed back to the agent when it tries to stop without filing a report. */
export function buildBlockReason(objective: string, attempt: number, maxBlocks: number): string {
  const lastChance = attempt >= maxBlocks
    ? `\n\nThis is the last time you will be stopped on this task. If you stop again without the block, the cartridge is flagged for human review as incomplete.`
    : '';

  return (
    `You are stopping without filing a completion report, so this task is not finished under the NeonCore work standard.\n\n` +
    `The task was: ${objective.slice(0, 500)}\n\n` +
    `Before you stop, work through this and fix anything it exposes:\n` +
    `1. SCOPE — did you enumerate the COMPLETE set this ask covers (from the registry/schema/call sites, not from the description), and handle every member? If you fixed the cases you happened to see rather than the whole set, go finish it now.\n` +
    `2. VERIFY — did you actually RUN a test that fails on a partial fix, and see it pass? If not, run it. Do not claim verification you did not perform.\n` +
    `3. DEFERRALS — is there anything you decided not to do? It must be named explicitly, not dropped.\n\n` +
    `Then end your message with the block, verbatim:\n` +
    `${COMPLETION_MARKER}\n` +
    `scope: <done>/<total> — <what the set was>\n` +
    `verify: <exact command run> → <actual result>\n` +
    `deferred: none` +
    lastChance
  );
}
