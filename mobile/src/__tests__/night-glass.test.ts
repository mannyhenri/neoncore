import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { theme, statusColor } from '../theme';

/**
 * THE PHONE LOOKS LIKE THE DASHBOARD — Night Glass, and nothing of Gridlight.
 *
 * The app shipped the retired look long after the web dropped it: violet accent, pink "Core"
 * wordmark, the Gridlight circuit logo in the header, on the app icon and on the launch screen.
 * The dashboard has designGuard.test.ts to stop that look coming back; the phone had nothing, so
 * nothing failed. This is that guard for the phone, checked as sets: every source file, every
 * colour token, every icon image.
 */
const ROOT = path.join(import.meta.dirname, '..', '..');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
const SOURCES = [path.join(ROOT, 'App.tsx'), ...walk(path.join(ROOT, 'src')).filter((f) => /\.tsx?$/.test(f))];
const rel = (f: string) => path.relative(ROOT, f);

describe('Night Glass on the phone', () => {
  it('the tokens are the dashboard\'s (docs/DESIGN.md → Tokens)', () => {
    expect({
      bg: theme.bg, text: theme.text, textDim: theme.textDim, textFaint: theme.textFaint,
      accent: theme.accent, ember: theme.ember, success: theme.success, danger: theme.danger,
    }).toEqual({
      bg: '#04060C', text: '#E8EEFF', textDim: '#A9B5D3', textFaint: '#8A97B8',
      accent: '#5AAEFF', ember: '#FF8A3D', success: '#4ADE80', danger: '#FF6B6B',
    });
    // Live is neon; needs-you is ember; nothing else borrows either.
    expect(statusColor.working).toBe(theme.accent);
    expect(statusColor.waiting).toBe(theme.ember);
    // The retired roles are gone as NAMES, so no screen can reach for them.
    for (const gone of ['pink', 'teal', 'amber', 'blue']) expect(Object.keys(theme), gone).not.toContain(gone);
  });

  it('no source file carries a colour of the retired look, or the Gridlight name as a brand', () => {
    // Violet/purple accents, the pink wordmark, the purple-tinted card and border, the old page.
    const RETIRED = ['#a855f7', '#c084fc', '#ec4899', '#1a1a2e', '#2a2a3e', '#0d0f12', '#14161c', '#55efc4',
      '168,85,247', '236,72,153', '245,158,11'];
    const hits: string[] = [];
    for (const f of SOURCES) {
      const src = fs.readFileSync(f, 'utf8').toLowerCase().replace(/\s+/g, '');
      for (const c of RETIRED) if (src.includes(c)) hits.push(`${rel(f)}: ${c}`);
      if (/gridlightlogo|assets\/logo\.png/.test(src)) hits.push(`${rel(f)}: the Gridlight logo`);
    }
    expect(hits).toEqual([]);
  });

  it('every colour a screen uses comes from the theme — no hex literals outside it', () => {
    const hits: string[] = [];
    for (const f of SOURCES) {
      if (rel(f) === path.join('src', 'theme.ts')) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/['"`](#[0-9a-fA-F]{3,8})['"`]/g)) hits.push(`${rel(f)}: ${m[1]}`);
    }
    expect(hits).toEqual([]);
  });

  it('the header is a wordmark: no image, one colour', () => {
    const header = fs.readFileSync(path.join(ROOT, 'src/components/BrandHeader.tsx'), 'utf8');
    expect(header).not.toMatch(/<Image\b/);
    expect(header).not.toMatch(/require\(/);
    expect(header).toMatch(/NeonCore/);
  });

  /** Decode a PNG far enough to read its pixels (8-bit RGB / RGBA, non-interlaced). */
  function pixels(file: string): { w: number; h: number; ch: number; data: Buffer } {
    const buf = fs.readFileSync(file);
    let off = 8; let w = 0; let h = 0; let type = 0; const idat: Buffer[] = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off); const name = buf.toString('ascii', off + 4, off + 8);
      const body = buf.subarray(off + 8, off + 8 + len);
      if (name === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9]; expect(body[8], `${file} bit depth`).toBe(8); }
      if (name === 'IDAT') idat.push(body);
      off += 12 + len;
    }
    const ch = type === 6 ? 4 : type === 2 ? 3 : 0;
    expect(ch, `${file}: colour type ${type}`).toBeGreaterThan(0);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch; const out = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
      const ft = raw[y * (stride + 1)];
      for (let x = 0; x < stride; x++) {
        const v = raw[y * (stride + 1) + 1 + x];
        const a = x >= ch ? out[y * stride + x - ch] : 0;
        const b = y > 0 ? out[(y - 1) * stride + x] : 0;
        const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[y * stride + x] = (v + (ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : ft === 4 ? paeth : 0)) & 255;
      }
    }
    return { w, h, ch, data: out };
  }

  const ICONSET = path.join(ROOT, 'ios/NeonCore/Images.xcassets/AppIcon.appiconset');
  const ICONS = [
    ...['icon.png', 'adaptive-icon.png', 'splash.png'].map((f) => path.join(ROOT, 'assets', f)),
    ...(fs.existsSync(ICONSET) ? fs.readdirSync(ICONSET).filter((f) => f.endsWith('.png')).map((f) => path.join(ICONSET, f)) : []),
  ];

  it.each(ICONS.map((f) => ({ name: rel(f), file: f })))('$name is the NeonCore mark: near-black with neon blue, no pink or violet', ({ file }) => {
    const { w, h, ch, data } = pixels(file);
    let pinkish = 0; let neon = 0; let dark = 0;
    for (let i = 0; i < w * h; i++) {
      const r = data[i * ch]; const g = data[i * ch + 1]; const b = data[i * ch + 2];
      if (r > 150 && g < 120 && b > 90) pinkish++;          // the Gridlight gradient: pink through violet
      if (b > 200 && g > 130 && r < 150) neon++;
      if (r < 24 && g < 24 && b < 32) dark++;
    }
    expect(pinkish / (w * h), 'pink/violet pixels').toBeLessThan(0.001);
    expect(neon / (w * h), 'neon pixels').toBeGreaterThan(0.01);
    expect(dark / (w * h), 'near-black background').toBeGreaterThan(0.5);
  });

  it('the app icon set is still complete (every file its Contents.json names exists)', () => {
    const contents = JSON.parse(fs.readFileSync(path.join(ICONSET, 'Contents.json'), 'utf8')) as { images: { filename?: string }[] };
    const named = contents.images.map((i) => i.filename).filter((f): f is string => !!f);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((f) => !fs.existsSync(path.join(ICONSET, f)))).toEqual([]);
  });

  it('the logo image is not shipped any more', () => {
    expect(fs.existsSync(path.join(ROOT, 'assets/logo.png')), 'assets/logo.png (the Gridlight mark) is still in the bundle').toBe(false);
  });
});
