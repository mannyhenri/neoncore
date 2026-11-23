/**
 * FITTING A PICTURE TO THE SHAPE IT REPLACES (the theme creator). A replacement keeps the original's
 * shape: a sprite sheet keeps its grid of frames, a map its proportions (everything on it is placed
 * by fractions of it). Art of other proportions is cut, trimmed and fitted here, and a plain
 * background can be made see-through. Pure pixel work on RGBA arrays — the canvas glue is at the end.
 */
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export interface Box { x: number; y: number; w: number; h: number }

export const blank = (width: number, height: number): Pixels => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
const at = (img: Pixels, x: number, y: number) => (y * img.width + x) * 4;

/** The plain background colour: what at least three of the four corners agree on, if they are opaque. */
export function backgroundOf(img: Pixels, tol = 24): [number, number, number] | null {
  const corners = [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]].map(([x, y]) => Array.from(img.data.slice(at(img, x, y), at(img, x, y) + 4)));
  for (const c of corners) {
    if (c[3] < 250) continue;
    const agree = corners.filter((d) => d[3] >= 250 && Math.abs(d[0] - c[0]) <= tol && Math.abs(d[1] - c[1]) <= tol && Math.abs(d[2] - c[2]) <= tol).length;
    if (agree >= 3) return [c[0], c[1], c[2]];
  }
  return null;
}

/** The plain background made see-through: every pixel near its colour. Unchanged when there is none. */
export function keyOut(img: Pixels, tol = 48): Pixels {
  const bg = backgroundOf(img);
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  if (!bg) return out;
  for (let i = 0; i < out.data.length; i += 4) {
    if (Math.abs(out.data[i] - bg[0]) <= tol && Math.abs(out.data[i + 1] - bg[1]) <= tol && Math.abs(out.data[i + 2] - bg[2]) <= tol) out.data[i + 3] = 0;
  }
  return out;
}

/** The smallest box holding every visible pixel; null when nothing is. */
export function contentBox(img: Pixels, region: Box = { x: 0, y: 0, w: img.width, h: img.height }): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
    if (img.data[at(img, x, y) + 3] > 16) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Draw `src`'s box into `dst`'s box, scaled (nearest pixel — the art is pixel art). */
export function drawScaled(dst: Pixels, d: Box, src: Pixels, s: Box): void {
  for (let y = 0; y < d.h; y++) {
    const sy = s.y + Math.min(s.h - 1, Math.floor((y * s.h) / d.h));
    const ty = d.y + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < d.w; x++) {
      const tx = d.x + x;
      if (tx < 0 || tx >= dst.width) continue;
      const sx = s.x + Math.min(s.w - 1, Math.floor((x * s.w) / d.w));
      const i = at(src, sx, sy); const o = at(dst, tx, ty);
      dst.data[o] = src.data[i]; dst.data[o + 1] = src.data[i + 1]; dst.data[o + 2] = src.data[i + 2]; dst.data[o + 3] = src.data[i + 3];
    }
  }
}

/** Inside W × H, whole, proportions kept: centred, or standing on the bottom edge. */
export function fitContain(src: Pixels, W: number, H: number, align: 'center' | 'bottom' = 'center', box: Box = contentBox(src) ?? { x: 0, y: 0, w: src.width, h: src.height }): Pixels {
  const out = blank(W, H);
  const k = Math.min(W / box.w, H / box.h);
  const w = Math.max(1, Math.round(box.w * k)), h = Math.max(1, Math.round(box.h * k));
  drawScaled(out, { x: Math.floor((W - w) / 2), y: align === 'bottom' ? H - h : Math.floor((H - h) / 2), w, h }, src, box);
  return out;
}

/** Filling W × H, proportions kept: what overflows is cut evenly from both sides. */
export function fitCover(src: Pixels, W: number, H: number): Pixels {
  const out = blank(W, H);
  const k = Math.max(W / src.width, H / src.height);
  const sw = Math.min(src.width, Math.round(W / k)), sh = Math.min(src.height, Math.round(H / k));
  drawScaled(out, { x: 0, y: 0, w: W, h: H }, src, { x: Math.floor((src.width - sw) / 2), y: Math.floor((src.height - sh) / 2), w: sw, h: sh });
  return out;
}

/**
 * A sprite sheet: the art is cut into the same grid, each frame trimmed to its figure, and every
 * figure scaled by ONE factor (so it does not grow and shrink between frames) to stand at the bottom
 * centre of its frame in a W × H sheet.
 */
export function fitSheet(src: Pixels, grid: { cols: number; rows: number }, W: number, H: number): Pixels {
  const out = blank(W, H);
  const cw = src.width / grid.cols, ch = src.height / grid.rows;
  const fw = W / grid.cols, fh = H / grid.rows;
  const boxes: (Box | null)[] = [];
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    boxes.push(contentBox(src, { x: Math.round(c * cw), y: Math.round(r * ch), w: Math.round((c + 1) * cw) - Math.round(c * cw), h: Math.round((r + 1) * ch) - Math.round(r * ch) }));
  }
  const maxW = Math.max(1, ...boxes.map((b) => b?.w ?? 0)), maxH = Math.max(1, ...boxes.map((b) => b?.h ?? 0));
  const k = Math.min((fw * 0.96) / maxW, (fh * 0.96) / maxH);
  boxes.forEach((b, i) => {
    if (!b) return;
    const c = i % grid.cols, r = Math.floor(i / grid.cols);
    const w = Math.max(1, Math.round(b.w * k)), h = Math.max(1, Math.round(b.h * k));
    drawScaled(out, { x: Math.round(c * fw + (fw - w) / 2), y: Math.round((r + 1) * fh - h), w, h }, src, b);
  });
  return out;
}

/** The whole fitting, as the asset asks. */
export function fitPicture(src: Pixels, how: { fit: 'sheet' | 'cover' | 'contain'; grid?: { cols: number; rows: number } }, W: number, H: number, seeThrough: boolean): Pixels {
  const art = seeThrough ? keyOut(src) : src;
  if (how.fit === 'sheet' && how.grid) return fitSheet(art, how.grid, W, H);
  if (how.fit === 'cover') return fitCover(art, W, H);
  return fitContain(art, W, H, 'bottom');
}

// ── the canvas glue (browser only) ──────────────────────────────────────────────

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('that picture could not be read')); im.src = src; });
}
export function pixelsOf(im: HTMLImageElement): Pixels {
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const g = c.getContext('2d');
  if (!g) throw new Error('this browser cannot fit pictures');
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}
export function pngOf(p: Pixels): string {
  const c = document.createElement('canvas'); c.width = p.width; c.height = p.height;
  const g = c.getContext('2d');
  if (!g) throw new Error('this browser cannot fit pictures');
  g.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return c.toDataURL('image/png');
}
