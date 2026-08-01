/**
 * Mobile does everything to ONE ROW that the web does. Lane administration stays at the desk.
 *
 * The two surfaces drifted quietly: the web gained per-row Clear and mobile did not, so a
 * finished row could be tidied at a desk and not on a phone — with nothing failing anywhere to
 * say so. Same class as mobile still declaring six engines a day after the removal: a copy
 * nobody updates.
 *
 * The line is per-ITEM versus per-LANE. Acting on a row you are looking at is exactly what a
 * phone is for; pausing a lane, forcing a tick, or enqueuing new work is desk work, and those
 * are exempt WITH REASONS rather than quietly missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CLIENT = read('packages/client/src/client.ts');
const MOBILE = read('mobile/src/api.ts') + read('mobile/src/screens/QueueScreen.tsx');

/** Queue client functions the phone deliberately does NOT have, each with the reason. */
const DESK_ONLY: Record<string, string> = {
  pauseQueueLane: 'lane administration — a phone acts on the row in front of you, not the lane',
  resumeQueueLane: 'lane administration; resuming is a considered act after reading why it halted',
  tickQueue: 'forcing a drain is a debugging control, not something to fat-finger on a phone',
  enqueueItem: 'nothing enqueues from a UI any more — work starts by prompting, confering or running a workflow',
};

/** Every queue function the shared client exposes. */
function queueFunctions(): string[] {
  return [...CLIENT.matchAll(/^\s{2}(\w*[Qq]ueue\w*):/gm)].map((m) => m[1]);
}

test('the scan finds the queue surface — an empty list would pass vacuously', () => {
  assert.ok(queueFunctions().length >= 5,
    `expected several queue client functions, found ${queueFunctions().length}`);
});

test('EVERY per-item queue action the web has, mobile has too', () => {
  const missing = queueFunctions()
    .filter((fn) => !(fn in DESK_ONLY))
    .filter((fn) => !MOBILE.includes(fn));
  assert.deepEqual(
    missing, [],
    `mobile cannot do these to a row it is showing: ${missing.join(', ')}\n` +
    `Either wire them into mobile/src, or add them to DESK_ONLY with a reason.`,
  );
});

test('every desk-only exemption names a function that still exists', () => {
  // Stops the exemption list rotting into names nothing recognises, which would silently widen
  // the hole it documents.
  const fns = queueFunctions();
  const stale = Object.keys(DESK_ONLY).filter((f) => !fns.includes(f));
  assert.deepEqual(stale, [], `these exemptions name functions the client no longer exposes: ${stale.join(', ')}`);
});

test('mobile carries no DEAD queue wrapper it never calls', () => {
  // enqueueItem lingered in mobile/src/api.ts after the enqueue form was deleted — a wrapper
  // with no caller, which is the exact defect the route guards were built for.
  const api = read('mobile/src/api.ts');
  const screen = read('mobile/src/screens/QueueScreen.tsx');
  const declared = [...api.matchAll(/^\s{2}(\w*[Qq]ueue\w*):/gm)].map((m) => m[1]);
  const orphans = declared.filter((fn) => !screen.includes(fn));
  assert.deepEqual(orphans, [], `mobile/src/api.ts exposes queue functions no screen calls: ${orphans.join(', ')}`);
});
