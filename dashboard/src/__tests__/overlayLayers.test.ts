import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
// @ts-expect-error — plain JS config, no types
import tailwindConfig from '../../tailwind.config.js';

/**
 * Anything you click open — a modal, a menu, a picker — is on top of everything else.
 *
 * Two traps kept breaking that:
 *  1. A STACKING CONTEXT. The top bar is `sticky z-20` with a backdrop blur, so the launcher's
 *     menu inside it could never rise above the world's sector bar (z-30), whatever its own
 *     z-index said. A modal rendered inside any panel with a z-index, a transform or a filter is
 *     sealed in the same way.
 *  2. NO ORDER AT ALL. Every component picked its own number (z-30, z-50, z-[100], 10000), and
 *     the agent card in the world had none, so the sector bar painted over it.
 *
 * The rule, in one place (tailwind.config.js zIndex): hud < float < topbar < overlay.
 *  - Every full-window or fixed-position surface (modal, backdrop, floating menu) uses
 *    `z-overlay` AND is portaled to document.body, so no ancestor can seal it in.
 *  - The top bar sits above every in-page HUD, so the menus that drop from it do too.
 *  - The world's HUD (sector bar, feature HUD, roadmap deck) is `z-hud`; the agent card that
 *    floats over a figure is `z-float`, above that HUD.
 *
 * SET-BASED: it walks every source file, so a new modal that picks its own number or forgets
 * the portal fails here instead of on screen.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Every className string literal (or template) in a file, with its line number. */
function classNames(src: string): { line: number; cls: string }[] {
  const out: { line: number; cls: string }[] = [];
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push({ line: src.slice(0, m.index).split('\n').length, cls: m[1] ?? m[2] });
  }
  return out;
}

const FILES = sourceFiles(SRC).map((path) => ({ path, rel: relative(SRC, path), src: readFileSync(path, 'utf8') }));

/** Fixed-position surfaces that are NOT chrome: App.tsx's view bar and the roadmap deck are HUD. */
const OVERLAYS = FILES.flatMap((f) =>
  f.rel === 'App.tsx' ? [] : classNames(f.src)
    .filter(({ cls }) => /(^|\s)fixed(\s|$)/.test(cls))
    .filter(({ line }) => !f.src.split('\n')[line - 1].includes('data-roadmap-deck'))
    .map((c) => ({ ...c, file: f.rel, src: f.src })),
);

describe('layer scale', () => {
  const z = (tailwindConfig as { theme: { extend: { zIndex?: Record<string, string> } } }).theme.extend.zIndex ?? {};

  it('defines hud < float < topbar < overlay', () => {
    expect(Object.keys(z).sort()).toEqual(['float', 'hud', 'overlay', 'topbar']);
    expect(Number(z.hud)).toBeLessThan(Number(z.float));
    expect(Number(z.float)).toBeLessThan(Number(z.topbar));
    expect(Number(z.topbar)).toBeLessThan(Number(z.overlay));
  });
});

describe('every fixed overlay is on top', () => {
  it('finds the overlays (the scan is not empty)', () => {
    expect(OVERLAYS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(OVERLAYS.map((o) => [`${o.file}:${o.line}`, o] as const))('%s uses z-overlay', (_where, o) => {
    expect(o.cls).toMatch(/(^|\s)z-overlay(\s|$)/);
  });

  it.each(OVERLAYS.map((o) => [`${o.file}:${o.line}`, o] as const))('%s is portaled to document.body', (_where, o) => {
    expect(o.src).toMatch(/createPortal\(|<Overlay\b/);
  });

  it('no inline zIndex escapes the scale on an overlay', () => {
    const offenders = FILES.filter((f) => /zIndex:\s*1\d{4}/.test(f.src)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe('chrome and HUD sit under the overlays, in order', () => {
  const app = FILES.find((f) => f.rel === 'App.tsx')!.src;
  const world = FILES.find((f) => f.rel === 'world/WorldScene.tsx')!.src;
  const tagClass = (src: string, marker: string) => {
    const at = src.indexOf(marker);
    expect(at, marker).toBeGreaterThan(-1);
    // The tag's own className — not up to the first `>`, which an attribute like `n > 1` contains.
    const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(src.slice(at));
    return cls ? (cls[1] ?? cls[2]) : '';
  };

  it('the top bar is z-topbar, so the menus that drop from it clear the HUD', () => {
    expect(tagClass(app, '<header')).toMatch(/\bz-topbar\b/);
  });

  it('the view bar is z-hud', () => {
    expect(tagClass(app, '<nav\n        aria-label="Views"')).toMatch(/\bz-hud\b/);
  });

  it.each([
    ['world/WorldScene.tsx', '<nav data-world-nav'],
    ['world/FeatureHud.tsx', 'className="absolute bottom-3'],
    ['components/ProjectHub.tsx', 'data-roadmap-deck'],
  ])('%s HUD (%s) is z-hud', (file, marker) => {
    expect(tagClass(FILES.find((f) => f.rel === file)!.src, marker)).toMatch(/\bz-hud\b/);
  });

  it('the agent card over a figure is z-float, above the world HUD', () => {
    expect(tagClass(world, 'data-crew-card')).toMatch(/\bz-float\b/);
  });
});
