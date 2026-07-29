import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTrailingQuestion } from '../src/lib/trailing-question.ts';

/**
 * Detecting that a turn ended by asking the human something.
 *
 * Only `AskUserQuestion` ever marked a cartridge as waiting, so an agent that simply ended
 * its message with "which approach do you prefer?" asked into the void: nothing reached the
 * phone, and the reply was later misread as a brand-new task.
 *
 * Both halves below are set-based. A detector that fires on everything is as useless as one
 * that fires on nothing, so the non-questions are tested as hard as the questions.
 */

// Endings that ARE the agent asking, and must reach the UI.
const QUESTIONS = [
  'Want me to build it, and with which strictness?',
  'Should I use the registry approach or keep the old field?',
  "I've fixed the copy bug.\n\nWant me to update the docs too?",
  'Which of these three should I prioritise?',
  '**Should I proceed with the migration?**',
  'Done. Ready for me to push?   ',
  'One question before I continue: do you want the strict version?',
];

// Endings that are NOT a question to the human. A false positive parks a cartridge in
// `waiting` on your grid when nothing is actually blocked.
const NOT_QUESTIONS = [
  'Fixed all twelve sections and pushed.',
  'Why does this matter? Because a partial fix passes an example-based test.',
  'The build is green.\n\nNEONCORE-DONE\nscope: 3/3 — all call sites\nverify: npm test → 3 passed\ndeferred: none',
  'Here is the check:\n\n```bash\ngrep -c "foo" bar.txt # how many?\n```',
  'See the diff above.',
  '',
  '   \n  \n ',
];

test('every question ending is detected', () => {
  const missed = QUESTIONS.filter((q) => !detectTrailingQuestion(q));
  assert.deepEqual(missed, [], `these questions never reached the UI: ${missed.map((m) => JSON.stringify(m.slice(-45))).join(', ')}`);
});

test('no non-question is mistaken for one', () => {
  const wrong = NOT_QUESTIONS.filter((t) => detectTrailingQuestion(t));
  assert.deepEqual(wrong, [], `these wrongly parked a cartridge in waiting: ${wrong.map((m) => JSON.stringify(m.slice(-45))).join(', ')}`);
});

test('a rhetorical question mid-message does not count — only the ending does', () => {
  const text = 'Why does this matter? Because it does.\n\nAll twelve sections now copy correctly.';
  assert.equal(detectTrailingQuestion(text), null);
});

test('a question inside a closed code fence is ignored', () => {
  const text = 'Run this:\n\n```\necho "done?"\n```';
  assert.equal(detectTrailingQuestion(text), null);
});

test('the returned text is the question itself, trimmed of markdown', () => {
  const q = detectTrailingQuestion('Work done.\n\n**Should I push this now?**');
  assert.equal(q, 'Should I push this now?');
});

test('an absurdly long trailing line is not treated as a question', () => {
  // A wall of prose that happens to end in "?" is not a question you can answer on a phone.
  const text = `${'x'.repeat(600)}?`;
  assert.equal(detectTrailingQuestion(text), null);
});

test('a completion report followed by a question still surfaces the question', () => {
  const text = 'NEONCORE-DONE\nscope: 1/1 — x\nverify: ran it → ok\ndeferred: none\n\nWant me to ship it?';
  assert.equal(detectTrailingQuestion(text), 'Want me to ship it?');
});

test('null and undefined are handled', () => {
  assert.equal(detectTrailingQuestion(undefined as never), null);
  assert.equal(detectTrailingQuestion(null as never), null);
});
