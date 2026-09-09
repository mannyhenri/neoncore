/**
 * LOOP-002 — the loop's stop marker must be a deliberate signal, not any mention of it.
 *
 * `shouldStopLooping` matched the configured `loopUntil` as a case-insensitive SUBSTRING of
 * the entire result body. Every corpus case below is a real result from this database, and
 * two of them are why this had to change:
 *
 *     "I am not outputting <marker>, because one task genuinely remains"
 *     "I have not emitted <marker>, because it would be false — two tasks genuinely remain"
 *
 * Both agents said in plain words that they were REFUSING to signal, and the substring match
 * read each refusal as the signal and ended the run. A third quoted its own instructions
 * ("output exactly `<marker>` with a one-line tally"), and a fourth — the run that produced
 * this task — used the phrase while explaining this very bug. Eight of twenty-seven dispatched
 * loops matched the marker inside prose; two were demonstrably truncated by it.
 *
 * ── THE RULE, AND WHY IT IS "BEGINS A LINE" AND NOT "IS THE WHOLE LINE" ───────────────
 * The template says to "output exactly <marker> with a one-line tally", and agents really do
 * write `<marker> — 17 of 22 done`. Requiring the line to equal the marker exactly would
 * reject those genuine signals and the loop would never stop early. So: the marker must BEGIN
 * its own trimmed line. Anything before it on the line is prose, and prose is not a signal.
 *
 * The deliberate cost, recorded rather than hidden: a result ending `DONE X · 0 remaining —
 * <marker>.` no longer stops the loop, because the marker does not lead the line. That spends
 * ONE extra dispatch, which then finds nothing to do and signals properly. Wasting a dispatch
 * is recoverable; ending a run nine tasks early is not, and that asymmetry picks the rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStopLooping, type LoopConfig } from '../src/lib/workflow-loop.js';

const MARKER = 'ALL TASKS COMPLETE';
const CFG: LoopConfig = { loopUntil: MARKER };

/** Real results from this database. `stop` is what the engine SHOULD have concluded. */
const CORPUS: { stop: boolean; why: string; text: string }[] = [
  { stop: true,  why: 'the bare signal, on its own line', text: MARKER },
  { stop: true,  why: 'signal with a tally on the same line', text: `${MARKER} — 17 of 22 done; the remaining 5 are blocked` },
  { stop: true,  why: 'signal followed by explanation', text: `${MARKER}. This dispatch fired after I reported 0 remaining` },
  { stop: true,  why: 'signal with a count', text: `${MARKER} — 0 remaining. Epic GRD-3902 is 6/6 done.` },
  { stop: true,  why: 'signal after other report lines', text: `DONE X · commit abc123 · 0 remaining\n\n${MARKER}\nTally: 9/9` },
  { stop: true,  why: 'leading whitespace is still its own line', text: `report\n   ${MARKER}   \nmore` },
  { stop: true,  why: 'casing is not the signal', text: `all tasks complete` },

  { stop: false, why: 'AN EXPLICIT REFUSAL TO SIGNAL — the case that broke real runs',
    text: `I am not outputting ${MARKER}, because one task genuinely remains and that would be false.` },
  { stop: false, why: 'a second refusal, phrased differently',
    text: `I have not emitted ${MARKER}, because it would be false — two tasks genuinely remain.` },
  { stop: false, why: 'quoting the instruction back',
    text: `- If none remain, output exactly \`${MARKER}\` with a one-line tally and STOP.` },
  { stop: false, why: 'discussing the mechanism while fixing it',
    text: `a naive count would read 1 remaining and suppress the ${MARKER} marker, spending a dispatch on nothing` },
  { stop: false, why: 'trailing claim mid-line — the documented cost of this rule',
    text: `DONE ADX-008 · commit de0c204 · 0 remaining — ${MARKER}.` },
  { stop: false, why: 'the phrase inside a longer sentence',
    text: `Nothing here says ${MARKER} in a way that should end anything.` },
];

test('the marker stops the loop only when it begins a line', () => {
  const wrong: string[] = [];
  for (const c of CORPUS) {
    const got = shouldStopLooping(c.text, CFG);
    if (got !== c.stop) {
      wrong.push(`expected stop=${c.stop} got=${got} — ${c.why}\n      ${JSON.stringify(c.text.slice(0, 90))}`);
    }
  }
  assert.deepEqual(wrong, [],
    `the loop would terminate on the wrong signal:\n  ${wrong.join('\n  ')}`);
});

test('no configured marker never stops, whatever the result says', () => {
  for (const cfg of [{}, { loopUntil: '' }, { loopUntil: '   ' }] as LoopConfig[]) {
    assert.equal(shouldStopLooping(`${MARKER}\nanything`, cfg), false);
  }
});

test('an empty or missing result never stops', () => {
  for (const r of ['', '   ', '\n\n', undefined as unknown as string]) {
    assert.equal(shouldStopLooping(r, CFG), false);
  }
});

/** Non-vacuity: the OLD substring rule must fail this corpus, or the fix changed nothing. */
test('the previous substring rule would fail this corpus', () => {
  const substringRule = (result: string) => (result || '').toLowerCase().includes(MARKER.toLowerCase());
  const disagreements = CORPUS.filter((c) => substringRule(c.text) !== c.stop);
  assert.ok(disagreements.length >= 5,
    `expected the old rule to be wrong on several real cases, it was wrong on ${disagreements.length}`);
});
