/**
 * You add work the way you always did. The queue is for WATCHING it.
 *
 * The queue shipped with its own enqueue form — a kind dropdown, a text box, a target picker
 * and a "Queue it" button — which meant two different ways to start the same work, and the new
 * one lived in the wrong place. Prompting a cartridge, starting a confer and starting a
 * workflow are the ways you begin work; if the cartridge is busy the server queues it (see
 * queue-if-busy.test.ts). Nothing about that needs a second form.
 *
 * The task list had the same problem from the other direction: a "+ New task" button creating
 * a kind of work nothing else in the product creates any more.
 *
 * So this asserts, over every monitoring surface, that it offers NO way to create work and
 * still offers every way to act on work already there. Both halves matter — deleting the
 * create affordance is easy, and deleting the controls that make the queue safe to leave
 * running (cancel, pause, the halt reason) alongside it would be the obvious over-correction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

interface Surface {
  file: string;
  label: string;
  /** Markers that would mean "you can create work here". */
  forbidden: { pattern: RegExp; what: string }[];
  /** Markers that must survive, so the cut does not take the monitoring with it. */
  required: { pattern: RegExp; what: string }[];
}

const SURFACES: Surface[] = [
  {
    file: 'dashboard/src/components/QueuePanel.tsx',
    label: 'web queue panel',
    forbidden: [
      // `>Queue it<` — rendered button TEXT, not prose. A bare /Queue it/ also matched the
      // phrase "Queue items" in this file's own doc comment, which is the same too-loose
      // matching that made `cursor` report 25 false hits during the engine removal.
      { pattern: />\s*Queue it\s*</, what: 'an enqueue button' },
      { pattern: /<input/, what: 'a free-text prompt input' },
      { pattern: /<select/, what: 'a kind or target picker' },
    ],
    required: [
      { pattern: /cancelQueueItem/, what: 'cancel an item' },
      { pattern: /pauseQueueLane/, what: 'pause a lane' },
      { pattern: /resumeQueueLane/, what: 'resume a lane' },
      { pattern: /haltedReason/, what: 'show WHY a lane stopped' },
    ],
  },
  {
    file: 'dashboard/src/components/TasksPage.tsx',
    label: 'web task list',
    forbidden: [
      { pattern: /\+ New task/, what: 'a New task button' },
      { pattern: /Create first task/, what: 'a create-first-task button' },
    ],
    required: [
      { pattern: /cancelTask/, what: 'cancel a task' },
    ],
  },
  {
    file: 'mobile/src/screens/QueueScreen.tsx',
    label: 'mobile queue screen',
    forbidden: [
      { pattern: />\s*Queue it\s*</, what: 'an enqueue button' },
      { pattern: /placeholder="prompt to queue/, what: 'a free-text prompt input' },
    ],
    required: [
      { pattern: /cancelQueueItem/, what: 'cancel an item' },
    ],
  },
];

test('the surface list is real — every file exists', () => {
  // A typo in a path would make every assertion below read a missing file and pass on nothing.
  const missing = SURFACES.filter((s) => !fs.existsSync(path.join(ROOT, s.file))).map((s) => s.file);
  assert.deepEqual(missing, [], `these surfaces do not exist: ${missing.join(', ')}`);
});

for (const s of SURFACES) {
  test(`${s.label}: offers NO way to create work`, () => {
    const src = read(s.file);
    const found = s.forbidden.filter((f) => f.pattern.test(src)).map((f) => f.what);
    assert.deepEqual(
      found, [],
      `${s.file} still lets a user create work here: ${found.join(', ')}\n` +
      `Work is started by prompting a cartridge, or starting a confer or workflow. If the ` +
      `cartridge is busy the server queues it. A second way to add the same thing is the ` +
      `duplication the user asked us to remove.`,
    );
  });

  test(`${s.label}: still lets a user ACT on work already there`, () => {
    const src = read(s.file);
    const lost = s.required.filter((r) => !r.pattern.test(src)).map((r) => r.what);
    assert.deepEqual(
      lost, [],
      `${s.file} can no longer: ${lost.join(', ')}\n` +
      `Removing the create form must not remove the controls that make an unattended queue ` +
      `safe — a queue you cannot stop or inspect is worse than one you cannot add to.`,
    );
  });
}

test('queue items and tasks are ONE list, not two panels stacked', () => {
  // The user's words: adding work "adds them to the tasks list". A queue panel sitting above a
  // task list is still two lists on one screen — the same complaint in a smaller box.
  const app = read('dashboard/src/App.tsx');
  assert.doesNotMatch(
    app, /<QueuePanel[\s\S]{0,200}<TasksPage/,
    'the queue is rendered as a separate panel above the task list — it belongs INSIDE it',
  );
  const tasks = read('dashboard/src/components/TasksPage.tsx');
  assert.match(tasks, /QueuePanel|queueItems|QueueItem/,
    'TasksPage does not show queue items at all, so the queue is still a second list elsewhere');
});
