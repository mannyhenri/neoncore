/**
 * What an incoming activity event says about whether a cartridge can take new work.
 *
 * `routes/activity.ts` set `status = 'working'` for every event type, which threw away the one
 * signal that means "blocked on a human". Claude Code fires a `notification` hook whose payload
 * is literally "Claude is waiting for your input"; that was recorded as working, and the agent
 * then aged to `idle`. A cartridge waiting on you was indistinguishable from one with nothing
 * to do — which is why a CE decision step sat for hours unnoticed, and why the staleness sweep
 * eventually declared a healthy agent dead for producing no tool events while it waited.
 *
 * ── WHY THE PAYLOAD AND NOT THE EVENT TYPE ────────────────────────────────────────────
 * `notification` is not one thing. The live table holds 719 of them, and most are reports the
 * fleet sends about ITSELF — "FAILED: … went offline", "New confer queued … will NOT run",
 * "Confer … FAILED at Draft 3/3". Mapping the type to `waiting` would mark a cartridge blocked
 * every time it filed a status report, and since the queue counts `waiting` as busy, that would
 * halt its lane. Worse than the bug it fixes. So the classifier reads what the notification
 * actually says.
 *
 * ── NULL MEANS "DON'T KNOW", NOT "IDLE" ───────────────────────────────────────────────
 * Returning null leaves the existing status alone. New hook types appear over time, and
 * defaulting them to `working` is exactly how the original defect happened — it assumed every
 * signal meant work. An unrecognised event updates `last_seen` (proof of life) and nothing else.
 */

export type ActivityStatus = 'working' | 'waiting';

/** Events that are unambiguous evidence the cartridge is executing. */
const WORKING_EVENTS = new Set([
  'PostToolUse',
  'PreToolUse',
  'tool_use',
  'user_prompt',
  'user_command',
  // A turn ending is still the agent acting. The separate idle timer handles working→idle
  // after its grace period; treating Stop as idle here would race that and flicker.
  'Stop',
  'SubagentStop',
]);

/** Events that ARE the question, regardless of payload. */
const ASKING_EVENTS = new Set(['ask_user']);

/**
 * The canonical Claude Code notification texts that mean the turn has stopped and a person
 * must act. Anchored on the agent as the subject ("Claude is waiting", "Claude needs") so a
 * report merely mentioning waiting — "Confer is waiting on baseback to report" — does not
 * block the cartridge that sent it.
 */
const BLOCKED_PATTERNS = [
  /\bclaude\s+is\s+waiting\s+for\s+your\s+input\b/i,
  /\bclaude\s+needs\s+your\s+permission\b/i,
  /\bwaiting\s+for\s+your\s+input\b/i,
  /\bneeds\s+your\s+permission\b/i,
];

/**
 * The availability this event implies, or null to leave the current status untouched.
 */
export function statusFromActivity(eventType: string, payload?: string): ActivityStatus | null {
  const event = (eventType || '').trim();
  if (!event) return null;

  if (ASKING_EVENTS.has(event)) return 'waiting';

  if (event === 'notification') {
    const text = payload || '';
    return BLOCKED_PATTERNS.some((p) => p.test(text)) ? 'waiting' : null;
  }

  return WORKING_EVENTS.has(event) ? 'working' : null;
}
