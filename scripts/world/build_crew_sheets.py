#!/usr/bin/env python3
"""
Build the crew sprite atlases for the World view from the generated sheets in designs/.

Each engine has three source sheets (4 x 4 cells of 256 px on a flat key colour):
  base      idle / walk / standing work / wave
  floor     kneeling repair / tending soil / kneeling scan / sitting back
  attention one-arm wave / two-arm wave / calling out / jump

Rows used: idle, walk, work, kneel (scan), repair, tend, alert (one-arm wave), rest (sitting
back), call (calling out — a stuck agent), jump (a finished turn).

Output, per character:
  dashboard/public/world/crew/<character>.png — one ROW per animation in ATLAS_ROWS order,
  4 frames per row, 256 px cells, transparent background, feet on a common baseline and the
  character (not its prop) centred in the cell.
And once: dashboard/src/world/crewAtlas.generated.ts — the registry the scene reads (which
characters exist, and how far down each row's cell the figure starts).

A character belongs to an AGENT, not to an engine. To add one: save its three sheets in
designs/, add an entry to SOURCES, run this script.

Usage: python3 scripts/world/build_crew_sheets.py <designs dir> <dashboard dir>
"""
import sys, os
from PIL import Image
import numpy as np

CELL = 256
BASELINE = 246          # y of the lowest opaque pixel in every row
# Atlas row order — must match ANIMATION_NAMES order in dashboard/src/world/sheets.ts.
ATLAS_ROWS = [
    ('idle',   'base', 0),
    ('walk',   'base', 1),
    ('work',   'base', 2),
    ('kneel',  'floor', 2),
    ('repair', 'floor', 0),
    ('tend',   'floor', 1),
    ('alert',  'attention', 0),
    ('rest',   'floor', 3),
    ('call',   'attention', 2),
    ('jump',   'attention', 3),
]
SOURCES = {
    'mechanic': {
        'key': 'magenta',
        'base': 'Pixel-art-game-sprite-sheet-of-ONE-origi_walking.png',
        'floor': 'Pixel-art-game-sprite-sheet-of-the-SAME_working.png',
        'attention': 'Pixel-art-game-sprite-sheet-of-the-SAME.png',
    },
    'pilot': {
        'key': 'magenta',
        'base': 'Pixel-art-game-sprite-sheet-of-ONE-origi_walkingB.png',
        'floor': 'Pixel-art-game-sprite-sheet-of-the-SAME_workingB.png',
        'attention': 'Pixel-art-game-sprite-sheet-of-the-SAMEb.png',
    },
    'scout': {
        'key': 'green',
        'base': 'Pixel-art-game-sprite-sheet-of-ONE-origi_walkingC.png',
        'floor': 'Pixel-art-game-sprite-sheet-of-the-SAME_workingC.png',
        'attention': 'Pixel-art-game-sprite-sheet-of-the-SAMEc.png',
    },
}


def keyed(path, key):
    """Chroma-key a sheet to RGBA: soft edge, and the key colour spilled onto outlines removed."""
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    if key == 'magenta':
        keyness = np.minimum(r, b) - g
    else:
        keyness = g - np.maximum(r, b)
    alpha = np.clip(1.0 - (keyness - 60.0) / 70.0, 0.0, 1.0)
    spill = np.clip(keyness, 0, None) * (alpha > 0)
    if key == 'magenta':
        r = r - spill; b = b - spill
    else:
        g = g - spill
    out = np.dstack([np.clip(r, 0, 255), np.clip(g, 0, 255), np.clip(b, 0, 255), alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def body_centre(cell):
    """x of the character's centre: the widest solid run near the head, so a prop beside the
    figure (a machine, a sprout) does not drag the centre toward it."""
    a = np.asarray(cell)[..., 3] > 128
    rows = np.where(a.any(axis=1))[0]
    if len(rows) == 0:
        return CELL / 2
    top = rows[0]
    band = a[top + 8: top + 70]          # head and shoulders
    cols = np.where(band.any(axis=0))[0]
    return (cols[0] + cols[-1]) / 2 if len(cols) else CELL / 2


def build(engine, designs, outdir):
    src = SOURCES[engine]
    sheets = {k: keyed(os.path.join(designs, src[k]), src['key']) for k in ('base', 'floor', 'attention')}
    atlas = Image.new('RGBA', (CELL * 4, CELL * len(ATLAS_ROWS)), (0, 0, 0, 0))
    report = []
    for out_row, (name, which, row) in enumerate(ATLAS_ROWS):
        cells = [sheets[which].crop((c * CELL, row * CELL, (c + 1) * CELL, (row + 1) * CELL)) for c in range(4)]
        # One shift for the whole row, so the motion the artist drew between frames is kept.
        bottoms = [np.where((np.asarray(c)[..., 3] > 128).any(axis=1))[0].max() for c in cells]
        dy = BASELINE - int(np.median(bottoms))
        dx = int(round(CELL / 2 - float(np.median([body_centre(c) for c in cells]))))
        clipped = 0
        tops = []
        for c, cell in enumerate(cells):
            a = np.asarray(cell)[..., 3] > 128
            ys, xs = np.where(a)
            # Anything pushed outside the cell by the shift would be cut off.
            tops.append(ys.min() + dy)
            if xs.min() + dx < 0 or xs.max() + dx >= CELL or ys.min() + dy < 0 or ys.max() + dy >= CELL:
                clipped += 1
            frame = Image.new('RGBA', (CELL, CELL), (0, 0, 0, 0))
            frame.paste(cell, (dx, dy), cell)
            atlas.paste(frame, (c * CELL, out_row * CELL))
        report.append((name, dx, dy, clipped, max(0, min(tops)) / CELL))
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, f'{engine}.png')
    atlas.save(out, optimize=True)
    return out, report


if __name__ == '__main__':
    designs, dashboard = sys.argv[1], sys.argv[2]
    outdir = os.path.join(dashboard, 'public', 'world', 'crew')
    lines = [
        '// GENERATED by scripts/world/build_crew_sheets.py — do not edit by hand.',
        '// One entry per drawn character: its atlas, and per animation how far down the cell',
        '// (0–1) the figure starts, so the overhead panel can sit just above the head.',
        'export const CREW_ATLAS = {',
        f'  cell: {CELL},',
        '  frames: 4,',
        '  rows: [' + ', '.join(f"'{n}'" for n, _, _ in ATLAS_ROWS) + '],',
        '  characters: {',
    ]
    for character in SOURCES:
        out, report = build(character, designs, outdir)
        print(character, os.path.getsize(out) // 1024, 'KB', ' '.join(f'{n}(dx{dx:+d},dy{dy:+d},clip{c})' for n, dx, dy, c, _ in report))
        tops = ', '.join(f'{n}: {t:.3f}' for n, _, _, _, t in report)
        lines.append(f"    {character}: {{ src: '/world/crew/{character}.png', tops: {{ {tops} }} }},")
    lines += ['  },', '} as const;', '']
    with open(os.path.join(dashboard, 'src', 'world', 'crewAtlas.generated.ts'), 'w') as f:
        f.write('\n'.join(lines))
