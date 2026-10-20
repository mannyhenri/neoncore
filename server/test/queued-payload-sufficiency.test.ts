/**
 * A queued item must carry everything its dispatcher needs — later, with nobody watching.
 *
 * Found in production, not by review: queueing a confer against a busy cartridge stored the raw
 * request body, but the route resolves `repoName`/`repoPath` from the participant rows FURTHER
 * DOWN, after the point where the queue check ran. So the item enqueued fine, looked correct in
 * the UI, and then failed three times on dispatch with
 *
 *     NOT NULL constraint failed: confer_sessions.repo_name
 *
 * and halted the lane. Dispatch happens minutes or hours after enqueue, so an argument the
 * route computed but did not store is simply gone by then.
 *
 * The general rule this pins: WHAT YOU ENQUEUE MUST EQUAL WHAT YOU WOULD HAVE DISPATCHED. Not
 * the request that asked for it — the resolved arguments. Tested per kind so a new kind must
 * declare the same thing.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

/**
 * For each kind: the fields its dispatcher reads out of the stored payload, and the route that
 * enqueues it. Derived from queue-kinds.ts rather than restated — if a dispatcher starts
 * needing another field, this list is where the omission becomes visible.
 */
const KINDS = [
  {
    kind: 'confer',
    route: 'routes/confer.ts',
    // startConfer({ repoName, repoPath, participantIds, task, ... }) — repoName and repoPath are
    // NOT NULL columns, and they are resolved from the participant rows, not sent by the client.
    // buildRounds decides how many milestones the session HAS; dropping it on the queue path
    // silently downgrades a queued 6-round bug sweep to a single build pass.
    required: ['repoName', 'repoPath', 'participantIds', 'task', 'buildRounds'],
  },
  {
    kind: 'workflow',
    route: 'routes/workflows.ts',
    required: ['workflowId'],
  },
  {
    kind: 'task',
    route: 'routes/tasks.ts',
    // dispatchTaskToAgent(task, agentId) — the row is looked up again at dispatch, so the id is
    // enough, but the CARTRIDGE must be stored: it was chosen (or auto-selected) by the route,
    // and re-deriving it later could pick a different agent than the user aimed at.
    required: ['taskId', 'agentId'],
  },
  {
    kind: 'prompt',
    route: 'routes/commands.ts',
    // sendCommandToAgent(agentId, text, includeMemory, attachments) — a picture attached to a
    // prompt for a busy cartridge used to be dropped right here: the item stored `text` only.
    required: ['text', 'attachments', 'includeMemory'],
  },
];

test('the kind list matches the registry — no kind escapes this check', () => {
  const registry = read('lib/queue-kinds.ts');
  const ids = [...registry.matchAll(/KIND_IDS = \[([^\]]+)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
  assert.deepEqual(ids.sort(), KINDS.map((k) => k.kind).sort(),
    'a kind exists that this test does not cover, so its payload sufficiency is unverified');
});

for (const k of KINDS) {
  test(`${k.kind}: the enqueue site stores every field its dispatcher reads`, () => {
    const src = read(k.route);

    // The payload literal passed to enqueue({ kind: '<k>' ... }) in that route.
    const at = src.indexOf(`kind: '${k.kind}'`);
    assert.notEqual(at, -1, `${k.route} never enqueues a '${k.kind}' item`);
    const payloadAt = src.indexOf('payload:', at);
    assert.notEqual(payloadAt, -1, `${k.kind} enqueue has no payload`);
    // Read to the end of the enqueue call — enough to see the whole literal.
    const window = src.slice(payloadAt, payloadAt + 400);

    const missing = k.required.filter((f) => !window.includes(f));
    assert.deepEqual(
      missing, [],
      `${k.route} queues a ${k.kind} without: ${missing.join(', ')}\n` +
      `Dispatch happens later, so anything the route computed and did not store is gone. ` +
      `This is the "NOT NULL constraint failed: confer_sessions.repo_name" failure.`,
    );
  });
}

test('the confer queue check runs AFTER participants are resolved', () => {
  // Position matters, not just content: repoName/repoPath come from the participant rows, so a
  // check placed above that resolution cannot store them however carefully it is written.
  const src = read('routes/confer.ts');
  // Anchor on the participant lookup itself, not on whatever the local holding it is called
  // this month — the invariant is about ORDER, and a rename must not fake a pass or a fail.
  const resolved = src.indexOf('FROM agents WHERE id IN');
  const queued = src.indexOf("kind: 'confer'");
  assert.notEqual(resolved, -1);
  assert.notEqual(queued, -1);
  assert.ok(
    queued > resolved,
    'the busy check enqueues before participant repos are resolved — the payload cannot contain them',
  );
});
