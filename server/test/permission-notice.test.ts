import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPermissionParts, answerPayloadFor, parseQuestions, questionKey,
  MAX_LABEL, MAX_ACTION_ID, MAX_BUTTONS, PERM_PREFIX,
} from '../src/lib/permission-notice.ts';

/**
 * A notification you cannot act on is worse than the dashboard you were not at.
 *
 * REPORTED: Discord showed "gridlight — Question / AskUserQuestion" and nothing else. No question
 * text, no options, no buttons — while `tool_input` held all three. Mine: the notice shipped with
 * `actions: []` and a comment deferring buttons to a phase that covered something else.
 *
 * SET-BASED over the PAYLOAD SHAPES a real request arrives in, because the ones that matter are
 * the ones that cannot become buttons — multi-question, multi-select, free-text, unparseable —
 * and each must say where to go instead. A dead end is the bug being fixed, restored quietly.
 */

const PERM = 'e0a1f2c3-4d5e-6789-abcd-ef0123456789';   // a real uuid's length

/** A live AskUserQuestion payload, trimmed from the database. */
const REAL = JSON.stringify({
  questions: [{
    question: "Should the report's look become the default for all generated documents, or opt-in per document?",
    header: 'Styling',
    options: [
      { label: 'Make it the default (Recommended)', description: 'Dark table headers, zebra striping…' },
      { label: 'Opt-in via a flag', description: 'Documents keep the current look unless asked.' },
    ],
  }],
});

/** THE SET: every shape a request arrives in, and what a channel must do with it. */
const SHAPES: { label: string; tool: string; input: unknown; buttons: number | 'some'; dashboard: boolean }[] = [
  { label: 'a real single question with two options', tool: 'AskUserQuestion', input: REAL, buttons: 2, dashboard: false },
  { label: 'options given as bare strings', tool: 'AskUserQuestion', input: { question: 'Pick', options: ['A', 'B', 'C'] }, buttons: 3, dashboard: false },
  { label: 'a question at the top level, not in an array', tool: 'AskUserQuestion', input: { question: 'Go?', options: [{ label: 'Yes' }] }, buttons: 1, dashboard: false },

  // Cannot be answered with one tap — must say so rather than offering a partial answer.
  { label: 'two questions is a form', tool: 'AskUserQuestion', input: { questions: [{ question: 'A', options: [{ label: 'x' }] }, { question: 'B', options: [{ label: 'y' }] }] }, buttons: 0, dashboard: true },
  { label: 'multiSelect', tool: 'AskUserQuestion', input: { question: 'Which?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }, buttons: 0, dashboard: true },
  { label: 'free text, no options', tool: 'AskUserQuestion', input: { question: 'Describe it' }, buttons: 0, dashboard: true },

  // Broken payloads must not throw and must not pretend.
  { label: 'unparseable JSON', tool: 'AskUserQuestion', input: 'not json at all', buttons: 0, dashboard: true },
  { label: 'empty object', tool: 'AskUserQuestion', input: {}, buttons: 0, dashboard: true },
  { label: 'null', tool: 'AskUserQuestion', input: null, buttons: 0, dashboard: true },

  // The yes/no family.
  { label: 'a plan awaiting review', tool: 'ExitPlanMode', input: {}, buttons: 2, dashboard: false },
  { label: 'an ordinary tool approval', tool: 'Bash', input: { command: 'rm -rf build' }, buttons: 2, dashboard: false },
];

test('the shape table is real — an empty scan would pass vacuously', () => {
  assert.ok(SHAPES.length >= 10, `expected a full shape table, got ${SHAPES.length}`);
});

test('every payload shape yields either buttons or a stated way to answer — never a dead end', () => {
  const failures: string[] = [];

  for (const s of SHAPES) {
    let parts;
    try {
      parts = buildPermissionParts(PERM, s.tool, s.input, 'the description field');
    } catch (err) {
      failures.push(`${s.label}: threw — ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const n = parts.actions.length;
    if (s.buttons === 'some' ? n === 0 : n !== s.buttons) {
      failures.push(`${s.label}: ${n} buttons, expected ${s.buttons}`);
    }
    if (parts.needsDashboard !== s.dashboard) {
      failures.push(`${s.label}: needsDashboard=${parts.needsDashboard}, expected ${s.dashboard}`);
    }
    // The dead-end guard: no buttons must always come with an explanation.
    if (n === 0 && Object.keys(parts.detail).length === 0) {
      failures.push(`${s.label}: no buttons AND no detail — the reader is told nothing`);
    }
    // The question itself must always be visible when there is one.
    if (s.tool === 'AskUserQuestion' && !parts.detail.Question) {
      failures.push(`${s.label}: no Question line — this is the reported bug`);
    }
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('every button fits what a channel will accept', () => {
  const failures: string[] = [];
  for (const s of SHAPES) {
    for (const a of buildPermissionParts(PERM, s.tool, s.input, 'x').actions) {
      if (a.id.length > MAX_ACTION_ID) failures.push(`${s.label}: id ${a.id.length} chars`);
      if (a.label.length > MAX_LABEL) failures.push(`${s.label}: label ${a.label.length} chars`);
      if (!a.label.trim()) failures.push(`${s.label}: a button with no label`);
    }
  }
  // A pathological payload must be capped, not rendered.
  const many = { question: 'Pick', options: Array.from({ length: 40 }, (_, i) => ({ label: `option ${i}` })) };
  const parts = buildPermissionParts(PERM, 'AskUserQuestion', many, '');
  if (parts.actions.length > MAX_BUTTONS) failures.push(`40 options produced ${parts.actions.length} buttons`);
  if (!parts.detail.Note) failures.push('40 options: the reader is not told the list was truncated');

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

/**
 * THE CONTRACT WITH THE AGENT.
 *
 * The dashboard posts `{ answers: { [key]: label } }` with the key derived id → text → index
 * (CartridgeCard.tsx). The hook reads that. A channel inventing its own shape consumes the
 * request and hands the agent gibberish, which is worse than having offered no button.
 */
test('the answer payload is byte-identical to what the dashboard posts', () => {
  const payload = answerPayloadFor(REAL, 0);
  const q = parseQuestions(REAL)[0];

  assert.deepEqual(payload, { answers: { [questionKey(q, 0)]: 'Make it the default (Recommended)' } });
  assert.deepEqual(answerPayloadFor(REAL, 1), { answers: { [questionKey(q, 0)]: 'Opt-in via a flag' } });
});

test('the key derivation matches the dashboard, including its fallbacks', () => {
  assert.equal(questionKey({ id: 'q1', question: 'text', options: [], multiSelect: false }, 3), 'q1');
  assert.equal(questionKey({ question: 'text', options: [], multiSelect: false }, 3), 'text');
  assert.equal(questionKey({ id: '  ', question: 'text', options: [], multiSelect: false }, 3), 'text');
});

test('a stale button files nothing rather than an empty answer', () => {
  // Buttons outlive their message. An index that no longer names an option must produce no
  // decision at all — filing `{ answers: { q: undefined } }` would answer the question wrongly
  // and consume the request.
  assert.equal(answerPayloadFor(REAL, 9), null);
  assert.equal(answerPayloadFor(REAL, -1), null);
  assert.equal(answerPayloadFor('not json', 0), null);
  assert.equal(answerPayloadFor({ questions: [{ question: 'a', options: [{ label: 'x' }] }, { question: 'b' }] }, 0), null);
});

test('the dashboard is still the only other implementation of this parse', () => {
  // If a THIRD copy appears, these three drift and the channel starts answering under a key the
  // hook does not read. Named here so the next author sees the pair rather than discovering it.
  const dash = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'dashboard', 'src', 'components', 'CartridgeCard.tsx'), 'utf8',
  );
  assert.match(dash, /answers:\s*\{/, 'the dashboard no longer posts an `answers` object — this parser must follow it');
});
