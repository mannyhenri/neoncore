import { describe, it, expect } from 'vitest';
import { pickFocusStep } from '../lib/currentStep';

/**
 * Opening the canvas must land you on the step that matters, not on the whole graph.
 *
 * CE: Full Delivery is 47 steps and roughly 6800px tall. `fitView` on mount zooms out far
 * enough to fit all of it, so every open began with scrolling to find where the run actually
 * is. There was already a centring effect, but it was gated on `isExecuting` AND on the
 * running step CHANGING — so it did nothing for a paused, failed, finished, or not-yet-started
 * run, and on mount it raced with fitView.
 *
 * "The step that matters" is not always the running one, which is why this is a set rather
 * than `steps.find(running)`: a run that stopped needs the step that stopped it, and a run
 * that has not started needs the one about to go.
 */

let n = 0;
type S = { id: string; name: string; status: string; recoveryStatus?: string };
const step = (status: string, over: Partial<S> = {}): S => {
  n += 1;
  return { id: `s${n}`, name: `step ${n}`, status, ...over };
};

describe('which step the canvas opens on', () => {
  it('prefers the RUNNING step — the live edge of the work', () => {
    const done = step('completed');
    const live = step('running');
    const next = step('pending');
    expect(pickFocusStep([done, live, next])?.id).toBe(live.id);
  });

  it('prefers a step that NEEDS ATTENTION over one merely running', () => {
    // A failed or interrupted step is why you opened the canvas. A run can hold both when a
    // parallel branch broke while another kept going.
    const broken = step('failed');
    const live = step('running');
    expect(pickFocusStep([live, broken])?.id).toBe(broken.id);

    const interrupted = step('running', { recoveryStatus: 'interrupted' });
    const healthy = step('running');
    expect(pickFocusStep([healthy, interrupted])?.id).toBe(interrupted.id);
  });

  it('falls to the NEXT pending step when nothing is running', () => {
    // A queued or paused run — you want to see what is about to go, not step 1 of 47.
    const a = step('completed');
    const b = step('completed');
    const c = step('pending');
    const d = step('pending');
    expect(pickFocusStep([a, b, c, d])?.id).toBe(c.id);
  });

  it('falls to the LAST completed step for a finished run', () => {
    // Nothing is pending and nothing is running: the interesting end is where it stopped.
    const a = step('completed');
    const b = step('completed');
    expect(pickFocusStep([a, b])?.id).toBe(b.id);
  });

  it('ignores skipped steps when choosing what is next', () => {
    // A skipped step is explicitly not where the work is.
    const done = step('completed');
    const skipped = step('skipped');
    const pending = step('pending');
    expect(pickFocusStep([done, skipped, pending])?.id).toBe(pending.id);
  });

  it('returns null for an empty or brand-new template so the caller can fit the whole view', () => {
    // A template you are editing has no run state; fitting everything is the right default,
    // and inventing a focus target would fight the author.
    expect(pickFocusStep([])).toBeNull();
    expect(pickFocusStep([step('pending'), step('pending')])?.id).toBe('s' + (n - 1));
  });

  it('is stable — the same steps always resolve to the same target', () => {
    // The canvas re-renders on every poll. A focus target that moved between identical
    // renders would drag the viewport around under the cursor.
    const steps = [step('completed'), step('running'), step('pending')];
    expect(pickFocusStep(steps)?.id).toBe(pickFocusStep(steps)?.id);
  });
});
