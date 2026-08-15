import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The canvas must LAND on the focus step, not merely compute it.
 *
 * `pickFocusStep` is unit-tested and correct — and the canvas still opened showing all 47
 * steps. Choosing the right target is not the same as arriving there, and the whole failure
 * lived in the wiring:
 *
 *   1. `<ReactFlow fitView>` owns the initial viewport and applies it when the flow
 *      initialises. The focus effect ran earlier, on the `nodes` state change, so `setCenter`
 *      was applied to a viewport that had not been measured yet — a no-op — and then fitView
 *      zoomed out over the whole graph. The later effect lost to the earlier prop.
 *   2. React Flow cannot centre on a node before it has dimensions. `useNodesInitialized`
 *      is the signal that measurement is done; without gating on it, the first centre attempt
 *      is silently discarded.
 *
 * WHY THIS IS A SOURCE CONTRACT AND NOT A RENDER TEST. React Flow measures nodes with
 * ResizeObserver against real layout; under jsdom nodes never initialise, so a render test
 * would assert on a canvas that is permanently un-measured — it could not distinguish this bug
 * from correct code. The properties below are the ones that were actually violated, so they
 * are asserted directly.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../components/WorkflowCanvasEditor.tsx'), 'utf8');

/** The <ReactFlow ...> element's own props. */
const flowProps = (() => {
  const i = SRC.indexOf('<ReactFlow');
  return SRC.slice(i, SRC.indexOf('>', SRC.indexOf('snapGrid', i)));
})();

const RULES: { name: string; check: () => string | null }[] = [
  {
    name: 'nothing unconditionally claims the initial viewport',
    check: () => (/^\s*fitView\s*$/m.test(flowProps)
      ? 'the bare `fitView` prop still owns the opening viewport and overrides the focus centre'
      : null),
  },
  {
    name: 'the viewport waits until nodes have been measured',
    check: () => (SRC.includes('useNodesInitialized')
      ? null
      : 'nothing gates on node measurement, so the first setCenter is applied to an unmeasured viewport and discarded'),
  },
  {
    name: 'a focus step is centred, not fitted',
    check: () => (/setCenter\(/.test(SRC)
      ? null
      : 'the canvas never calls setCenter, so it cannot land on a specific step'),
  },
  {
    name: 'with no focus step it still falls back to fitting the whole graph',
    check: () => (/fitView\(/.test(SRC)
      ? null
      : 'a template being authored has no focus target and would be left at an arbitrary viewport'),
  },
  {
    name: 'a LATER focus change animates, so the move is visible',
    check: () => (/duration:\s*(first\s*\?\s*0\s*:\s*)?[1-9]/.test(SRC)
      ? null
      : 'focus changes jump instantly, so nothing signals that the run advanced'),
  },
];

describe('canvas focus wiring', () => {
  it('the rule set is non-empty', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(RULES)('$name', ({ check }) => {
    expect(check()).toBeNull();
  });

  it('the focus effect reads the picker rather than re-deriving "running"', () => {
    // The old effect hunted for `status === 'running'` inline, which is why it did nothing for
    // paused, failed and finished runs. The priority logic lives in one tested place.
    expect(SRC).toMatch(/pickFocusStep\(/);
    const effect = SRC.slice(SRC.indexOf('pickFocusStep('), SRC.indexOf('pickFocusStep(') + 900);
    expect(effect, 'the effect still re-implements its own running-step search')
      .not.toMatch(/steps\.find\(\(s\)\s*=>\s*s\.status === 'running'\)/);
  });
});
