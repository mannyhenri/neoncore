/**
 * PHASE 3 — SHORTER TEMPLATE PROMPTS MAY CHANGE THEIR WORDS, NEVER THEIR OUTPUT CONTRACT.
 *
 * Template prompts are being tightened, most-dispatched first. What a later step, the loop
 * engine or a person reads out of a step's result is its output markers: `TASKS: n` drives the
 * epic loop count, `[k] remaining` extends it, `ALL TASKS COMPLETE` ends it, `SWITCHED to …` and
 * `WAITING ON …` are how a reorder is visible. Past runs used every one of them. Losing one in a
 * rewrite is a silent behaviour change that no length check would notice.
 *
 * fixtures/template-output-markers.json was extracted from the seeded templates BEFORE any
 * tightening (every backtick-quoted marker and every `LABEL:` line of a fenced output block).
 * SET-BASED: every marker of every step must survive, unless RETIRED below says why it went.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db.ts';

const FIXTURE: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/template-output-markers.json'), 'utf8'));

/** template / step / marker → why it was dropped on purpose. Empty is the expected state. */
const RETIRED: Record<string, string> = {};

function promptOf(template: string, step: string): string | undefined {
  const row = db.prepare(
    `SELECT s.executor_config cfg FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
      WHERE w.template_id IS NULL AND w.name = ? AND s.name = ?`,
  ).get(template, step) as { cfg: string } | undefined;
  if (!row) return undefined;
  const cfg = JSON.parse(row.cfg || '{}');
  return String(cfg.prompt || cfg.customPrompt || '');
}

test('the fixture covers the templates it was taken from', () => {
  const steps = Object.values(FIXTURE).reduce((n, t) => n + Object.keys(t).length, 0);
  assert.ok(steps >= 30, `expected the frozen marker set, found ${steps} steps`);
});

test('EVERY output marker of EVERY template step survives tightening', () => {
  const lost: string[] = [];
  for (const [template, steps] of Object.entries(FIXTURE)) {
    for (const [step, markers] of Object.entries(steps)) {
      const prompt = promptOf(template, step);
      if (prompt === undefined) { lost.push(`${template} / ${step}: the step is gone`); continue; }
      for (const m of markers) {
        const key = `${template} / ${step} / ${m}`;
        if (!prompt.includes(m) && !RETIRED[key]) lost.push(key);
      }
    }
  }
  assert.deepEqual(lost, [], `markers dropped without a reason in RETIRED:\n  ${lost.join('\n  ')}`);
});

// ── The ratchet ───────────────────────────────────────────────────────────────────────────
// fixtures/template-prompt-sizes.json holds every template step's prompt length after
// tightening. A prompt may shrink freely; growing one means editing that file in the same diff,
// which is the point — it makes the growth a decision a reviewer sees.
const SIZES: Record<string, Record<string, number>> = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/template-prompt-sizes.json'), 'utf8'));

test('NO template step prompt grew past its recorded size', () => {
  const grew: string[] = [];
  let checked = 0;
  for (const [template, steps] of Object.entries(SIZES)) {
    for (const [step, max] of Object.entries(steps)) {
      const prompt = promptOf(template, step);
      if (prompt === undefined) continue; // a removed step is not growth
      checked++;
      if (prompt.length > max) grew.push(`${template} / ${step}: ${prompt.length} > ${max}`);
    }
  }
  assert.ok(checked >= 150, `expected the recorded set, checked ${checked}`);
  assert.deepEqual(grew, [], `update fixtures/template-prompt-sizes.json on purpose if this is intended:\n  ${grew.join('\n  ')}`);
});

test('the tightened, most-dispatched prompts stay well under their old size', () => {
  // Old sizes, from before Phase 3. These five carried most of the template text actually sent.
  const OLD: [string, string, number][] = [
    ['Epic: Task by Task', 'Work Every Task', 5196],
    ['Epic: Task by Task', 'Load Epic', 1126],
    ['Epic: Task by Task', 'Verify Coverage', 1379],
    ['Confer', 'Confer & Build', 1028],
    ['Deep Research', 'Create in Jira?', 2591],
  ];
  const notCut = OLD.filter(([t, s, old]) => (promptOf(t, s) ?? '').length > old * 0.8)
    .map(([t, s, old]) => `${t} / ${s}: ${promptOf(t, s)?.length} vs ${old}`);
  assert.deepEqual(notCut, []);
});
