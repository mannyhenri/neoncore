# QA section — art prompts (for Higgsfield)

Eight images for the QA section. Generate each, save it under `designs/qa/` with the file name
given, then run `python3 scripts/world/build_qa_art.py designs/qa dashboard` with a Python that
has Pillow and numpy, like the other world build scripts (on this Mac:
`/usr/local/opt/python@3.10/libexec/bin/python3`) — it sizes them,
keys out the magenta and writes `dashboard/public/qa/`. Until a file exists, the section shows a
Night Glass fallback in its place, so they can arrive one at a time.

**Style — paste at the start of every prompt:**

> Detailed 16-bit pixel art in exactly the same style as the existing NeonCore outpost art:
> crisp hand-placed pixels, no anti-aliased blur, no text, no letters, no logos. A sci-fi
> frontier outpost on an alien world: weathered rust-orange and brown riveted metal panels,
> hazard stripes, glowing teal and cyan screens and lights, warm amber accent lamps, a purple
> and violet dusk sky with alien plants where a background shows. Soft top-left light, gentle
> rim glow, rich but not oversaturated colours.

For the square pieces (2–8) also add:

> A single object centred on a perfectly flat, solid magenta (#FF00FF) background, nothing else
> in the frame, no floor, no shadow outside the object, generous empty margin on every side.

| # | File (in `designs/qa/`) | Size | Shown |
|---|---|---|---|
| 1 | `hero.png` | 1600 × 400 (4:1) | Banner at the top of the QA section |
| 2 | `module-runner.png` | 1024 × 1024 | Tests tab header and empty state |
| 3 | `module-explorer.png` | 1024 × 1024 | Findings tab header |
| 4 | `module-recorder.png` | 1024 × 1024 | Journeys tab header |
| 5 | `empty-tests.png` | 1024 × 1024 | Tests tab, no tests yet |
| 6 | `empty-findings.png` | 1024 × 1024 | Findings tab, nothing found |
| 7 | `empty-repairs.png` | 1024 × 1024 | Repairs tab, nothing to review |
| 8 | `empty-journeys.png` | 1024 × 1024 | Journeys tab, no recorded sessions |

## 1. `hero.png` — the QA lab (banner, 4:1)

> [style] A wide panoramic interior of a quality-assurance lab inside the outpost, seen from the
> front like a game backdrop. Left: a row of test bays where small boxy robot drones inspect
> glowing holographic web-page panels with scanning beams. Centre: a large curved console with
> three big screens: a checklist of glowing green ticks, a magnifying-glass radar sweep over a
> page map, and a playback timeline of footsteps. Right: a workbench with a robotic arm gently
> re-soldering a glowing circuit panel (self-repair), sparks small and warm. Big windows along the
> back show the purple dusk sky and distant outpost domes. Keep the centre-left calm and darker so
> a title can sit over it. Wide 4:1 composition, no characters' faces, no text.

## 2. `module-runner.png` — Runner (plain-language tests)

> [style][magenta] A floating holographic clipboard of numbered lines (abstract dashes, no
> readable text), each line with a small glowing green tick, hovering over a compact rust-metal
> projector base with teal lights; a tiny robotic arm with a wrench beside it tightens one bolt
> on the projector, hinting at self-repair.

## 3. `module-explorer.png` — Explorer (AI exploratory tester)

> [style][magenta] A small hovering scout drone with a single round teal camera eye and short
> antenna, projecting a cone of scanning light down onto a tiny floating map of connected page
> tiles; one tile glows red with a small warning spark (a bug found).

## 4. `module-recorder.png` — Recorder (tests from real usage)

> [style][magenta] A rust-metal tape-reel recorder unit with two glowing teal reels and an amber
> record lamp; from it a trail of glowing footprints winds upward and splits into three paths,
> the thickest path brightest (the most common journey).

## 5. `empty-tests.png` — no tests yet

> [style][magenta] An empty metal test bay: an open rust-orange crate with nothing inside but a
> soft teal glow, a blank holographic clipboard hovering above it waiting to be written on, a
> small idle robot drone resting beside it.

## 6. `empty-findings.png` — nothing found

> [style][magenta] A scout drone resting on a small landing post with its camera eye dimmed to a
> calm green, a tiny holographic shield above it with a check mark shape (no text): all clear.

## 7. `empty-repairs.png` — nothing to review

> [style][magenta] A tidy rust-metal toolbox, closed and latched, with a wrench and screwdriver
> neatly clipped on its lid and a small green status lamp lit: no repairs waiting.

## 8. `empty-journeys.png` — no recorded sessions

> [style][magenta] The tape-reel recorder unit, reels still, record lamp dark, a single faint
> footprint on a small glowing pad in front of it, waiting for the first visitor.

## Fantasy theme (optional, later)

The world map also has a fantasy village theme. If you want the QA section to follow it, generate
the same eight with this style line instead and save them under `designs/qa/fantasy/`: *"Detailed
16-bit pixel art, a cozy medieval fantasy village: warm timber and stone, brass fittings, glowing
blue rune light, candle-amber accents, a twilight sky."* Swap the drones for small brass
clockwork owls, the tape recorder for an enchanted quill and scroll, the toolbox for a
tinker's satchel.
