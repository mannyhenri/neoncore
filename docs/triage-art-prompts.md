# Triage section — art prompts (for Higgsfield)

Ten images for the Triage section. Generate each, save it under `designs/triage/` with the
file name given, then run
`python3 scripts/world/build_qa_art.py designs/triage dashboard --section triage`
with a Python that has Pillow and numpy (on this Mac: `/usr/local/opt/python@3.10/libexec/bin/python3`).
It sizes them, keys out the magenta and writes `dashboard/public/triage/`. Until a file exists, the
section shows a Night Glass fallback in its place, so they can arrive one at a time.

**Style — paste at the start of every prompt** (the same line as the QA section's, so both read as one place):

> Detailed 16-bit pixel art in exactly the same style as the existing NeonCore outpost art:
> crisp hand-placed pixels, no anti-aliased blur, no text, no letters, no logos. A sci-fi
> frontier outpost on an alien world: weathered rust-orange and brown riveted metal panels,
> hazard stripes, glowing teal and cyan screens and lights, warm amber accent lamps, a purple
> and violet dusk sky with alien plants where a background shows. Soft top-left light, gentle
> rim glow, rich but not oversaturated colours.

For the square pieces (2–10) also add:

> A single object centred on a perfectly flat, solid magenta (#FF00FF) background, nothing else
> in the frame, no floor, no shadow outside the object, generous empty margin on every side.

| # | File (in `designs/triage/`) | Size | Shown |
|---|---|---|---|
| 1 | `hero.png` | 1600 × 400 (4:1) | Banner at the top of the Triage section |
| 2 | `stage-intake.png` | 1024 × 1024 | Board column: Intake |
| 3 | `stage-triage.png` | 1024 × 1024 | Board column: Triage |
| 4 | `stage-code-check.png` | 1024 × 1024 | Board column: Code check |
| 5 | `stage-reproduce.png` | 1024 × 1024 | Board column: Reproduce |
| 6 | `stage-fix.png` | 1024 × 1024 | Board column: Fix |
| 7 | `stage-pr.png` | 1024 × 1024 | Board column: Pull request |
| 8 | `stage-follow-up.png` | 1024 × 1024 | Board column: Follow-up |
| 9 | `empty-board.png` | 1024 × 1024 | Board with no issues |
| 10 | `paused.png` | 1024 × 1024 | Shown while the pause switch is on |


## 1. `hero.png` — the bug bay (banner, 4:1)

> [style] A wide panoramic interior of a repair bay inside the outpost, seen from the front like a
> game backdrop. Left: a pneumatic intake tube drops glowing message capsules onto a sorting
> conveyor where a small robot arm sorts them into three bins (green, amber, grey). Centre: a
> containment chamber where a small, harmless glowing mechanical beetle (a "bug") is held in a
> teal scanning field, a magnifier drone examining it. Right: a clean workbench where a robot
> technician hands a sealed glowing patch cartridge to a waiting inspection hatch with a green
> light. Big windows along the back show the purple dusk sky. Keep the centre-left calm and darker
> so a title can sit over it. Wide 4:1 composition, no faces, no text.

## 2. `stage-intake.png` — Intake

> [style][magenta] A rust-metal pneumatic tube outlet dropping one glowing teal message capsule
> into a small catch tray with an amber "received" lamp.

## 3. `stage-triage.png` — Triage

> [style][magenta] A compact sorting machine with three small chutes (green, amber, grey lamps), a
> glowing capsule balanced on a little scale at its top.

## 4. `stage-code-check.png` — Code check

> [style][magenta] A hovering inspection drone with a single round teal lens projecting a small
> holographic panel of abstract code-like bars (no readable text), one bar highlighted amber.

## 5. `stage-reproduce.png` — Reproduce

> [style][magenta] A small glass containment dome on a rust-metal base holding a tiny glowing
> mechanical beetle, a red indicator lamp lit on the base (the bug, caught and repeatable).

## 6. `stage-fix.png` — Fix

> [style][magenta] A robotic arm with a fine soldering tip placing a small glowing teal patch
> plate onto a circuit board, two tiny warm sparks.

## 7. `stage-pr.png` — Pull request

> [style][magenta] A sealed rust-metal parcel with a glowing teal seal and an amber tag, resting
> on a small hover tray, waiting at an inspection hatch with a closed door.

## 8. `stage-follow-up.png` — Follow-up

> [style][magenta] A small satellite-dish beacon on a tripod with a green lamp, broadcasting soft
> teal signal rings upward (keeping the reporter informed).

## 9. `empty-board.png` — no issues

> [style][magenta] An empty, tidy sorting tray with three clean bins and their lamps all calm
> green, a small idle robot arm folded at rest beside it.

## 10. `paused.png` — everything paused

> [style][magenta] A big rust-metal lever switch pulled down to its stop, a large amber hazard
> lamp lit beside it, the machine next to it dark and still.
