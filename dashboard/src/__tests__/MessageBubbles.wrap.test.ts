import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * TEXT MUST NOT ESCAPE THE BOX THAT IS SUPPOSED TO CONTAIN IT.
 *
 * Reported on the Launch flow: a green message painted OUTSIDE its green background. Not a
 * colour bug — `max-w-xs` caps the BOX, the background is painted on the box, and a token too
 * wide to wrap overflows the content area and hangs out of its own bubble.
 *
 * MEASURED rather than assumed, and the trigger turned out narrower than the first diagnosis:
 *
 *   Launching claude in neoncore on Emmanuels-MacBook-Pro.local…          0px  (hyphens break)
 *   Scanning /Users/emmanuelhenri/Documents/Git on <host>…                0px  (breaks after /)
 *   Scanning /Users/…/Git/neoncore/server/node_modules on <host>…        91px  OVERFLOWS
 *   <raw API error carrying an unbroken absolute path>                  243px  OVERFLOWS
 *
 * So the messages that break it are the long path and the raw API error — which is exactly why
 * a fix aimed at the one message someone happened to notice is worthless.
 *
 * ── WHY THIS IS SET-BASED OVER A DERIVED REGISTRY ──────────────────────────────────────
 * Fixing the one bubble that was reported is the classic half-fix: every other capped box that
 * renders a path, a hostname, a repo name or an API error has the identical defect and simply
 * has not been looked at yet. So the registry is not hand-written — it is SCANNED out of the
 * component sources, which means a bubble added next month is in the set automatically and
 * fails here until it declares how it handles a long token.
 *
 * Passing requires an explicit decision, not a specific one: wrap it (`break-words`/`break-all`)
 * or clip it (`truncate`). Both are fine. Neither is not.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = resolve(HERE, '../components');

/** Any of these means the author decided what happens to a token wider than the box. */
const HANDLED = /break-words|break-all|truncate|overflow-hidden|whitespace-normal|line-clamp-\d/;

interface Bubble {
  file: string;
  className: string;
  /** The dynamic expression the element renders, for the failure message. */
  renders: string;
}

/**
 * Elements that cap their width AND render a dynamic value directly as their content.
 *
 * The `>{` shape is the discriminator: it means the element's own child is an interpolation
 * (text from state, props or an API), not nested markup. A capped element wrapping other
 * COMPONENTS is a layout container — its children manage themselves — and is out of scope.
 */
function findBubbles(): Bubble[] {
  const found: Bubble[] = [];
  for (const file of readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(resolve(COMPONENTS, file), 'utf8');
    // className={`…`} or className="…" containing a width cap, then the element's content.
    const re = /className=(?:\{`|")([^"`]*max-w-(?:xs|sm|md)[^"`]*)(?:`\}|")([\s\S]{0,400}?)>/g;
    for (const m of src.matchAll(re)) {
      const className = m[1];
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 120);
      // Immediate child is an interpolation → this box renders text it did not author.
      const child = after.match(/^\s*\{([^}]{1,60})/);
      if (!child) continue;
      const expr = child[1].trim();
      // Not content: JSX comments, whitespace literals, and `.map(...)` — a list renders
      // ELEMENTS, which manage their own overflow, so flagging its container is a false alarm.
      // A test that cries wolf on layout containers is a test people learn to skip.
      if (expr.startsWith('/*') || /^['"]/.test(expr) || /</.test(expr) || /\.map\(/.test(expr)) continue;
      found.push({ file, className, renders: expr });
    }
  }
  return found;
}

describe('capped-width elements that render dynamic text', () => {
  const bubbles = findBubbles();

  it('the scan finds real bubbles — an empty registry would pass every assertion on nothing', () => {
    // The failure this guards is a regex that silently stops matching after a refactor, which
    // would turn this whole file green while checking nothing at all.
    expect(bubbles.length).toBeGreaterThan(0);
  });

  it('EVERY one declares what happens to a token wider than the box', () => {
    const unhandled = bubbles
      .filter((b) => !HANDLED.test(b.className))
      .map((b) => `${b.file} — renders {${b.renders}}`);
    expect(
      unhandled,
      'these cap their width but never say how to handle an unbreakable token (a hostname, an ' +
      'absolute path, an API error), so the text paints outside its own background:\n  ' +
      unhandled.join('\n  '),
    ).toEqual([]);
  });

  /**
   * The specific one that was reported, pinned by BEHAVIOUR rather than by class name.
   *
   * The generic sweep above would still pass if the launch notice were deleted, so this asserts
   * the bubble exists, still carries a background, and still handles overflow — the three
   * properties that together mean "the message stays inside the green".
   */
  it('the Launch notice keeps its message inside its background', () => {
    const src = readFileSync(resolve(COMPONENTS, 'MachineLauncher.tsx'), 'utf8');
    const at = src.indexOf('{notice && (');
    expect(at, 'the launch notice is gone').toBeGreaterThan(-1);
    const el = src.slice(at, at + 700);
    expect(el, 'the notice no longer has a background to overflow').toMatch(/bg-emerald|bg-red/);
    expect(el, 'the notice caps its width but not its text').toMatch(HANDLED);
  });

  it('the messages it renders really do contain unbreakable tokens', () => {
    // Grounds the fix in the actual strings rather than a hypothetical. If these ever become
    // short, plain words, this test says so and the wrapping rule can be reconsidered.
    const src = readFileSync(resolve(COMPONENTS, 'MachineLauncher.tsx'), 'utf8');
    const flashes = [...src.matchAll(/flash\('(?:ok|err)',\s*([^)]+)\)/g)].map((m) => m[1]);
    expect(flashes.length, 'no flash() call sites found — the registry moved').toBeGreaterThanOrEqual(6);
    // hostname, absolute path, or a raw API error message — each a single token with no spaces.
    const risky = flashes.filter((f) => /hostname|root|e\.message|repoPath/.test(f));
    expect(risky.length, 'no message interpolates a value that can be one long token').toBeGreaterThan(0);
  });
});
