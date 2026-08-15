import { describe, it, expect } from 'vitest';
import {
  UNASSIGNED,
  parseGoalHash,
  goalHash,
  resolveSelection,
} from '../lib/goalSelection';

/**
 * WHICH GOAL IS THE WORKSPACE SHOWING?
 *
 * Master–detail introduces a failure mode the old accordion could not have: the detail
 * pane is driven by an id that can stop existing. Delete the selected goal, follow a
 * stale link from a notification, or load `#goal/unassigned` on a day when every project
 * has a goal — each leaves the 2/3 working surface blank while the rail beside it is
 * full. A blank pane reads as "loading" or "broken", not as "that goal is gone".
 *
 * So selection is resolved, never trusted. `resolveSelection` takes what was REQUESTED
 * and returns what can actually be SHOWN, and the tests below are written against that
 * distinction rather than against the happy path.
 *
 * Set-based over the cases rather than one test per example: the bug this guards is a
 * partial fix — handling the deleted-goal case but not the stale-unassigned one — which
 * looks correct in review and leaves half the blank panes in place.
 */

describe('goal selection is addressable', () => {
  // Round-trip over a set that includes the pseudo-selection and an id needing encoding,
  // because ids come from the server and the hash is a URL.
  const IDS = ['g-1', UNASSIGNED, 'goal_abc123', '01J8Z9-QWE', 'a b/c'];

  it.each(IDS)('%s survives a round trip through the URL hash', (id) => {
    expect(parseGoalHash(goalHash(id))).toBe(id);
  });

  // Everything that is NOT a goal link must read as "nothing requested" rather than as a
  // goal whose id happens to be empty — the latter resolves to a blank pane.
  const NOT_GOAL_LINKS = ['', '#', '#agents', '#tasks', '#goal', '#goal/', '#goals/g-1'];

  it.each(NOT_GOAL_LINKS)('%j is not a goal link', (hash) => {
    expect(parseGoalHash(hash)).toBeNull();
  });
});

describe('selection resolves to something showable', () => {
  const GOALS = ['g-1', 'g-2', 'g-3'];

  it('an explicit, existing request wins', () => {
    expect(resolveSelection({ goalIds: GOALS, hasUnassigned: false, requested: 'g-2' })).toBe('g-2');
  });

  it('defaults to the first goal so the workspace is never blank on arrival', () => {
    expect(resolveSelection({ goalIds: GOALS, hasUnassigned: false, requested: null })).toBe('g-1');
  });

  /**
   * THE LOAD-BEARING CASE. Every one of these requests names something that does not
   * exist, and every one of them previously produced an empty 2/3 pane beside a
   * populated rail.
   */
  const STALE: { label: string; requested: string; goalIds: string[]; hasUnassigned: boolean }[] = [
    {
      label: 'a goal deleted in this session',
      requested: 'g-deleted', goalIds: GOALS, hasUnassigned: false,
    },
    {
      label: 'a stale deep link from an old notification',
      requested: 'g-from-last-week', goalIds: GOALS, hasUnassigned: false,
    },
    {
      label: 'unassigned, on a day when every project has a goal',
      requested: UNASSIGNED, goalIds: GOALS, hasUnassigned: false,
    },
  ];

  it.each(STALE)('$label falls back to a real goal, not a blank pane', (c) => {
    const got = resolveSelection(c);
    expect(c.goalIds).toContain(got);
  });

  it('unassigned is selectable exactly when unassigned projects exist', () => {
    expect(resolveSelection({ goalIds: GOALS, hasUnassigned: true, requested: UNASSIGNED })).toBe(UNASSIGNED);
    expect(resolveSelection({ goalIds: GOALS, hasUnassigned: false, requested: UNASSIGNED })).not.toBe(UNASSIGNED);
  });

  it('with no goals at all, unassigned projects are still reachable', () => {
    // Otherwise the projects exist, the rail lists them, and nothing can open them.
    expect(resolveSelection({ goalIds: [], hasUnassigned: true, requested: null })).toBe(UNASSIGNED);
  });

  it('a genuinely empty workspace resolves to null, not to a fabricated id', () => {
    expect(resolveSelection({ goalIds: [], hasUnassigned: false, requested: null })).toBeNull();
    expect(resolveSelection({ goalIds: [], hasUnassigned: false, requested: 'g-1' })).toBeNull();
  });
});
