/**
 * The main screen shows every session that is running OR waiting to run.
 *
 * Active confers and workflow runs already sat under Active Runs. Then queueing arrived: a
 * confer started against busy cartridges no longer becomes `running` immediately — it sits as
 * a queued item until those cartridges free up. Correct behaviour, invisible consequence. You
 * start a confer, the main screen shows nothing, and the only trace is a row in another view.
 *
 * "It should show on the main screen like it was before" is right, and the fix is not to undo
 * queueing — it is to show the waiting ones next to the running ones, because to the person who
 * just started it they are the same thing: work they asked for that has not finished.
 *
 * Set-based over the kinds that PRODUCE A SESSION. `prompt` is deliberately excluded: it is not
 * a session, it has no milestones or steps to show, and it already appears in the task list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PANEL = read('dashboard/src/components/WorkflowPanel.tsx');

/** Queue kinds that become a visible session, and what the panel already calls the live one. */
const SESSION_KINDS = [
  { kind: 'confer', live: 'activeConfers' },
  { kind: 'workflow', live: 'activeRuns' },
];

test('the kinds listed here really are the session-producing kinds', () => {
  // Guards against this list drifting from the registry: if a new kind starts producing a
  // session, it must be added or explicitly judged not to be one.
  const registry = read('server/src/lib/queue-kinds.ts');
  const ids = [...registry.matchAll(/KIND_IDS = \[([^\]]+)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
  const unaccounted = ids.filter((i) => i !== 'prompt' && !SESSION_KINDS.some((s) => s.kind === i));
  assert.deepEqual(unaccounted, [],
    `these kinds produce sessions but are not shown on the main screen: ${unaccounted.join(', ')}`);
});

test('the main screen reads the queue at all', () => {
  assert.match(
    PANEL, /getQueue/,
    'WorkflowPanel never fetches the queue, so a confer or workflow waiting on a busy ' +
    'cartridge cannot appear on the main screen',
  );
});

for (const s of SESSION_KINDS) {
  test(`a QUEUED ${s.kind} is visible on the main screen, not only a running one`, () => {
    // The live list already exists; the assertion is that the waiting ones are surfaced too.
    assert.match(PANEL, new RegExp(s.live), `${s.live} is gone — running ${s.kind}s stopped showing`);
    assert.match(
      PANEL, new RegExp(`queued${s.kind[0].toUpperCase()}${s.kind.slice(1)}s`),
      `WorkflowPanel has no queued${s.kind[0].toUpperCase()}${s.kind.slice(1)}s — a ${s.kind} ` +
      `waiting on a busy cartridge is invisible until it starts`,
    );
  });
}

test('a queued PROMPT is not promoted to the main screen', () => {
  // The other half of the boundary. A prompt is not a session; putting every queued prompt on
  // the main screen would turn Active Runs back into the task list we just stopped duplicating.
  assert.doesNotMatch(
    PANEL, /queuedPrompts/,
    'prompts belong in the task list, not under Active Runs — that duplication is what the ' +
    'single-list change removed',
  );
});
