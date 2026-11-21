#!/usr/bin/env python3
"""
Build the World view's scenery kit from the generated sheets in designs/.

  terrain  designs/Edit-this-pixel-art-sci-fi-outpost-scene.png → public/world/terrain.jpg
  kit      four sheets of structures and props on a flat magenta key → one transparent,
           trimmed PNG per object in public/world/kit/, plus src/world/kit.generated.ts
           (each sprite's pixel size, so the scene can place it without loading it first).

Usage: python3 scripts/world/build_world_kit.py <designs dir> <dashboard dir>
"""
import sys, os
from PIL import Image
import numpy as np

TERRAIN = 'A-much-larger-pixel-art-terrain-map-for.png'
# The map is drawn at 1344 px wide and the scene zooms to 4x, so it is enlarged here (2x,
# Lanczos + a light unsharp mask) rather than left to the browser to blur.
TERRAIN_SCALE = 2
# A sharper copy of the same map, when there is one: an AI upscale of TERRAIN saved under this
# name is used as it is, in place of the plain 2x enlargement. Same picture, more pixels.
TERRAIN_HD = 'terrain-4k.png'
# The map's own size: every position in sites.ts is written in these pixels.
MAP_W, MAP_H = 1344, 752


def terrain_image(designs):
    """The terrain at the size it is served: the HD copy if present, else TERRAIN enlarged."""
    from PIL import ImageFilter
    hd = os.path.join(designs, TERRAIN_HD)
    if os.path.exists(hd):
        img = Image.open(hd).convert('RGB')
        # An upscale can come back a few pixels off the map's shape: hold it to exactly 16:9-of-the-map.
        want_h = round(img.width * MAP_H / MAP_W)
        if abs(img.height - want_h) > 2:
            img = img.resize((img.width, want_h), Image.LANCZOS)
        return img, True
    src = Image.open(os.path.join(designs, TERRAIN)).convert('RGB')
    big = src.resize((src.width * TERRAIN_SCALE, src.height * TERRAIN_SCALE), Image.LANCZOS)
    return big.filter(ImageFilter.UnsharpMask(radius=1.4, percent=60, threshold=2)), False
# sheet file → (columns, rows, names in reading order)
SHEETS = {
    'Pixel-art-game-building-sheet-showing-th.png': (2, 2, ['greenhouse', 'habitat', 'generator', 'gate']),
    'Pixel-art-game-building-sheet-in-exactly.png': (2, 2, ['shuttle', 'pad', 'module', 'workshop']),
    'Pixel-art-game-prop-sheet-showing-the-sm.png': (3, 3, ['planter', 'tripod', 'water-station', 'hut', 'toolbox', 'dish', 'rover', 'tunnel', 'lamp']),
    'Pixel-art-game-prop-sheet-in-exactly-the.png': (4, 4, [
        'crate-1', 'crate-2', 'crate-3', 'crate-pile',
        'crate-open', 'crate-glow', 'cart-1', 'cart-3',
        'cell-full', 'cell-half', 'cell-low', 'beacon',
        'marker-green', 'marker-yellow', 'marker-red', 'sign',
    ]),
    # Animation frames: names ending -0, -1, … are one object at successive moments and are
    # trimmed to ONE shared box, so every frame sits in the same place.
    'Pixel-art-game-animation-sheet-of-the-SA.png': (4, 3, [
        'shuttle-0', 'shuttle-1', 'shuttle-2', 'shuttle-3',
        'flame-0', 'flame-1', 'flame-2', 'flame-3',
        'dust-0', 'dust-1', 'dust-2', 'dust-3',
    ]),
    'Pixel-art-game-animation-sheet-of-the-SA-door.png': (2, 2, ['gate-0', 'gate-1', 'gate-2', 'gate-3']),
    'Pixel-art-game-prop-sheet-in-exactly-the_items.png': (3, 3, [
        'holo-table', 'bench', 'bench-back', 'heater', 'dispenser', 'plant', 'banner', 'signpost', 'fog-pylon',
    ]),
    # What the records earn and warn of: the deadline gauge (8 levels, full to empty), the
    # airlock barrier (locked to open), the delivery flare and the pennant going up its pole,
    # and the rewards a base collects.
    'deadline-gauge.png': (4, 2, ['gauge-0', 'gauge-1', 'gauge-2', 'gauge-3', 'gauge-4', 'gauge-5', 'gauge-6', 'gauge-7']),
    'airlock-barrier.png': (4, 1, ['airlock-0', 'airlock-1', 'airlock-2', 'airlock-3']),
    'celebration.png': (4, 2, ['burst-0', 'burst-1', 'burst-2', 'burst-3', 'pennant-0', 'pennant-1', 'pennant-2', 'pennant-3']),
    'rewards.png': (3, 3, ['trophy', 'medal', 'insignia', 'statue', 'fountain', 'light-arch', 'signal-tower', 'crew-banners', 'garden']),
}
# Frames whose opening was painted black instead of the key colour: the black is flood-filled
# to transparent from the middle of the cell, so the ground shows through an opening gate.
OPENINGS = {'gate-1', 'gate-2'}


def keyed(path):
    """Magenta chroma key → RGBA with a soft edge and the pink spill taken off the outlines.
    A sheet saved with its background already removed keeps its own cut-out (the soft halo such
    a file carries is dropped)."""
    src = Image.open(path)
    if src.mode == 'RGBA' and (np.asarray(src)[..., 3] < 128).mean() > 0.3:
        a = np.asarray(src).copy()
        a[..., 3] = np.where(a[..., 3] >= 160, 255, 0)
        return Image.fromarray(a, 'RGBA')
    rgb = np.asarray(src.convert('RGB')).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    keyness = np.minimum(r, b) - g
    alpha = np.clip(1.0 - (keyness - 60.0) / 70.0, 0.0, 1.0)
    spill = np.clip(keyness, 0, None) * (alpha > 0)
    out = np.dstack([np.clip(r - spill, 0, 255), g, np.clip(b - spill, 0, 255), alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def clear_opening(cell):
    """Make the black doorway in the middle of a cell transparent (flood fill from its centre)."""
    from PIL import ImageDraw
    rgb = cell.convert('RGB')
    cx, cy = cell.width // 2, int(cell.height * 0.5)
    for y in range(cy, cell.height):                      # find a truly black pixel below centre
        if sum(rgb.getpixel((cx, y))) < 30:
            cy = y
            break
    else:
        return cell
    marker = (255, 0, 255)
    ImageDraw.floodfill(rgb, (cx, cy), marker, thresh=40)
    a = np.asarray(cell).copy()
    hole = (np.asarray(rgb) == np.array(marker)).all(axis=-1)
    a[hole, 3] = 0
    return Image.fromarray(a, 'RGBA')


# A THEME PACK (scripts/world/build_theme_pack.py) sets these: its art goes to
# public/world/<theme>/ and its registry to kit.<theme>.generated.ts as KIT_<THEME>.
THEME = ''


def main(designs, dashboard):
    import re
    from PIL import ImageFilter
    world = os.path.join(dashboard, 'public', 'world', THEME) if THEME else os.path.join(dashboard, 'public', 'world')
    kitdir = os.path.join(world, 'kit')
    os.makedirs(kitdir, exist_ok=True)
    big, hd = terrain_image(designs)
    big.save(os.path.join(world, 'terrain.jpg'), quality=88)
    print('terrain', (MAP_W, MAP_H), '->', big.size, f'(from {TERRAIN_HD})' if hd else '(2x enlargement - save an upscale as designs/terrain-4k.png for a sharper map)')

    sizes = {}
    for sheet, (cols, rows, names) in SHEETS.items():
        img = keyed(os.path.join(designs, sheet))
        W, H = img.size
        cells = {}
        for i, name in enumerate(names):
            c, r = i % cols, i // cols
            cell = img.crop((round(c * W / cols), round(r * H / rows), round((c + 1) * W / cols), round((r + 1) * H / rows)))
            cells[name] = clear_opening(cell) if name in OPENINGS else cell
        # One trim box per object: frames of the same object share the union of their boxes.
        boxes = {}
        for name, cell in cells.items():
            a = np.asarray(cell)[..., 3] > 128
            ys, xs = np.where(a)
            group = re.sub(r'-\d+$', '', name) if re.search(r'-\d+$', name) and not name.startswith(('crate', 'cart')) else name
            x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
            if group in boxes:
                bx = boxes[group]
                boxes[group] = (min(bx[0], x0), min(bx[1], y0), max(bx[2], x1), max(bx[3], y1))
            else:
                boxes[group] = (x0, y0, x1, y1)
            cells[name] = (cell, group)
        for name, (cell, group) in cells.items():
            x0, y0, x1, y1 = boxes[group]
            touching = x0 == 0 or y0 == 0 or x1 == cell.width or y1 == cell.height
            sprite = cell.crop((x0, y0, x1, y1))
            sprite.save(os.path.join(kitdir, f'{name}.png'), optimize=True)
            sizes[name] = sprite.size
            print(f'{name:14s} {sprite.size[0]:4d}x{sprite.size[1]:<4d}' + ('  TOUCHES ITS CELL EDGE — may be cut off' if touching else ''))

    lines = [
        '// GENERATED by scripts/world/build_world_kit.py — do not edit by hand.',
        '// Every scenery sprite in public/world/kit/, with its size in pixels.',
        f"export const KIT{'_' + THEME.upper() if THEME else ''} = {{",
    ]
    web = f'/world/{THEME}/kit' if THEME else '/world/kit'
    for name, (w, h) in sizes.items():
        lines.append(f"  '{name}': {{ src: '{web}/{name}.png', w: {w}, h: {h} }},")
    lines += ['} as const;', '']
    with open(os.path.join(dashboard, 'src', 'world', f"kit{'.' + THEME if THEME else ''}.generated.ts"), 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
