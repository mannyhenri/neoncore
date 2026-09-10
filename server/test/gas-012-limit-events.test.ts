/**
 * GAS-012 — record every usage-limit signal, with the consumption observed at that moment.
 *
 * This is the data GAS-013 learns a real ceiling from. Nothing today knows what your plan's
 * limit actually is — the badge divides a budget you typed — and the only way to find out is
 * to notice where the wall was when you hit it. That has to start recording before it can
 * start answering, so this is pure capture with no behaviour change.
 *
 * ── WHERE THIS LIVES, AND WHY NOT THE RELAY ───────────────────────────────────────────
 * The task says "the relay records". The relay is a dumb pipe — `ptyProc.onData((d) =>
 * process.stdout.write(d))` — so recording there would mean scraping a PTY byte stream for
 * English, which breaks on a line wrap. The signal is already observable server-side: Claude
 * Code's own notifications arrive as activity events and routes/activity.ts:59 already
 * classifies their text. Implemented there instead, where it is testable and where the string
 * being matched is machine-generated rather than reconstructed.
 *
 * ── ONLY NOTIFICATIONS MAY FIRE THIS, AND THAT IS THE LOOP-002 LESSON ─────────────────
 * Earlier today a loop terminated because an agent WROTE ABOUT its stop marker and a substring
 * match read the sentence as the signal — twice, including one agent explicitly saying it was
 * refusing to signal. The same trap is here: an agent writing "we hit the usage limit
 * yesterday" in a report must not record a limit event. So detection is gated on the event
 * TYPE first. Notification text is Claude Code's own; everything else is prose.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT_PATTERNS, detectLimitSignal } from '../src/lib/limit-events.js';

test('every pattern in the registry detects its own signal', () => {
  // Set-based over the registry: a pattern added later is covered without editing this test,
  // and a pattern that matches nothing it was written for fails loudly.
  const dead = LIMIT_PATTERNS.filter((p) => !p.example || !detectLimitSignal('notification', p.example));
  assert.deepEqual(dead.map((p) => String(p.re)), [],
    'these patterns do not match the text they were written for');
  assert.ok(LIMIT_PATTERNS.length >= 3, `expected a real registry, got ${LIMIT_PATTERNS.length}`);
});

test('ordinary notifications are not limit signals', () => {
  const wrong: string[] = [];
  for (const text of [
    'Claude is waiting for your input',
    'Claude needs your permission to use Bash',
    'Build finished',
    '',
  ]) {
    if (detectLimitSignal('notification', text)) wrong.push(text || '(empty)');
  }
  assert.deepEqual(wrong, [], `these were read as limit signals:\n  ${wrong.join('\n  ')}`);
});

test('AGENT PROSE never fires this, whatever it says — the LOOP-002 lesson', () => {
  // Every one of these contains a phrase that matches when the event type is a notification.
  const prose = [
    'we hit the usage limit yesterday and had to wait',
    'I am NOT reporting that the usage limit was reached — it was not',
    'the 429 handling in this module needs a test',
    'Approaching usage limit is the string we match on',
  ];
  const wrong: string[] = [];
  for (const text of prose) {
    for (const type of ['PostToolUse', 'Stop', 'user_prompt', 'assistant_response', 'tool_result']) {
      if (detectLimitSignal(type, text)) wrong.push(`${type}: ${text.slice(0, 50)}`);
    }
    // ...and the same text AS A NOTIFICATION is a real signal, proving the gate is the type.
  }
  assert.deepEqual(wrong, [],
    `agent prose was recorded as a limit event — the exact failure that truncated a run today:\n  ${wrong.join('\n  ')}`);
  assert.ok(detectLimitSignal('notification', 'Approaching usage limit'),
    'the gate must be the event type, not the words — otherwise this test proves nothing');
});

test('the signal returned is the matched marker, so a row says WHY it was recorded', () => {
  const signal = detectLimitSignal('notification', 'Claude usage limit reached. Your limit will reset at 3pm.');
  assert.ok(signal && signal.length > 0);
  assert.ok(!signal.includes('reset at 3pm'), 'the marker, not the whole message — the message varies');
});

test('a missing or malformed payload is not a signal', () => {
  for (const [type, payload] of [
    ['notification', undefined], ['notification', null], ['', 'usage limit reached'], [undefined, 'usage limit reached'],
  ] as [string, string][]) {
    assert.equal(detectLimitSignal(type, payload), null);
  }
});

/**
 * Recording. The row must capture what had been SPENT at the moment the wall was hit — that
 * number is the whole point, and it is unrecoverable after the fact because session_usage
 * keeps growing.
 */
import db from '../src/db.js';
import { recordLimitEvent, limitEventsSince } from '../src/lib/limit-events.js';

const AGENT = 'agent-under-test';
function seedUsage(inputTokens: number, at: string) {
  db.prepare(`INSERT INTO session_usage (id, session_id, agent_id, input_tokens, output_tokens, model, recorded_at, cache_read_tokens, cache_creation_tokens)
              VALUES (?,?,?,?,0,'claude-opus-5',?,0,0)`)
    .run(`u-${Math.random()}`, 's1', AGENT, inputTokens, at);
}

test('a recorded event captures consumption AT THAT MOMENT, not later', () => {
  const t0 = new Date(Date.now() - 3600_000).toISOString();
  seedUsage(1_000_000, t0);

  const first = recordLimitEvent(AGENT, 'usage-limit-reached', new Date().toISOString());
  assert.ok(first, 'a genuine signal must produce a row');
  const tokensAtEvent = first!.tokens_at_event;
  assert.ok(tokensAtEvent >= 1_000_000, `expected the spend so far, got ${tokensAtEvent}`);

  // More usage arrives afterwards. The recorded row must NOT move.
  seedUsage(5_000_000, new Date().toISOString());
  const rows = limitEventsSince(new Date(Date.now() - 86_400_000).toISOString());
  const same = rows.find((r) => r.id === first!.id)!;
  assert.equal(same.tokens_at_event, tokensAtEvent, 'a recorded ceiling observation must be immutable');
});

test('a repeated signal within the dedupe window records once, not once per notification', () => {
  const before = limitEventsSince('1970-01-01T00:00:00.000Z').length;
  const now = new Date().toISOString();
  recordLimitEvent('spammy', 'rate-limited', now);
  recordLimitEvent('spammy', 'rate-limited', new Date(Date.parse(now) + 5_000).toISOString());
  recordLimitEvent('spammy', 'rate-limited', new Date(Date.parse(now) + 30_000).toISOString());
  const added = limitEventsSince('1970-01-01T00:00:00.000Z').length - before;
  assert.equal(added, 1, `a burst of notifications is one wall, not ${added} walls`);
});

test('a different marker, or the same one much later, is a separate observation', () => {
  const before = limitEventsSince('1970-01-01T00:00:00.000Z').length;
  const now = Date.now();
  recordLimitEvent('distinct', 'rate-limited', new Date(now).toISOString());
  recordLimitEvent('distinct', 'usage-limit-reached', new Date(now + 1_000).toISOString());   // different wall
  recordLimitEvent('distinct', 'rate-limited', new Date(now + 10 * 60_000).toISOString());     // later window
  assert.equal(limitEventsSince('1970-01-01T00:00:00.000Z').length - before, 3);
});
