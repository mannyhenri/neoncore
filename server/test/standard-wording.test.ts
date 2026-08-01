/**
 * The completion block must not tell an agent to do two opposite things.
 *
 * The injected standard said "end your final message with this block, verbatim:" and then gave
 * a block containing `<done>/<total>`, `<what the set was>`, `<exact command run>` — fields the
 * agent is supposed to REPLACE. Copy it verbatim and you emit placeholders; fill it in and you
 * have not copied it verbatim. Nothing broke, because agents resolved the contradiction
 * sensibly, but it is the text every dispatched task carries and a reader asking "what do we
 * mean by that" is reading it correctly.
 *
 * Set-based over the placeholders actually present, so adding a field to the block cannot
 * reintroduce the contradiction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORK_STANDARD_SHORT, COMPLETION_MARKER } from '../src/lib/work-standard.ts';

/** `<...>` fields the agent must replace with real values. */
function placeholders(): string[] {
  return [...WORK_STANDARD_SHORT.matchAll(/<[^>\n]+>/g)].map((m) => m[0]);
}

test('the block still HAS placeholders — otherwise this test guards nothing', () => {
  assert.ok(placeholders().length >= 3,
    `expected the completion block to carry fill-in fields, found ${placeholders().length}`);
});

test('no placeholder is introduced by an instruction to copy verbatim', () => {
  // The contradiction, stated as a rule: "verbatim" and "<placeholder>" cannot both apply to
  // the same thing. The marker LINE is genuinely verbatim; the fields under it are not.
  const saysVerbatim = /verbatim/i.test(WORK_STANDARD_SHORT);
  if (!saysVerbatim) return; // reworded away entirely — also fine

  const line = WORK_STANDARD_SHORT.split('\n').find((l) => /verbatim/i.test(l)) ?? '';
  assert.match(
    line, new RegExp(COMPLETION_MARKER),
    `"verbatim" must refer to the ${COMPLETION_MARKER} marker line specifically, not to a block ` +
    `whose fields are placeholders the agent has to replace. Current line: "${line.trim()}"`,
  );
});

test('the agent is told to FILL the fields, not reproduce them', () => {
  assert.match(
    WORK_STANDARD_SHORT, /fill|replac|substitut/i,
    'the block gives placeholders but never says to fill them in — the only instruction ' +
    'attached to it was "verbatim", which says the opposite',
  );
});

test('the marker itself is still exact, because the parser matches on it', () => {
  // parseCompletionBlock keys on this line. Softening it into a description would break every
  // completion report silently — the gate would stop recognising a correct report.
  assert.ok(WORK_STANDARD_SHORT.includes(COMPLETION_MARKER),
    `the standard no longer contains the ${COMPLETION_MARKER} marker the parser looks for`);
});
