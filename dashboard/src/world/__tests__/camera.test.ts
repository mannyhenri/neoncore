import { describe, it, expect } from 'vitest';
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, scaleFor, clampCamera, homeCamera, zoomAt, panBy } from '../camera';
import { PLATES } from '../sites';

/**
 * "And the ability to zoom in and out of the map."
 *
 * Set-based over every plate, a spread of window shapes, and long runs of zooming and panning:
 * whatever you do with the wheel or the mouse, the map always fills the view, the zoom stays
 * in range, and zooming keeps the spot under the cursor under the cursor.
 */
const VIEWS = [{ w: 1844, h: 894 }, { w: 1364, h: 760 }, { w: 800, h: 900 }, { w: 390, h: 640 }, { w: 2560, h: 500 }];

describe('the camera', () => {
  const cases = PLATES.flatMap((p) => VIEWS.map((view) => ({ name: `${p.id} in ${view.w}×${view.h}`, plate: { w: p.width, h: p.height }, view })));

  const covers = (cam: { zoom: number; x: number; y: number }, view: typeof VIEWS[number], plate: { w: number; h: number }) => {
    const s = scaleFor(cam.zoom, view, plate);
    expect(cam.x).toBeLessThanOrEqual(0.001);
    expect(cam.y).toBeLessThanOrEqual(0.001);
    expect(cam.x + plate.w * s).toBeGreaterThanOrEqual(view.w - 0.001);
    expect(cam.y + plate.h * s).toBeGreaterThanOrEqual(view.h - 0.001);
    expect(cam.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(cam.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  };

  it.each(cases)('$name: home fills the view, centred', ({ plate, view }) => {
    const cam = homeCamera(view, plate);
    expect(cam.zoom).toBe(1);
    covers(cam, view, plate);
    const s = scaleFor(1, view, plate);
    expect(cam.x).toBeCloseTo((view.w - plate.w * s) / 2, 3);
    expect(cam.y).toBeCloseTo((view.h - plate.h * s) / 2, 3);
  });

  it.each(cases)('$name: 400 random zooms and pans never show past the edge of the map', ({ plate, view }) => {
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let cam = homeCamera(view, plate);
    for (let i = 0; i < 400; i++) {
      cam = rnd() < 0.5
        ? zoomAt(cam, rnd() < 0.5 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: rnd() * view.w, y: rnd() * view.h }, view, plate)
        : panBy(cam, (rnd() - 0.5) * 900, (rnd() - 0.5) * 900, view, plate);
      covers(cam, view, plate);
    }
  });

  it.each(cases)('$name: zooming in keeps the spot under the cursor where it is', ({ plate, view }) => {
    const at = { x: view.w * 0.5, y: view.h * 0.5 };
    const before = homeCamera(view, plate);
    const s0 = scaleFor(before.zoom, view, plate);
    const point = { x: (at.x - before.x) / s0, y: (at.y - before.y) / s0 };
    const after = zoomAt(before, ZOOM_STEP * ZOOM_STEP, at, view, plate);
    const s1 = scaleFor(after.zoom, view, plate);
    expect(after.zoom).toBeCloseTo(ZOOM_STEP * ZOOM_STEP, 5);
    expect(after.x + point.x * s1).toBeCloseTo(at.x, 3);
    expect(after.y + point.y * s1).toBeCloseTo(at.y, 3);
  });

  it('zoom stops at both limits, and nonsense input is made safe', () => {
    const view = VIEWS[0];
    const plate = { w: PLATES[0].width, h: PLATES[0].height };
    let cam = homeCamera(view, plate);
    for (let i = 0; i < 30; i++) cam = zoomAt(cam, ZOOM_STEP, { x: 10, y: 10 }, view, plate);
    expect(cam.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 60; i++) cam = zoomAt(cam, 1 / ZOOM_STEP, { x: 10, y: 10 }, view, plate);
    expect(cam.zoom).toBe(MIN_ZOOM);
    const safe = clampCamera({ zoom: NaN, x: NaN, y: Infinity }, view, plate);
    expect(Number.isFinite(safe.zoom) && Number.isFinite(safe.x) && Number.isFinite(safe.y)).toBe(true);
  });
});
