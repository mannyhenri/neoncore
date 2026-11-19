import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

/**
 * THE RETIRED GRIDLIGHT LOOK MUST NOT COME BACK.
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
  { name: 'Gridlight logo / wordmark image', pattern: /logo\.png|name_grid\.png|alt="Gridlight"/, instead: 'no logo in the chrome — the view title leads the top bar' },
  { name: 'blurred background image', pattern: /background\.png/, instead: 'the page is plain bg-ink (#04060C)' },
  { name: 'pixel font', pattern: /font-pixel|Press Start 2P/, instead: 'font-display (Space Grotesk) for titles, font-mono for code' },
  { name: 'cartridge sprites', pattern: /lib\/sprites|drawSprite|SPRITES\b/, instead: 'Night Glass cartridge cards have no sprites' },
  { name: 'CRT scanlines', pattern: /repeating-linear-gradient\(\s*0deg/, instead: 'no scanline overlay' },
  { name: 'old gl background / surface hex', pattern: /#0f0f23|#1a1a2e|#252542|#12121a|#0d0d14/i, instead: 'bg-ink, bg-gl-surface, bg-gl-elevated, bg-gl-code' },
  { name: 'old pink / purple / brand hex', pattern: /#ec4899|#a855f7|#c084fc|#9333ea|#e91e63|#2196f3/i, instead: 'neon-* for accents, ember-* for needs-you; Gridlight pink #FF7AC0 only on engine pills' },
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

  it('the palette keeps the old class names pointed at Night Glass', () => {
    // Re-pointing is what makes an old-look drop render in the new colours before it is
    // restyled. If someone restores the stock violet scale, every unconverted class goes purple.
    const cfg = readFileSync(resolve(DASH, 'tailwind.config.js'), 'utf8');
    expect(cfg).toMatch(/violet:\s*neon/);
    expect(cfg).toMatch(/purple:\s*neon/);
    expect(cfg).toMatch(/gray:\s*slate/);
  });
});
