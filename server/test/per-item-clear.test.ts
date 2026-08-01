/**
 * Every row carries its own controls: cancel it if it is live, clear it if it is finished.
 *
 * A bulk "clear finished" button is a different thing from being able to act on ONE row, and
 * it is the wrong shape here: it removes rows the user never looked at. Per item, the two
 * actions are exclusive — cancel stops work that is still going, clear removes a row that has
 * already stopped — so exactly one of them is offered on any given row, and neither can act on
 * a status it has no business touching.
 *
 * Set-based over the full QueueStatus enum: the interesting cases are the ones a hand-written
 * list gets wrong. `blocked` looks finished and is not; `running` looks clearable to anyone
 * thinking "just tidy the list".
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { removeItem, cancelItem, listQueue } from '../src/lib/queue-runner.ts';

installStubIO();
const ISO = new Date().toISOString();

/** Every queue status, and which single control a row in that state may offer. */
const STATUSES: { status: string; cancellable: boolean; clearable: boolean }[] = [
  { status: 'queued',    cancellable: true,  clearable: false },
  { status: 'running',   cancellable: true,  clearable: false },
  { status: 'blocked',   cancellable: false, clearable: false }, // needs a human, not tidying
  { status: 'done',      cancellable: false, clearable: true },
  { status: 'failed',    cancellable: false, clearable: true },
  { status: 'cancelled', cancellable: false, clearable: true },
];

function seed(id: string, status: string): string {
  db.prepare(`INSERT INTO queue_items (id, kind, payload_json, targets_json, lane, status, position, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, 'prompt', '{"text":"x"}', '[]', 'agent:a', status, 1, ISO);
  return id;
}

test('the status list matches the enum — nothing escapes classification', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/lib/queue-kinds.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('export type QueueStatus')) ?? '';
  const declared = [...line.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(declared, STATUSES.map((s) => s.status).sort());
});

test('clear removes ONLY finished rows, one at a time', () => {
  db.prepare('DELETE FROM queue_items').run();
  const wrong: string[] = [];
  for (const s of STATUSES) {
    const id = seed(`clear-${s.status}`, s.status);
    const removed = removeItem(id);
    const gone = !listQueue().some((i) => i.id === id);
    if (removed !== s.clearable || gone !== s.clearable) {
      wrong.push(`${s.status}: removeItem returned ${removed}, row ${gone ? 'gone' : 'present'}, expected clearable=${s.clearable}`);
    }
  }
  assert.deepEqual(wrong, [], `per-item clear touched the wrong rows:\n  ${wrong.join('\n  ')}`);
});

test('cancel stops ONLY live rows, and never deletes them', () => {
  db.prepare('DELETE FROM queue_items').run();
  const wrong: string[] = [];
  for (const s of STATUSES) {
    const id = seed(`cancel-${s.status}`, s.status);
    const ok = cancelItem(id);
    if (ok !== s.cancellable) wrong.push(`${s.status}: cancelItem returned ${ok}, expected ${s.cancellable}`);
    // Cancelling must leave a row behind — it is a record of work that was stopped, and the
    // user still needs to see it (and can then clear it deliberately).
    if (ok && !listQueue().some((i) => i.id === id)) wrong.push(`${s.status}: cancel DELETED the row instead of stopping it`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('the two controls are mutually exclusive on every status', () => {
  // If both ever apply, the row shows two buttons that do overlapping things and the user has
  // to guess which is safe.
  const both = STATUSES.filter((s) => s.cancellable && s.clearable).map((s) => s.status);
  assert.deepEqual(both, [], `these statuses offer both controls: ${both.join(', ')}`);
});

test('removing something that does not exist is false, not a crash', () => {
  assert.equal(removeItem('no-such-id'), false);
});
