#!/usr/bin/env python3
"""
Build a section's art (QA or Triage) from the sheets generated with docs/qa-art-prompts.md or
docs/triage-art-prompts.md.

  hero.png            1600 x 400 banner, cropped to 4:1, saved as is (no key)
  module-*.png        square objects on a flat magenta key -> transparent, trimmed, 512 px
  empty-*.png         (same)

Every file is optional: a slot without art keeps the section's Night Glass fallback.

Usage: python3 scripts/world/build_qa_art.py <designs/<section> dir> <dashboard dir> [--section qa|triage|rewards]
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from build_world_kit import keyed  # the same magenta key as the map's props

BANNER = ('hero.png', (1600, 400))
SECTIONS = {
    'qa': ('module-runner.png', 'module-explorer.png', 'module-recorder.png',
           'empty-tests.png', 'empty-findings.png', 'empty-repairs.png', 'empty-journeys.png'),
    'triage': ('stage-intake.png', 'stage-triage.png', 'stage-code-check.png', 'stage-reproduce.png',
               'stage-fix.png', 'stage-pr.png', 'stage-follow-up.png', 'empty-board.png', 'paused.png'),
    # Reward medal emblems, one per family (dashboard components/rewards/RewardMedal.tsx).
    'rewards': ('features.png', 'epics.png', 'bugs.png', 'qa.png', 'clean.png', 'streak.png', 'ontime.png', 'fastfix.png'),
}
SQUARE = 512


def banner(src, size):
    """Centre-crop to the banner's ratio, then resize."""
    img = Image.open(src).convert('RGB')
    w, h = img.size
    want = size[0] / size[1]
    if w / h > want:
        nw = round(h * want)
        img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = round(w / want)
        img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    return img.resize(size, Image.LANCZOS)


def square(src):
    """Key out the magenta, trim to the object, and centre it on a transparent square."""
    img = keyed(src)
    box = img.getbbox()
    if box:
        img = img.crop(box)
    side = max(img.size)
    pad = round(side * 0.06)
    canvas = Image.new('RGBA', (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    canvas.paste(img, ((canvas.width - img.width) // 2, (canvas.height - img.height) // 2), img)
    return canvas.resize((SQUARE, SQUARE), Image.LANCZOS)


def main(designs, dashboard, section='qa'):
    out = os.path.join(dashboard, 'public', section)
    os.makedirs(out, exist_ok=True)
    built, missing = [], []
    name, size = BANNER
    if os.path.exists(os.path.join(designs, name)):
        banner(os.path.join(designs, name), size).save(os.path.join(out, name), optimize=True)
        built.append(name)
    else:
        missing.append(name)
    for name in SECTIONS[section]:
        src = os.path.join(designs, name)
        if not os.path.exists(src):
            missing.append(name)
            continue
        square(src).save(os.path.join(out, name), optimize=True)
        built.append(name)
    print(f'built {len(built)}: {", ".join(built) or "-"}')
    if missing:
        print(f'not yet generated ({len(missing)}): {", ".join(missing)} — the section shows its fallback for these')


if __name__ == '__main__':
    argv = sys.argv[1:]
    section = 'qa'
    if '--section' in argv:
        i = argv.index('--section')
        section = argv[i + 1] if i + 1 < len(argv) else ''
        argv = argv[:i] + argv[i + 2:]
    if len(argv) != 2 or section not in SECTIONS:
        sys.exit(__doc__)
    main(argv[0], argv[1], section)
