# Unused art — what is drawn but not on screen

Art that ships in the dashboard but nothing shows, or was drawn and never built in. A menu for
future events. Taken on 2026-11-21, after the map props, bench, signpost and markers went in.

**How it was counted:** every key in `dashboard/src/world/kit.generated.ts` (87) was matched
against all non-generated, non-test source, including names the code builds from parts
(`gate-${frame}`, `gauge-${frame}`), and with position names such as `at('sign')` not counted as
use. Duplicates were found by comparing file contents (MD5).

## 1. Props built in but never placed (22 of 87) — `unused-art-props.png`

| Prop | What it is | Idea for an event |
|---|---|---|
| `airlock-0…3` | Barrier from locked (red, padlock) through unlocking to open | Beside an agent waiting on a permission: locked while it waits, plays open on Approve, stays red and fades on Deny |
| `flame-0…3` | Flame / comet streak | A failed step or run |
| `beacon` | Tripod with a red warning light | Something needs you and the tab is in the background |
| `toolbox` | Open toolbox | At an agent's feet when its work is flagged `needs_review` (stopped without a completion report) |
| `rover` | Six-wheel rover | Drives from the commons to a pod when a queued task is sent there |
| `tunnel` | Glass tunnel | Links two pods while a confer or an *Epic: Two Repos* run spans both projects |
| `lamp` | Street lamp | Along the paths, lit while a scheduled workflow runs, or in your local evening |
| `sign` | Holo sign | Under a pod's signpost: the feature under way or the next scheduled workflow |
| `gate`, `shuttle` | Still versions of the gate and shuttle | — the map plays their animated versions |
| `signpost` | Whole signpost | — the map uses it cut into three pieces (`build_signpost.py`) so the board fits the project name |
| `bench-back` | Bench seen from behind | — the bench by the pond faces you |
| `hut`, `dispenser`, `plant`, `fog-pylon` | Scenery | Fill for empty districts |

## 2. Crew animations drawn but never played — `unused-art-crew.png`

- **`jump`** — every crew member (mechanic, pilot, scout). It used to play when a task finished;
  `rest` (wiping the brow) took that moment. Free for a celebration, e.g. a feature delivered.

Every other row is used: four work cycles picked at random (`work`, `kneel`, `repair`, `tend`),
`rest` after a task, `sit` on the bench after 30 minutes idle. Every animation of the captain,
engineer, quartermaster and core is in use.

## 3. Drawn but never built into the app

- `designs/Pixel-art-character-design-sheet-for-an.png` — 8 characters, of which 3 became the
  crew. The other 5 (scientist, engineer, medic, clipboard worker, commander) have one standing
  pose each and need full animation sheets before they could be used.
- An indoor lounge / commons scene in the concept art, never built as a map.

## 4. Leftovers

- `public/world/ambient/holo-table-anim.png` and `water-station-anim.png` — byte-for-byte copies
  of `holo-table.png` and `water-station.png`, which are the ones used.
- `public/world/ambient/pond-anim.png` — an alternative pond ripple; `pond.png` is used.
- The Tailwind `glow-pulse` animation (`dashboard/tailwind.config`) — nothing uses it.
