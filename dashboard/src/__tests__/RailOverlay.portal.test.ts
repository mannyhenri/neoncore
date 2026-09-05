import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Overlays rendered from inside the command rail must escape it.
 *
 * `feat(dashboard): a command rail you don't have to scroll back to` moved the workflow
 * panel into a `lg:sticky` <aside>. `position: sticky` ALWAYS creates a stacking
 * context — with or without a z-index — so from that moment every overlay rendered
 * inside the rail was sealed into it. `fixed inset-0 z-50` no longer means "on top of
 * the page"; it means "on top of the rail", and the rail paints before <main>. The
 * workflow canvas opened fully functional and completely invisible: its toolbar, Save,
 * Run and Close were all in the DOM, with the cartridge grid painted over them.
 *
 * The fix is not a bigger z-index — no value wins against a sibling stacking context
 * that paints later. The overlay has to leave the subtree via createPortal, which
 * WorkflowPanel's deferred popup already does ("rendered via portal to escape any
 * parent stacking context"). One instance was fixed; the invariant was not.
 *
 * So this test is SET-BASED over the rail's import graph rather than over the one
 * component that was reported broken. The failure it prevents is precisely the one that
 * happened: fixing the overlay someone noticed and leaving the others sealed in, where
 * they stay invisible until a user opens that particular thing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = resolve(HERE, '../components');

/** The rail's root. Everything reachable from here renders inside the sticky <aside>. */
const RAIL_ROOT = resolve(COMPONENTS, 'WorkflowPanel.tsx');

/** Follow relative imports transitively — the registry is DERIVED, never hand-listed. */
function railSubtree(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry) || !existsSync(entry)) return [...seen];
  seen.add(entry);
  const src = readFileSync(entry, 'utf8');
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    const spec = m[1];
    if (spec.includes('/types') || spec.includes('/lib/') || spec.includes('/hooks/')) continue;
    for (const ext of ['.tsx', '.ts']) {
      const p = resolve(dirname(entry), spec + ext);
      if (existsSync(p)) { railSubtree(p, seen); break; }
    }
  }
  return [...seen];
}

/**
 * Comments are stripped first: this file's own prose explains the bug using the literal
 * class string, and a scanner that counts its own documentation as a defect is noise.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * Every overlay in the rail subtree that must escape it, with its source offset.
 *
 * TWO SHAPES, because only one was covered and the other shipped the identical bug. A
 * full-screen `fixed inset-0` is the obvious one. A POSITIONED POPOVER — `absolute` with a
 * z-index, the shape of every dropdown — is sealed into the sticky rail in exactly the same
 * way and for exactly the same reason: no z-index wins against a sibling stacking context that
 * paints later. The autonomy dropdown was reported rendering behind the runs beneath it, and
 * this scanner did not see it because it was looking only for the full-screen form.
 */
function overlaysIn(file: string) {
  const src = code(file);
  const hits = [
    ...src.matchAll(/fixed inset-0/g),
    ...src.matchAll(/absolute[^"'`]*\bz-\d+/g),
  ];
  return hits.map((m) => ({
    file,
    index: m.index!,
    src,
    line: src.slice(0, m.index!).split('\n').length,
  }));
}

const SUBTREE = railSubtree(RAIL_ROOT);
const OVERLAYS = SUBTREE.flatMap(overlaysIn);

describe('overlays rendered from the command rail', () => {
  it('the rail is a stacking context — which is why this whole file exists', () => {
    // If the rail ever stops being sticky the trap is gone, and this test is free to be
    // deleted. Until then it is load-bearing, so the premise is asserted, not assumed.
    const app = readFileSync(resolve(HERE, '../App.tsx'), 'utf8');
    const aside = app.slice(app.indexOf('<aside'), app.indexOf('>', app.indexOf('<aside')));
    expect(aside).toMatch(/sticky/);
  });

  it('the registry is non-empty and includes the canvas editor', () => {
    // A walker that silently resolves nothing would make every assertion below vacuous.
    expect(OVERLAYS.length).toBeGreaterThan(0);
    expect(SUBTREE.some((f) => f.endsWith('WorkflowCanvasEditor.tsx'))).toBe(true);
  });

  it.each(OVERLAYS.map((o) => ({
    name: `${o.file.split('/').pop()}:${o.line}`,
    ...o,
  })))('$name is portaled out of the rail', ({ src, index }) => {
    // Two shapes both escape the rail, and both are in use here: a component whose ROOT
    // return is portaled (the canvas), and an overlay assigned as its own portaled
    // element (WorkflowPanel's deferred popup). What they share — and what is asserted —
    // is that the overlay's markup sits inside a createPortal(...) call. Nested dialogs
    // come along for free: they are inside a tree that already left the subtree.
    const portal = src.indexOf('createPortal(');
    expect(
      portal,
      'no createPortal in this file — the overlay is sealed inside the sticky rail and ' +
      'paints behind the cartridge grid, whatever its z-index',
    ).toBeGreaterThan(-1);
    expect(
      index,
      'overlay markup precedes every createPortal call, so it is not inside one',
    ).toBeGreaterThan(portal);
  });

  it.each(SUBTREE.filter((f) => overlaysIn(f).length > 0).map((f) => ({
    name: f.split('/').pop()!, file: f,
  })))('$name portals to document.body', ({ file }) => {
    // Portaling into any other node re-parents the problem somewhere else.
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/createPortal\(/);
    expect(src, 'portal target must be document.body').toMatch(/document\.body/);
  });
});
