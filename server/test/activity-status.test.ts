/**
 * What an activity event says about whether the cartridge can take work.
 *
 * THE GAP. `routes/activity.ts` set `status = 'working'` for EVERY event type, so the one
 * signal that means "this agent is blocked on a human" was discarded on arrival. Claude Code
 * fires a `notification` hook whose payload is literally "Claude is waiting for your input";
 * NeonCore recorded it as working, and the agent then aged to `idle`. A cartridge waiting on
 * you looked exactly like one with nothing to do. That is why a CE decision step sat for
 * hours, and why the staleness sweep eventually declared a perfectly healthy agent dead.
 *
 * WHY THIS IS NOT `eventType === 'notification' → waiting`. The live table holds 719
 * notifications and they are NOT homogeneous:
 *
 *     "Claude is waiting for your input"                    ← blocked on a human
 *     "Claude needs your permission"                        ← blocked on a human
 *     "FAILED: backend-interlag went offline; ..."          ← an informational report
 *     "New confer queued at 02:05 will NOT run: ..."        ← an informational report
 *     "Confer c795879f FAILED at Draft 3/3 — ..."           ← an informational report
 *
 * Mapping the event TYPE would mark an agent as waiting every time it filed a status report,
 * which is worse than the bug: the queue treats `waiting` as busy, so every informational
 * notification would block that cartridge's lane. The classifier reads the PAYLOAD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFromActivity } from '../src/lib/activity-status.ts';

/**
 * THE SET: every event type the hooks actually emit (counted from the live activity table),
 * paired with the payloads that change the answer.
 */
const CASES: { label: string; event: string; payload?: string; want: 'working' | 'waiting' | null }[] = [
  // Work is happening.
  { label: 'a tool finished', event: 'PostToolUse', want: 'working' },
  { label: 'the user sent a prompt', event: 'user_prompt', want: 'working' },
  { label: 'the user ran a command', event: 'user_command', want: 'working' },
  { label: 'a turn ended', event: 'Stop', want: 'working' },
  { label: 'a subagent finished', event: 'SubagentStop', want: 'working' },

  // Blocked on a human — the whole point.
  {
    label: 'Claude Code says it is waiting for input',
    event: 'notification', payload: 'Claude is waiting for your input', want: 'waiting',
  },
  {
    label: 'Claude Code says it needs permission',
    event: 'notification', payload: 'Claude needs your permission', want: 'waiting',
  },
  { label: 'the agent asked a question', event: 'ask_user', want: 'waiting' },

  // Informational notifications must NOT mark the cartridge blocked. `waiting` counts as busy
  // for the queue, so mis-classifying these would halt lanes on a status report.
  {
    label: 'a failure report',
    event: 'notification', payload: 'FAILED: backend-interlag went offline; confer queue item failed', want: null,
  },
  {
    label: 'a queue-state report',
    event: 'notification', payload: 'New confer queued at 02:05 will NOT run: the repo lane is halted', want: null,
  },
  {
    label: 'a confer outcome report',
    event: 'notification', payload: 'Confer c795879f FAILED at Draft 3/3 — baseback never reported', want: null,
  },
];

test('EVERY activity signal maps to the right availability', () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const got = statusFromActivity(c.event, c.payload);
    if (got !== c.want) wrong.push(`${c.label} (${c.event}): expected ${c.want}, got ${got}`);
  }
  assert.deepEqual(wrong, [],
    `these signals are classified wrongly:\n  ${wrong.join('\n  ')}`);
});

test('an unknown event type does not silently change availability', () => {
  // New hooks appear. Defaulting them to `working` would resurrect the original bug for
  // whatever the next blocked-on-a-human signal turns out to be.
  assert.equal(statusFromActivity('SomeFutureHook'), null);
  assert.equal(statusFromActivity(''), null);
});

test('the blocked match is on MEANING, not on the word "waiting" appearing anywhere', () => {
  // A report that merely mentions waiting is still a report. Matching loosely would make every
  // status update about a queue halt block the cartridge that sent it.
  assert.equal(
    statusFromActivity('notification', 'Confer is waiting on baseback to report — not blocked here'),
    null,
  );
});

test('case and surrounding text do not defeat the match', () => {
  // The hook text has varied in casing and has been seen with a prefix.
  assert.equal(statusFromActivity('notification', 'CLAUDE IS WAITING FOR YOUR INPUT'), 'waiting');
  assert.equal(statusFromActivity('notification', '[gridlight] Claude is waiting for your input'), 'waiting');
});
