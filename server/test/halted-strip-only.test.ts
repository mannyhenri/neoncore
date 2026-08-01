/**
 * In haltedOnly mode the panel shows LANES, never items.
 *
 * The merge put queue items into the task list as cards. The panel was supposed to shrink to a
 * strip that names the halted lane and offers resume. It did not: `haltedOnly` only suppressed
 * the panel when NOTHING was halted, so the moment a lane actually halted the old item list
 * came back — and the user saw the same four items twice, once as unstyled rows with no retry
 * button and once as filtered cards. Exactly the duplication the merge removed, restored by
 * the one condition that was supposed to prevent it.
 *
 * Set-based over the panel's rendering branches rather than a single assertion, because the
 * failure was "one branch forgot", not "the feature is missing".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PANEL = fs.readFileSync(
  path.join(import.meta.dirname, '..', '..', 'dashboard/src/components/QueuePanel.tsx'), 'utf8');

/** Things that render an ITEM. None may run while haltedOnly is set. */
const ITEM_RENDERERS = [
  { pattern: /laneItems\.map/, what: 'the per-lane item rows' },
  { pattern: /Nothing queued/, what: 'the empty-items message' },
];

test('the panel really has a haltedOnly mode', () => {
  assert.match(PANEL, /haltedOnly/, 'haltedOnly is gone — the panel would render in full again');
});

for (const r of ITEM_RENDERERS) {
  test(`${r.what} is suppressed when haltedOnly is set`, () => {
    assert.match(PANEL, r.pattern, `${r.what} no longer exists — this guard would pass vacuously`);
    // The renderer must be guarded by !haltedOnly somewhere in the same expression.
    const at = PANEL.search(r.pattern);
    const window = PANEL.slice(Math.max(0, at - 400), at + 60);
    assert.match(
      window, /!haltedOnly/,
      `${r.what} renders even in haltedOnly mode, so a halted lane brings the whole item list ` +
      `back and every item appears twice — once here and once as a card in the task list`,
    );
  });
}

test('the lane strip itself SURVIVES — it is the only thing haltedOnly should show', () => {
  // The over-correction: suppressing items by suppressing the whole panel would hide the halt
  // reason and the resume button, which are the reason a person is looking at all.
  for (const [pattern, what] of [
    [/haltedReason/, 'the reason the lane stopped'],
    [/resumeQueueLane/, 'the resume control'],
  ] as [RegExp, string][]) {
    assert.match(PANEL, pattern, `${what} is gone — a halted lane would be unactionable`);
  }
});
