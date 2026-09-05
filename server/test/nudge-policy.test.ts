import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTONOMY_LEVELS, NUDGE_POLICY, nudgeAllowed } from '../src/lib/autonomy.ts';

/**
 * How hard each level tries to un-stick a cartridge that went quiet.
 *
 * ASKED FOR: "when I use the full autonomy option a check or cron should validate that the
 * cartridge isn't stuck or idled or waiting, and nudge it automatically. I want full
 * unsupervised autonomy if I select this."
 *
 * The first version nudged ONCE at every level, on the reasoning that a stall surviving a nudge
 * is a person's problem. That is right for `advance`, whose promise is only that it decides
 * nothing — and wrong for `full`, whose entire promise is that nobody has to be watching. A
 * level that gives up after one attempt and waits for you is not unsupervised.
 *
 * SET-BASED over AUTONOMY_LEVELS x attempts-so-far, because the two failure directions are
 * opposite and both silent: too few and the run sits all night, too many and a cartridge that
 * cannot answer is hammered every sweep forever.
 */

test('every level declares a nudge policy — a level with none would default to silence', () => {
  const missing = AUTONOMY_LEVELS.filter((l) => NUDGE_POLICY[l] === undefined);
  assert.deepEqual(missing, [], `levels with no nudge policy: ${missing.join(', ')}`);
});

test('manual never nudges, advance tries once, full keeps trying', () => {
  assert.equal(NUDGE_POLICY.manual.maxAttempts, 0, 'manual acted on its own');
  assert.equal(NUDGE_POLICY.advance.maxAttempts, 1, 'advance should try once, then ask a person');
  assert.ok(NUDGE_POLICY.full.maxAttempts >= 5,
    `full gives up after ${NUDGE_POLICY.full.maxAttempts} — that is not unsupervised`);
  assert.ok(Number.isFinite(NUDGE_POLICY.full.maxAttempts),
    'an unbounded nudge loop hammers a cartridge that cannot answer');
});

/** THE SET: level x how many nudges already sent x how long since the last one. */
const CASES: { label: string; level: string; sent: number; agoMin: number; want: boolean }[] = [
  { label: 'manual, never nudged', level: 'manual', sent: 0, agoMin: 999, want: false },
  { label: 'advance, first nudge', level: 'advance', sent: 0, agoMin: 999, want: true },
  { label: 'advance, already tried once', level: 'advance', sent: 1, agoMin: 999, want: false },
  { label: 'full, first nudge', level: 'full', sent: 0, agoMin: 999, want: true },
  { label: 'full, second nudge after the cooldown', level: 'full', sent: 1, agoMin: 999, want: true },
  { label: 'full, fifth nudge after the cooldown', level: 'full', sent: 4, agoMin: 999, want: true },
  // Spacing: without it the sweep fires every 60s and a silent cartridge is hammered.
  { label: 'full, second nudge too soon', level: 'full', sent: 1, agoMin: 1, want: false },
  { label: 'full, past its ceiling', level: 'full', sent: 99, agoMin: 999, want: false },
];

test('a nudge is allowed only when the level permits it AND enough time has passed', () => {
  const failures: string[] = [];
  for (const c of CASES) {
    const lastAt = c.agoMin >= 999 ? null : new Date(Date.now() - c.agoMin * 60_000).toISOString();
    const got = nudgeAllowed(c.level as never, c.sent, lastAt);
    if (got !== c.want) failures.push(`${c.label}: got ${got}, expected ${c.want}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('the nudge counter is NOT recovery_attempts', async () => {
  /*
   * `redispatchOrphanedSteps` re-sends a step whose cartridge RESTARTED, and allows itself
   * exactly one attempt gated on `recovery_attempts < 1`. The first nudge implementation
   * incremented that same column, so nudging a stalled step silently spent the orphan guard's
   * only budget — two mechanisms with different jobs sharing one counter, where the cheaper one
   * disables the safety net. Seen live: the epic run's work step sat at recovery_attempts 1
   * having never been orphaned.
   */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'lib', 'attention-notifier.ts'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  assert.ok(!/recovery_attempts/.test(src),
    'attention-notifier touches recovery_attempts — that column belongs to the orphan guard, '
    + 'and sharing it means a nudge disables crash recovery for that step');
});
