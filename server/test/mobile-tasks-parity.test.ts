/**
 * The phone manages a task the way the desk does, or says why not.
 *
 * REPORTED: "I don't always see tasks, and I can't really start them either."
 *
 * Two causes, both structural rather than cosmetic:
 *  - The desk's Tasks page renders TWO lists under one filter — real tasks, and queue items
 *    mapped onto the task vocabulary. Mobile called only `listTasks`, so a server holding
 *    zero tasks and a full queue read as "No tasks" on the phone and a page of work at the
 *    desk. Same class as mobile still declaring six engines a day after the removal: a copy
 *    nobody updates.
 *  - The phone offered `Send` for `queued` and nothing else. A task in any other status had
 *    no verb at all — not startable, not settleable, not clearable.
 *
 * The line here is AUTHORING versus ACTING. Describing work needs a keyboard and stays at the
 * desk; acting on a row you are looking at is exactly what a phone is for. Anything on the
 * desk side is exempt WITH A REASON rather than quietly missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CLIENT = read('packages/client/src/client.ts');
const MOBILE_API = read('mobile/src/api.ts');
const MOBILE_SCREEN = read('mobile/src/screens/TasksScreen.tsx');
const MOBILE_VIEW = read('mobile/src/taskView.ts');
const MOBILE = MOBILE_API + MOBILE_SCREEN + MOBILE_VIEW;

/** Task functions the phone deliberately does NOT have, each with the reason. */
const DESK_ONLY: Record<string, string> = {
  createTask: 'authoring — a task is a title plus a prompt, and that is keyboard work',
  updateTask: 'authoring — editing a task body on a phone is the same keyboard work',
};

/**
 * Same capability, different name. Mobile's api.ts predates the shared client and reads
 * `listTasks`; recording the alias keeps the check strict instead of loosening the match.
 */
const ALIASES: Record<string, string> = { getTasks: 'listTasks' };

/** Every task function the shared client exposes, excluding the epic-runner surface. */
function taskFunctions(): string[] {
  return [...CLIENT.matchAll(/^\s{2}(\w*[Tt]ask\w*):/gm)]
    .map((m) => m[1])
    .filter((n) => !/Epic|scanTasks/.test(n));
}

test('the scan finds the task surface — an empty list would pass vacuously', () => {
  const fns = taskFunctions();
  assert.ok(fns.length >= 5, `expected several task client functions, found ${fns.length}: ${fns}`);
});

test('EVERY task function is on the phone, or is desk-only with a reason', () => {
  const missing: string[] = [];
  for (const fn of taskFunctions()) {
    if (DESK_ONLY[fn]) continue;
    const name = ALIASES[fn] ?? fn;
    if (!MOBILE.includes(name)) missing.push(ALIASES[fn] ? `${fn} (as ${name})` : fn);
  }
  assert.deepEqual(missing, [],
    `mobile cannot do these, and no reason is recorded:\n  ${missing.join('\n  ')}`);
});

test('the desk-only list is honest — nothing exempted that mobile actually has', () => {
  const wrong = Object.keys(DESK_ONLY).filter((fn) => new RegExp(`\\b${fn}\\b`).test(MOBILE));
  assert.deepEqual(wrong, [],
    `listed as desk-only but present on mobile: ${wrong.join(', ')}`);
});

test('the phone reads the queue into its task view, like the desk does', () => {
  // The reported "No tasks" with a full queue. Without this the screen is honest about
  // /api/tasks and silent about half the work the server is holding.
  assert.ok(/getQueue/.test(MOBILE_SCREEN),
    'TasksScreen must read the queue as well as /api/tasks');
  assert.ok(/selectTaskRows/.test(MOBILE_SCREEN),
    'TasksScreen must render the merged rows, not tasks alone');
});

test('every task status is reachable by a filter on the phone', () => {
  // A status with no filter is a status you cannot look up. The desk omits `cancelled`
  // because "All" is one click away on a wide screen; a phone list is a scroll, not a glance.
  const STATUSES = ['queued', 'claimed', 'in_progress', 'done', 'failed', 'cancelled'];
  const missing = STATUSES.filter((st) => !new RegExp(`'${st}'`).test(MOBILE_VIEW));
  assert.deepEqual(missing, [],
    `no filter reaches: ${missing.join(', ')}`);
});
