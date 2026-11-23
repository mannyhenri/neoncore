import { describe, it, expect } from 'vitest';
import { blank, backgroundOf, keyOut, contentBox, fitContain, fitCover, fitPicture, type Pixels } from '../fitImage';

const MAGENTA = [255, 0, 255, 255];
function filled(w: number, h: number, rgba = MAGENTA): Pixels { const p = blank(w, h); for (let i = 0; i < p.data.length; i += 4) p.data.set(rgba, i); return p; }
function rect(p: Pixels, x: number, y: number, w: number, h: number, rgba = [10, 200, 30, 255]) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) p.data.set(rgba, (j * p.width + i) * 4); return p; }
const alpha = (p: Pixels, x: number, y: number) => p.data[(y * p.width + x) * 4 + 3];

describe('making a plain background see-through', () => {
  it('finds the background when three or four corners agree, and not otherwise', () => {
    expect(backgroundOf(filled(8, 8))).toEqual([255, 0, 255]);
    const three = rect(filled(8, 8), 7, 7, 1, 1);
    expect(backgroundOf(three)).toEqual([255, 0, 255]);
    const two = rect(rect(filled(8, 8), 7, 7, 1, 1), 0, 7, 1, 1);
    expect(backgroundOf(two)).toBeNull();
    expect(backgroundOf(blank(4, 4)), 'already see-through').toBeNull();
  });
  it('keys out exactly the background, keeps the figure', () => {
    const p = keyOut(rect(filled(10, 10), 3, 3, 4, 4));
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) expect(alpha(p, x, y) > 0, `${x},${y}`).toBe(x >= 3 && x < 7 && y >= 3 && y < 7);
  });
});

describe('fitting', () => {
  it('contentBox: the figure\'s box, or null for nothing', () => {
    expect(contentBox(rect(blank(10, 10), 2, 3, 4, 5))).toEqual({ x: 2, y: 3, w: 4, h: 5 });
    expect(contentBox(blank(5, 5))).toBeNull();
  });

  it.each([[40, 20], [20, 40], [33, 33], [100, 10]])('contain into %i×%i: whole, proportions kept, on the bottom edge, centred', (W, H) => {
    const out = fitContain(rect(blank(10, 20), 0, 0, 10, 20), W, H, 'bottom');
    expect([out.width, out.height]).toEqual([W, H]);
    const b = contentBox(out)!;
    expect(Math.abs(b.w / b.h - 0.5)).toBeLessThan(0.15);
    expect(b.y + b.h).toBe(H);
    expect(Math.abs(b.x + b.w / 2 - W / 2)).toBeLessThanOrEqual(1);
    expect(b.w === W || b.h === H).toBe(true);
  });

  it.each([[40, 20], [20, 40], [30, 30]])('cover into %i×%i: every pixel filled', (W, H) => {
    const out = fitCover(rect(blank(50, 30), 0, 0, 50, 30), W, H);
    expect(contentBox(out)).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  it.each([[2, 2, 80, 120], [4, 3, 160, 96], [4, 6, 224 * 4 / 8, 320 * 6 / 8]])('a %i×%i sheet into %i×%i: every frame trimmed, one scale for all, standing at the bottom centre of its own frame', (cols, rows, W, H) => {
    // Source frames of 30×40 on magenta, each figure a different size and place in its frame.
    const src = filled(cols * 30, rows * 40);
    const figs: [number, number][] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const w = 6 + ((r * cols + c) % 3) * 4, h = 10 + ((r * cols + c) % 2) * 8;
      rect(src, c * 30 + 2 + c, r * 40 + 3 + r, w, h);
      figs.push([w, h]);
    }
    const out = fitPicture(src, { fit: 'sheet', grid: { cols, rows } }, Math.round(W), Math.round(H), true);
    expect([out.width, out.height]).toEqual([Math.round(W), Math.round(H)]);
    const fw = out.width / cols, fh = out.height / rows;
    const scales: number[] = [];
    figs.forEach(([, h], i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const b = contentBox(out, { x: Math.round(c * fw), y: Math.round(r * fh), w: Math.round((c + 1) * fw) - Math.round(c * fw), h: Math.round((r + 1) * fh) - Math.round(r * fh) })!;
      expect(b, `frame ${i}`).not.toBeNull();
      expect(Math.abs(b.y + b.h - (r + 1) * fh), `frame ${i} stands on its bottom`).toBeLessThanOrEqual(1);
      expect(Math.abs(b.x + b.w / 2 - (c + 0.5) * fw), `frame ${i} centred`).toBeLessThanOrEqual(1.5);
      scales.push(b.h / h);
    });
    const max = Math.max(...scales), min = Math.min(...scales);
    expect(max - min, 'one scale for every frame').toBeLessThan(0.15 * max);
    // The magenta is gone.
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] > 0) expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([10, 200, 30]);
  });
});
