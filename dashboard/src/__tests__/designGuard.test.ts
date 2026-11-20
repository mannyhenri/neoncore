import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

/**
 * THE RETIRED PRE-NIGHT-GLASS LOOK MUST NOT COME BACK.
 *
 * The dashboard moved to Night Glass (docs/DESIGN.md) on 2026-11-18. Feature drops from other
 * developers are still written against the old look, and applying one is exactly how the old
 * logo, pixel font, sprites or pink/purple accents would quietly return. This test is the
 * tripwire: it scans EVERY source file, not a sample, so a drop that reintroduces any of these
 * in any file fails here instead of reaching the live UI.
 *
 * Each rule names what to use instead, so a failure reads as an instruction.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH = resolve(HERE, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(tsx?|css)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = [...walk(resolve(DASH, 'src')), resolve(DASH, 'index.html')];

const RULES: { name: string; pattern: RegExp; instead: string }[] = [
  { name: 'old logo / wordmark image', pattern: /logo\.png|name_grid\.png/, instead: 'no logo in the chrome — the view title leads the top bar' },
  { name: 'blurred background image', pattern: /background\.png/, instead: 'the page is plain bg-ink (#04060C)' },
  { name: 'pixel font', pattern: /font-pixel|Press Start 2P/, instead: 'font-display (Space Grotesk) for titles, font-mono for code' },
  { name: 'cartridge sprites', pattern: /lib\/sprites|drawSprite|SPRITES\b/, instead: 'Night Glass cartridge cards have no sprites' },
  { name: 'CRT scanlines', pattern: /repeating-linear-gradient\(\s*0deg/, instead: 'no scanline overlay' },
  { name: 'old gl background / surface hex', pattern: /#0f0f23|#1a1a2e|#252542|#12121a|#0d0d14/i, instead: 'bg-ink, bg-gl-surface, bg-gl-elevated, bg-gl-code' },
  { name: 'old pink / purple / brand hex', pattern: /#ec4899|#a855f7|#c084fc|#9333ea|#e91e63|#2196f3/i, instead: 'neon-* for accents, ember-* for needs-you' },
];

describe('Night Glass design guard', () => {
  it('scans the whole dashboard source', () => {
    expect(FILES.length).toBeGreaterThan(40);
    expect(existsSync(resolve(DASH, '../docs/DESIGN.md')), 'docs/DESIGN.md is the reference this test enforces').toBe(true);
  });

  it.each(RULES)('no $name anywhere in the dashboard', ({ pattern, instead }) => {
    const hits: string[] = [];
    for (const f of FILES) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${relative(DASH, f)}:${i + 1}`);
      });
    }
    expect(hits, `retired look found — use ${instead} (docs/DESIGN.md)`).toEqual([]);
  });

  /**
   * THE ONE EXCEPTION: the World view (V3, docs/DESIGN.md "The World view").
   *
   * The Agents screen is a pixel-art scene, so pixel avatars exist again — but only there.
   * Everything drawn OVER the scene (overhead panels, filters, the cartridge drawer) is still
   * Night Glass. This is set-based over every source file: pixel art may live in src/world/
   * and be mounted by App, and nowhere else.
   */
  it('pixel avatars and scene art stay inside the World view', () => {
    const design = readFileSync(resolve(DASH, '../docs/DESIGN.md'), 'utf8');
    expect(design, 'the exception must be written down where the rule is').toMatch(/## The World view/);
    const hits: string[] = [];
    for (const f of FILES) {
      const rel = relative(DASH, f).split('\\').join('/');
      if (rel.startsWith('src/world/') || rel === 'src/App.tsx') continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/world\/(Avatar|WorldScene|sites)|\/world\/[a-z-]+\.(jpg|png)|shapeRendering="crispEdges"/.test(line)) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits, 'scene art used outside the World view — panels and pages stay Night Glass').toEqual([]);
  });

  it('the World view itself brings back none of the retired look', () => {
    const world = FILES.filter((f) => relative(DASH, f).split('\\').join('/').startsWith('src/world/'));
    expect(world.length, 'src/world/ is empty — the scene is gone').toBeGreaterThan(2);
    for (const f of world) {
      const src = readFileSync(f, 'utf8');
      for (const { name, pattern } of RULES) expect(pattern.test(src), `${name} in ${relative(DASH, f)}`).toBe(false);
    }
  });

  it('the palette keeps the old class names pointed at Night Glass', () => {
    // Re-pointing is what makes an old-look drop render in the new colours before it is
    // restyled. If someone restores the stock violet scale, every unconverted class goes purple.
    const cfg = readFileSync(resolve(DASH, 'tailwind.config.js'), 'utf8');
    expect(cfg).toMatch(/violet:\s*neon/);
    expect(cfg).toMatch(/purple:\s*neon/);
    expect(cfg).toMatch(/gray:\s*slate/);
  });
});
