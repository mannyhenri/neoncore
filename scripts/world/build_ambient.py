#!/usr/bin/env python3
"""Ambient motion for the map: things that move all the time, whatever the agents are doing.

    python3 scripts/world/build_ambient.py designs dashboard

Every frame is made FROM THE DRAWN ART, never drawn here: the pond's water is the terrain's own
pixels, gently displaced like ripples with its own highlights glinting; the hologram and the
water station's tank are their own sprites, with their glowing pixels pulsing and drifting.

Writes, into dashboard/public/world/ambient/:
    pond.png            N frames side by side - the water only (the banks are transparent)
    holo-table.png      N frames of the whole sprite
    water-station.png   N frames of the whole sprite
    dish.png            N frames of the whole sprite, its head sweeping left and right
and dashboard/src/world/ambient.generated.ts.
Run build_world_kit.py first: this reads the sprites it wrote.
"""
import sys, os, math
from PIL import Image, ImageFilter
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_world_kit import terrain_image, MAP_W, MAP_H

FRAMES = 8
# The pond on the terrain, in the map's own pixels (1344 x 752): left, top, right, bottom.
POND = (440, 468, 770, 668)
# The pond's own oval inside that box: centre x, centre y, radius x, radius y.
POND_OVAL = (628, 558, 126, 68)


def sample(img, xs, ys):
    """Bilinear sample of an HxWxC float image at float coordinates."""
    h, w = img.shape[:2]
    xs = np.clip(xs, 0, w - 1.001); ys = np.clip(ys, 0, h - 1.001)
    x0 = np.floor(xs).astype(int); y0 = np.floor(ys).astype(int)
    fx = (xs - x0)[..., None]; fy = (ys - y0)[..., None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def pond(designs, out):
    full, _ = terrain_image(designs)
    s = full.width / MAP_W   # how many served pixels one map pixel is
    box = tuple(round(v * s) for v in POND)
    big = full.crop(box)
    rgb = np.asarray(big).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    # WHERE THE WATER IS. An ellipse over the pond (POND_OVAL, read off the map), minus
    # everything rock-coloured or grass-coloured inside it: the banks, the paved shore and
    # the grass stay perfectly still, and only water moves.
    hh, ww = r.shape
    yy0, xx0 = np.mgrid[0:hh, 0:ww].astype(np.float32)
    cx, cy, rx, ry = [v * s for v in POND_OVAL]
    oval = np.clip((1 - ((xx0 - (cx - box[0])) / rx) ** 2 - ((yy0 - (cy - box[1])) / ry) ** 2) * 4, 0, 1)
    rock = (r > g + 62) & (b < 125)   # bank rock is far redder than the sunlit water
    grass = (g > b + 22) & (g > r + 6) & (g < 150)
    land = Image.fromarray(((rock | grass) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(7))
    still = np.asarray(land.filter(ImageFilter.GaussianBlur(2.5))).astype(np.float32) / 255
    alpha = oval * (1 - still)
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lum = (r + g + b) / 3
    strip = Image.new('RGBA', (w * FRAMES, h), (0, 0, 0, 0))
    for k in range(FRAMES):
        t = 2 * math.pi * k / FRAMES
        # Ripples: two crossing waves. The amplitude fades to nothing at the banks (alpha).
        dx = (2.4 * np.sin(yy / 13.0 + t) + 1.2 * np.sin((xx + yy) / 21.0 - t)) * alpha
        dy = (1.8 * np.cos(xx / 17.0 + t) + 1.0 * np.sin((xx - yy) / 19.0 + t)) * alpha
        frame = sample(rgb, xx + dx, yy + dy)
        # Glints: the water's own highlights brighten as a band of light slides across.
        band = 0.5 + 0.5 * np.sin((xx * 0.9 + yy) / 38.0 - t)
        glint = np.clip((lum - 120) / 110, 0, 1) * band
        frame = np.clip(frame * (1 + 0.28 * glint[..., None]) + 26 * (glint ** 2)[..., None], 0, 255)
        rgba = np.dstack([frame, alpha * 255]).astype(np.uint8)
        strip.paste(Image.fromarray(rgba, 'RGBA'), (k * w, 0))
    strip.save(os.path.join(out, 'pond.png'), optimize=True)
    W, H = MAP_W, MAP_H
    print(f'pond            {FRAMES} frames of {w}x{h}, water covers {alpha.mean() * 100:.0f}% of the box')
    return f"{{ src: '/world/ambient/pond.png', frames: {FRAMES}, fps: 6, x: {POND[0] / W:.5f}, y: {POND[1] / H:.5f}, w: {(POND[2] - POND[0]) / W:.5f}, h: {(POND[3] - POND[1]) / H:.5f} }}"


def glow(name, kit, out, pick, bob):
    """Pulse (and gently lift) the glowing pixels of one sprite. `pick` says which pixels glow."""
    img = Image.open(os.path.join(kit, f'{name}.png')).convert('RGBA')
    px = np.asarray(img).astype(np.float32)
    r, g, b, a = px[..., 0], px[..., 1], px[..., 2], px[..., 3]
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lit = pick(r, g, b, a, xx / w, yy / h)
    soft = np.asarray(Image.fromarray((lit * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5))).astype(np.float32) / 255
    strip = Image.new('RGBA', (w * FRAMES, h), (0, 0, 0, 0))
    for k in range(FRAMES):
        t = 2 * math.pi * k / FRAMES
        # The lit part drifts up and down; a scan band travels through it; everything else is still.
        moved = sample(px, xx, yy + bob * math.sin(t) * soft)
        band = 0.5 + 0.5 * np.sin(yy / 5.0 - t * 2)
        gain = 1 + soft * (0.16 * math.sin(t) + 0.14 * band)
        frame = moved.copy()
        frame[..., :3] = np.clip(moved[..., :3] * gain[..., None] + (18 * soft * band)[..., None], 0, 255)
        strip.paste(Image.fromarray(frame.astype(np.uint8), 'RGBA'), (k * w, 0))
    strip.save(os.path.join(out, f'{name}.png'), optimize=True)
    print(f'{name:16s}{FRAMES} frames of {w}x{h}, {lit.mean() * 100:.0f}% of it glows')
    return f"'{name}': {{ src: '/world/ambient/{name}.png', frames: {FRAMES}, fps: 6, w: {w}, h: {h} }}"


def sway(name, kit, out, neck, degrees):
    """Turn the top of a sprite a few degrees left and right about its neck, like a dish
    sweeping the sky. `neck` is how far down the sprite (0..1) the moving part ends: above it
    everything turns, below it nothing moves, and the two are blended across the joint."""
    src = Image.open(os.path.join(kit, f'{name}.png')).convert('RGBA')
    # Room to turn in: the still sprite is trimmed tight, so the turned head needs a margin
    # (equal left and right, and above) or it would be cut off at the edge of its own frame.
    pad = round(src.width * 0.16)
    img = Image.new('RGBA', (src.width + 2 * pad, src.height + pad), (0, 0, 0, 0))
    img.paste(src, (pad, pad))
    neck = (pad + neck * src.height) / img.height
    px = np.asarray(img).astype(np.float32)
    h, w = px.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # 1 above the neck, 0 below it, a short ramp across it.
    part = np.clip((neck * h - yy) / (0.07 * h) + 0.5, 0, 1)
    alpha = px[..., 3]
    cols = np.nonzero((alpha[: int(neck * h)] > 40).any(axis=0))[0]
    cx, cy = (cols.min() + cols.max()) / 2.0, neck * h
    strip = Image.new('RGBA', (w * FRAMES, h), (0, 0, 0, 0))
    for k in range(FRAMES):
        ang = math.radians(degrees) * math.sin(2 * math.pi * k / FRAMES)
        c, sn = math.cos(ang), math.sin(ang)
        # Where each output pixel of the turned part comes from (inverse rotation about the neck).
        sx = cx + (xx - cx) * c + (yy - cy) * sn
        sy = cy - (xx - cx) * sn + (yy - cy) * c
        turned = sample(px, sx, sy)
        inside = ((sx >= 0) & (sx <= w - 1) & (sy >= 0) & (sy <= h - 1))[..., None]
        turned = np.where(inside, turned, 0)
        frame = turned * part[..., None] + px * (1 - part[..., None])
        strip.paste(Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8), 'RGBA'), (k * w, 0))
    strip.save(os.path.join(out, f'{name}.png'), optimize=True)
    print(f'{name:16s}{FRAMES} frames of {w}x{h}, sways {degrees} degrees about {neck:.0%} down')
    return f"'{name}': {{ src: '/world/ambient/{name}.png', frames: {FRAMES}, fps: 4, w: {w}, h: {h} }}"


def cyan(r, g, b, a, u, v):
    return (a > 60) & (b > 150) & (g > 140) & (b > r + 40)


def main():
    designs, dash = sys.argv[1], sys.argv[2]
    kit = os.path.join(dash, 'public', 'world', 'kit')
    out = os.path.join(dash, 'public', 'world', 'ambient')
    os.makedirs(out, exist_ok=True)
    p = pond(designs, out)
    sprites = [
        glow('holo-table', kit, out, lambda r, g, b, a, u, v: cyan(r, g, b, a, u, v) & (v < 0.62), bob=2.0),
        glow('water-station', kit, out, cyan, bob=0.0),
        sway('dish', kit, out, neck=0.6, degrees=9),
    ]
    with open(os.path.join(dash, 'src', 'world', 'ambient.generated.ts'), 'w') as f:
        f.write("// GENERATED by scripts/world/build_ambient.py — do not edit by hand.\n"
                "// Ambient motion: frames made from the drawn art, played all the time.\n"
                "export interface AmbientStrip { src: string; frames: number; fps: number }\n"
                "/** Over the terrain: `x`,`y`,`w`,`h` are fractions of the plate. */\n"
                f"export const AMBIENT_GROUND: Record<string, AmbientStrip & {{ x: number; y: number; w: number; h: number }}> = {{ pond: {p} }};\n"
                "/** In place of a structure's still sprite, by kit name. `w`,`h`: one frame, in the still sprite's own pixels (larger when the motion needs room). */\n"
                f"export const AMBIENT_PROPS: Record<string, AmbientStrip & {{ w: number; h: number }}> = {{ {', '.join(sprites)} }};\n")


if __name__ == '__main__':
    main()
