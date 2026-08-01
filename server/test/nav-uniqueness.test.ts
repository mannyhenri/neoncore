/**
 * No two navigation entries may carry the same label.
 *
 * The queue tab shipped as a copy-paste of the Tasks button: same text, same count badge,
 * never relabelled. The result was a top bar reading "Agents | Goals | Tasks | Tasks", and it
 * passed every guard we had — route-has-caller proved the panel was wired, route-contract
 * proved the client and server agreed, and both were true. Neither looks at what the button
 * SAYS, so a user-facing duplicate was invisible to a stack of tests specifically built to
 * catch dead and mismatched UI.
 *
 * This is the altitude below the contract: not "is it connected" but "can a person tell what
 * it is". Set-based over the rendered labels rather than an assertion about the two we know
 * about, so the next copy-pasted button fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Labels of the top-level view buttons — the ones bound to setActiveView. Scoped to that
 * handler rather than every <button> in the file, so unrelated controls do not create noise.
 */
function navLabels(): string[] {
  const src = read('dashboard/src/App.tsx');
  const labels: string[] = [];
  const re = /setActiveView\('(\w+)'\)[\s\S]{0,400}?>\s*\n?\s*([A-Z][A-Za-z ]{1,20})\s*\n/g;
  // NOT `re.exec(src) ? src.matchAll(re) : []` — exec() on a /g regex advances lastIndex, so
  // matchAll would then start past the first button and silently drop it. That is what the
  // vacuity guard below caught when the nav shrank from three labels to two.
  for (const m of src.matchAll(re)) labels.push(m[2].trim());
  return labels;
}

test('the nav scan finds the real buttons — an empty scan would pass vacuously', () => {
  assert.ok(navLabels().length >= 3,
    `expected several top-level nav buttons, found ${navLabels().length}: ${navLabels().join(', ')}`);
});

test('every top-level nav label is UNIQUE', () => {
  const labels = navLabels();
  const seen = new Map<string, number>();
  for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([l, n]) => `${l} x${n}`);
  assert.deepEqual(
    dupes, [],
    `two nav entries carry the same label, so a user cannot tell them apart: ${dupes.join(', ')}\n` +
    `Full nav: ${labels.join(' | ')}`,
  );
});

test('the queue is reachable from the Tasks view rather than a second tab', () => {
  // The user asked for ONE place that holds everything a cartridge will work through. A
  // separate tab splits "what is running" from "what is next", which is the same information.
  // The panel now mounts INSIDE TasksPage rather than App.tsx — one surface, not a panel
  // stacked above a list. Reachability is asserted where it actually lives.
  const src = read('dashboard/src/components/TasksPage.tsx');
  assert.match(src, /<QueuePanel/, 'TasksPage no longer renders the queue at all');
  assert.doesNotMatch(
    src, /setActiveView\('queue'\)/,
    'a separate top-level queue tab still exists — the queue belongs inside Tasks',
  );
});
