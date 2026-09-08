/**
 * EVERY SURFACE THAT SHOWS A QUEUED ITEM MUST SHOW WHAT IT IS.
 *
 * REPORTED, after the first fix shipped: "are you sure it's working I just refreshed the app and
 * still see the IDs on the task page."
 *
 * They did. The queue panel was fixed and the TASKS page was not, because there are two queue-row
 * renderers on the dashboard and two more on the phone, and the first pass found them by grepping
 * for `.slice(0, 8)`. That is the FORMATTING of a truncated id, not the rendering of an identity —
 * so the sites that printed a uuid IN FULL were invisible to the search that was supposed to be
 * exhaustive:
 *
 *   TasksPage.tsx        (item.payload?.workflowId as string)      ← a whole uuid, in the title
 *   WorkflowPanel.tsx    (q.payload?.workflowId as string)         ← same
 *   QueueScreen.tsx      item.id.slice(0, 8)
 *   taskView.ts          `${q.kind} ${q.id.slice(0, 8)}`
 *
 * The lesson is the shape of the SET, not the four misses: a set enumerated by how a defect looks
 * on screen will always miss the instances that look different. So this derives the set from what
 * the code DOES — every client file that renders a queue item — and asserts each one asks the
 * server what the item is.
 *
 * ── WHY THE SERVER IS THE AUTHORITY ───────────────────────────────────────────────────
 * `description` is derived per read from the kind's own describer, the same function behind
 * `[queue] started …`. Four clients each building a title from `payload` is four chances to
 * disagree with the log and with each other, which is exactly what happened.
 *
 * ── FALLBACKS ARE ALLOWED; ID FALLBACKS ARE NOT ───────────────────────────────────────
 * A federated dashboard can be pointed at an older server that never sends `description`, so a
 * fallback to the payload's human text is legitimate. Falling back to an id is not: a uuid is not
 * a degraded label, it is an unreadable one, and the reported bug WAS the fallback firing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');

/** Client source roots. Both apps, because the phone had two of the four misses. */
const APPS = ['dashboard/src', 'mobile/src'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Files that RENDER a queue item, derived rather than listed: a file that knows the QueueItem
 * type and reaches into an item's `payload` or its `id` is building a label out of one. Pure
 * plumbing — the api client, the ordering helper — touches neither and is correctly out of scope.
 */
function labelSites(): { file: string; src: string }[] {
  const found: { file: string; src: string }[] = [];
  for (const app of APPS) {
    for (const file of walk(path.join(ROOT, app))) {
      const src = strip(fs.readFileSync(file, 'utf8'));
      if (!/\bQueueItem\b/.test(src)) continue;
      if (!/\bpayload[?.]|\bitem\.id\.slice|\bq\.id\.slice|\bi\.id\.slice/.test(src)) continue;
      found.push({ file: path.relative(ROOT, file), src });
    }
  }
  return found;
}

test('the scan finds the surfaces it is meant to police', () => {
  // A walker that silently returned [] would make every assertion below vacuous — and this test
  // exists BECAUSE an exhaustive-looking search quietly missed four files.
  const sites = labelSites().map((s) => s.file);
  assert.ok(sites.length >= 4, `only ${sites.length} queue-label sites found: ${sites.join(', ')}`);
  for (const expect of [
    'dashboard/src/components/QueuePanel.tsx',
    'dashboard/src/components/TasksPage.tsx',
    'dashboard/src/components/WorkflowPanel.tsx',
    'mobile/src/screens/QueueScreen.tsx',
  ]) {
    assert.ok(sites.includes(expect), `the scan does not reach ${expect}`);
  }
});

test('EVERY surface that labels a queue item asks the server what it is', () => {
  const silent = labelSites()
    .filter((s) => !/\bdescription\b/.test(s.src))
    .map((s) => `${s.file} builds a queue item's label without reading \`description\``);
  assert.deepEqual(silent, [], `\n  ${silent.join('\n  ')}\n`);
});

test('no surface falls back to an id — a uuid is not a degraded label', () => {
  // The reported bug was precisely a fallback firing: `payload.workflowId` is a template/run id,
  // so a `workflow` item rendered its whole uuid as the title of the row.
  const bad: string[] = [];
  for (const { file, src } of labelSites()) {
    for (const [pattern, what] of [
      [/payload[?.]*\.?\s*\.?workflowId/, 'payload.workflowId — a raw run/template id'],
      [/payload[?.]*\.?\s*\.?taskId/, 'payload.taskId — a raw task id'],
      [/\b(?:item|q|i)\.id\.slice\(/, 'the queue row id, truncated'],
    ] as [RegExp, string][]) {
      if (pattern.test(src)) bad.push(`${file} still labels with ${what}`);
    }
  }
  assert.deepEqual(bad, [], `\n  ${bad.join('\n  ')}\n`);
});
