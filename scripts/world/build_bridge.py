#!/usr/bin/env python3
"""Build the Projects bridge art: the captain's sprite atlas and the deck backdrop.

    python3 scripts/world/build_bridge.py designs dashboard

Reads (from the designs folder):
    captain-sheet.png    3 rows x 4 columns on flat magenta: idle / brief / call      (Projects)
    captain-sheet-2.png  3 more rows for the captain: log / celebrate / worry
    engineer-sheet.png   3 rows x 4 columns: idle / work / call                        (Flows)
    core-sheet.png       4 rows x 4 columns: low / normal / high / warn                (Tokens)
    quartermaster-sheet.png  3 rows x 4 columns: idle / work / call                    (Tasks)
    bridge-deck.png, engine-deck.png, core-deck.png, cargo-deck.png   the empty rooms (no interface, no characters)
Writes:
    dashboard/public/world/bridge/<sheet>.png   the keyed atlases (same grid, one shared trim box each)
    dashboard/public/world/bridge/deck*.jpg
    dashboard/src/world/bridge/bridge.generated.ts
Either input may be missing: what is missing is written as null and the screen does without.
"""
import sys, os
from PIL import Image
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_crew_sheets import keyed  # the same chroma key as the crew

# name -> (source file in designs/, the cycles in row order). Every sheet is 4 columns.
SHEETS = {
    # A character can be drawn over several sheets: they are stacked into one atlas.
    'captain': [('captain-sheet.png', ['idle', 'brief', 'call']), ('captain-sheet-2.png', ['log', 'celebrate', 'worry'])],
    'engineer': ('engineer-sheet.png', ['idle', 'work', 'call']),
    'core': ('core-sheet.png', ['low', 'normal', 'high', 'warn']),
    'quartermaster': ('quartermaster-sheet.png', ['idle', 'work', 'call']),
}
# deck (the view it belongs to) -> source file in designs/
BACKDROPS = {'projects': 'bridge-deck.png', 'workflows': 'engine-deck.png', 'tokens': 'core-deck.png', 'tasks': 'cargo-deck.png'}
COLS = 4
CELL_H = 320


def sheet(name, designs, out):
    parts = SHEETS[name] if isinstance(SHEETS[name], list) else [SHEETS[name]]
    ROWS, cells, cw, ch = [], [], 0, 0
    for i, (file, rows) in enumerate(parts):
        src = os.path.join(designs, file)
        if not os.path.exists(src):
            if i == 0:
                print(f'{file} not found - {name}: null')
                return 'null'
            print(f'{file} not found - {name} has no {"/".join(rows)}')
            continue
        img = keyed(src, 'magenta')
        w, h = img.size
        pw, ph = w / COLS, h / len(rows)
        if i > 0 and (abs(pw - cw) > 2 or abs(ph - ch) > 2):
            # A later sheet drawn on a different grid: bring its cells to the first sheet's size.
            img = img.resize((round(cw * COLS), round(ch * len(rows))), Image.LANCZOS)
            pw, ph = cw, ch
        cw, ch = pw, ph
        ROWS += rows
        cells += [[img.crop((round(c * pw), round(r * ph), round((c + 1) * pw), round((r + 1) * ph))) for c in range(COLS)] for r in range(len(rows))]
    # One trim box for every cell, so the figure does not jump between frames or cycles.
    box = None
    for row in cells:
        for cell in row:
            b = Image.fromarray((np.asarray(cell)[..., 3] > 40).astype(np.uint8) * 255).getbbox()
            if b:
                box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    pad = 6
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(round(cw), box[2] + pad), min(round(ch), box[3] + pad))
    bw, bh = box[2] - box[0], box[3] - box[1]
    fw = round(bw * CELL_H / bh)
    atlas = Image.new('RGBA', (fw * COLS, CELL_H * len(ROWS)), (0, 0, 0, 0))
    for r, row in enumerate(cells):
        for c, cell in enumerate(row):
            atlas.paste(cell.crop(box).resize((fw, CELL_H), Image.NEAREST), (c * fw, r * CELL_H))
    atlas.save(os.path.join(out, f'{name}.png'), optimize=True)
    touching = box[0] == 0 or box[1] == 0 or box[2] >= round(cw) or box[3] >= round(ch)
    print(f'{name:9s}{COLS}x{len(ROWS)} cells of {fw}x{CELL_H}' + ('   TOUCHES ITS CELL EDGE - may be cut off' if touching else ''))
    rows = ', '.join(f"{n}: {{ row: {i}, frames: {COLS} }}" for i, n in enumerate(ROWS))
    return f"{{ src: '/world/bridge/{name}.png', frameW: {fw}, frameH: {CELL_H}, rows: {{ {rows} }} }}"


def backdrop(view, designs, out):
    src = os.path.join(designs, BACKDROPS[view])
    if not os.path.exists(src):
        print(f'{BACKDROPS[view]} not found - {view} backdrop: null')
        return 'null'
    img = Image.open(src).convert('RGB')
    img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS) if img.width < 1800 else img
    name = 'deck.jpg' if view == 'projects' else f'deck-{view}.jpg'
    img.save(os.path.join(out, name), quality=88)
    print(f'backdrop {view}: {img.size}')
    return f"'/world/bridge/{name}'"


def main():
    designs, dash = sys.argv[1], sys.argv[2]
    out = os.path.join(dash, 'public', 'world', 'bridge')
    os.makedirs(out, exist_ok=True)
    sheets = ', '.join(f"{n}: {sheet(n, designs, out)}" for n in SHEETS)
    drops = ', '.join(f"{v}: {backdrop(v, designs, out)}" for v in BACKDROPS)
    ts = os.path.join(dash, 'src', 'world', 'bridge', 'bridge.generated.ts')
    with open(ts, 'w') as f:
        f.write(HEADER + f"export const DECK_ART: {{ sheets: Record<string, DeckSheet | null>; backdrops: Record<string, string | null> }} = {{\n  sheets: {{ {sheets} }},\n  backdrops: {{ {drops} }},\n}};\n" + FOOTER)


HEADER = """// GENERATED by scripts/world/build_bridge.py — do not edit by hand.
// A sheet or backdrop whose art is not in designs/ is null: that deck shows its panels and no figure.
export interface DeckSheet {
  src: string;
  frameW: number;
  frameH: number;
  rows: Record<string, { row: number; frames: number }>;
}
export type CaptainSheet = DeckSheet;
"""
FOOTER = """/** The Projects bridge's own art, by its first names. */
export const BRIDGE: { captain: DeckSheet | null; deck: string | null } = { captain: DECK_ART.sheets.captain, deck: DECK_ART.backdrops.projects };
"""


if __name__ == '__main__':
    main()
