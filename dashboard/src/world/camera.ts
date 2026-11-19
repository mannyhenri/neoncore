/**
 * THE CAMERA — zoom and pan over the plate.
 *
 * `zoom` 1 is "cover": the plate just fills the view. Zooming in magnifies up to MAX_ZOOM;
 * you cannot zoom out past cover, and you cannot pan the plate's edge into view — so the
 * scene never shows empty space around the map. `x`/`y` are the top-left of the plate
 * relative to the view, in pixels.
 */
export interface Camera { zoom: number; x: number; y: number }
export interface Size { w: number; h: number }

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** One click of a zoom button, or one notch of the wheel. */
export const ZOOM_STEP = 1.25;

/** Pixels per plate pixel at this zoom. */
export function scaleFor(zoom: number, view: Size, plate: Size): number {
  return Math.max(view.w / plate.w, view.h / plate.h) * zoom;
}

/** Keep the zoom in range and the plate covering the whole view. */
export function clampCamera(cam: Camera, view: Size, plate: Size): Camera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(cam.zoom) ? cam.zoom : 1));
  const s = scaleFor(zoom, view, plate);
  const w = plate.w * s;
  const h = plate.h * s;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : (lo + hi) / 2));
  return { zoom, x: clamp(cam.x, view.w - w, 0), y: clamp(cam.y, view.h - h, 0) };
}

/** The camera you start with: zoom 1, plate centred. */
export function homeCamera(view: Size, plate: Size): Camera {
  const s = scaleFor(1, view, plate);
  return clampCamera({ zoom: 1, x: (view.w - plate.w * s) / 2, y: (view.h - plate.h * s) / 2 }, view, plate);
}

/** Zoom by `factor`, keeping the plate point under `at` (view pixels) where it is. */
export function zoomAt(cam: Camera, factor: number, at: { x: number; y: number }, view: Size, plate: Size): Camera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  const before = scaleFor(cam.zoom, view, plate);
  const after = scaleFor(zoom, view, plate);
  // The plate point under the cursor…
  const px = (at.x - cam.x) / before;
  const py = (at.y - cam.y) / before;
  // …stays under the cursor.
  return clampCamera({ zoom, x: at.x - px * after, y: at.y - py * after }, view, plate);
}

export function panBy(cam: Camera, dx: number, dy: number, view: Size, plate: Size): Camera {
  return clampCamera({ zoom: cam.zoom, x: cam.x + dx, y: cam.y + dy }, view, plate);
}
