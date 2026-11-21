# NeonCore design — Night Glass

The dashboard's look. Every screen follows it, and new features are built in it from the start.
Reference canvas (all 14 screens): https://claude.ai/artifact/2UEYxNSgz4RZWyFzSVbTx2 ·
reference images: `design/`.

Enforced by `dashboard/src/__tests__/designGuard.test.ts`. That test fails if the retired
violet/pink look comes back. Run it with `cd dashboard && npx vitest run designGuard`.

**The iOS app follows the same design** (`mobile/src/theme.ts` holds the same tokens;
`mobile/src/__tests__/night-glass.test.ts` is its guard). It draws the same map and deck figures
from the same art and the same rules — see `mobile/README.md` → Look and art.

## Rules in one breath

Near-black page. Frosted dark panels with thin blue-grey borders. One accent, neon blue, that
**glows** on whatever is live. Ember orange means **needs you**. Progress is a **segmented
meter** (lit cells glow, unlit cells are outlines). No logo, no background image, no pixel
font, no sprites, no pink/purple gradients — with one exception, the World view (below).

## Tokens (`dashboard/tailwind.config.js`)

| Use | Class | Value |
|---|---|---|
| Page | `bg-ink` | `#04060C` |
| Panel / card | `bg-gl-surface` or `.glass-light` | `rgba(14,20,36,.62)` + `rgba(120,150,255,.14)` border |
| Dialog panel | `.glass-dark` | `#0A1020` + `rgba(120,150,255,.22)` border |
| Code / log well, inputs | `bg-gl-code`, `.glass-input` | `#050913` |
| Text, strong → muted | `text-gray-100` / `300` / `400` / `500` | `#E8EEFF` / `#C9D3EC` / `#A9B5D3` / `#8A97B8` |
| Accent (live, selected, primary) | `neon-*` (`neon-500` = `#5AAEFF`) | `violet-*` and `purple-*` are aliases of it |
| Needs you | `ember-*` (`ember-500` = `#FF8A3D`) | |
| Done / ok | `emerald-*` / `green-*` | `#4ADE80` |
| Failed / danger | `red-*` | `#FF6B6B` tints |
| Engines | Claude `#7CC4FF` · Codex `#2EE6D6` | engine pills only |

`gray`, `violet` and `purple` are re-pointed, so code written in the old palette renders in the
new colours. Prefer the semantic names (`neon`, `ember`, `gl-*`) in new code anyway.

**Type.** Inter for UI text (`font-sans`, base 16px). Space Grotesk for titles and big numbers
(`font-display`; h1–h3 get it automatically). JetBrains Mono for repo names, commits, times
and logs (`font-mono`).

## Components (`dashboard/src/index.css`, `components/SectionTitle.tsx`)

| Pattern | Use |
|---|---|
| `.panel-live` | the card that is running / selected: neon border + glow |
| `.panel-ask` | the card that needs the user: ember border + glow |
| `.btn-primary` | one main action per area (`+ Launch`, `▶ Run`, `Send`, `Create`) |
| `.btn-ghost` | secondary actions |
| danger button | `border border-red-400/45 text-red-200` outline, no fill |
| `.seg-on` / `.seg-off`, `<SegMeter pct cells />` | any progress: runs, goals, budgets, activity |
| `.neon-text` | the live step name and big % next to a meter |
| `<Eyebrow>` | small uppercase section labels (`ACTIVE RUNS · 2`) |
| status pill | `rounded-full px-2.5 py-1 text-xs font-semibold` + glowing 7px dot |
| filter / segmented group | `p-1 rounded-xl bg-gl-surface/70 border border-white/[0.08]`; selected = `bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]` |

**Shape.** Cards `rounded-[18px]`, dialogs `rounded-[22px]`, inputs and buttons
`rounded-[10px]`, pills `rounded-full`. Controls are at least 40px tall (44px where touched on a
phone). Layout uses flex/grid gaps (12–24px), never margins between siblings.

**Meters never invent progress.** A meter shows a number the data already has: completed
steps out of total, milestones signalled, tool calls in the last 30 minutes. If there is no
number, show no meter.

## The World view

The Agents screen is a scene: a pixel-art plate with one avatar per cartridge, each with a
panel over its head saying what it is working on (V3, 2026-11-18). This is the one place
pixel art is allowed, and the boundary is strict:

- **Pixel art** — the terrain plate, the scenery kit (`dashboard/public/world/kit/`) and the
  crew — is used only by `dashboard/src/world/`. No other screen uses it.
- **The plate is bare terrain; every building and machine is a placed sprite** (`sites.ts`
  `structures`), so scenery can carry meaning: the shuttle is on its pad only while a machine is
  online, and queued work is a stack of crates at the agent's feet.
- **Everything drawn over the scene is Night Glass**: overhead panels, filters, the cartridge
  card. Dark panel, thin border, neon when live, ember when it needs you, Inter and JetBrains
  Mono. No pixel font, even here.
- **Avatars are drawn sprite sheets, one per character** (`dashboard/src/world/sheets.ts`, images
  in `dashboard/public/world/crew/`, built by `scripts/world/build_crew_sheets.py`). A character
  belongs to an agent, not an engine: agents get different characters while the pool lasts. The
  engine is the coloured dot on the panel. No figure is ever drawn from code.
- **Figures can be dragged**; a moved agent stays where it was dropped (per browser) until it is
  double-clicked or positions are reset. In a crowd (more than eight) panels fold to the name.
- **Panels show only what the records say**: the agent's objective or task, and a meter only
  when a confer or a run gives a real fraction. Same rule as every other meter.
- **The list is always one click away** (Scene / List in the scene's controls). Anything you
  can do in the scene you can do in the list; hidden and virtual cartridges are list-only.

Enforced by the last two tests in `designGuard.test.ts`.

**The shared map.** The scene opens on one base (`OUTPOST` in `src/world/sites.ts`, plate id `base`): four districts around a central commons, a landing field to the east. Figures there are drawn at `figureScale` 0.55, and each plate carries its own `spacing` for the site-overlap test. Idle agents rest in the commons. The shuttle is a four-frame drawn animation (`shuttle-0..3`, `dust-0..3`): it lands when a cartridge is launched and leaves once the agent has stepped out. All of it is sliced from `designs/` by `scripts/world/build_world_kit.py`.

**Layers on the map**, bottom to top: terrain and water; scenery (buildings, props and their small name plates), sorted by where it stands; characters with their panels, always above all scenery and sorted among themselves the same way; project banners, above every character. A shuttle in flight and a delivery flare pass over the characters but under the banners.

**Ambient motion.** A few things on the map move all the time, tied to no event: the pond's water ripples and glints, the commons hologram drifts and pulses, the water station's tank glows. Their frames are made from the drawn art itself by `scripts/world/build_ambient.py` (the water is the terrain's own pixels, displaced; the glow is the sprite's own lit pixels) — nothing is drawn in code. Ambient motion never carries meaning: anything that means something still follows "one look per state".

**One look per state.** What a figure is doing IS its state, wherever it stands: busy with a tool = working; standing still, or sitting on the bench = idle; waving = needs you (approval, question, review, waiting); calling out = stuck; wiping its brow = its task just finished (working → idle or waiting, about 2 seconds, then it stands idle or waves); walking = it is going somewhere because something changed. No state borrows another's look (`anim.ts animationFor`, checked for every status × attention × posture). The drawn `jump` row is unused.

**Working is one of four cycles.** A working agent kneels, repairs, tends or stands with its tool, and changes to a different one every 40–90 seconds at its own pace (`props.ts workCycleAt` — from its key and the clock, so it looks the same in every window and the crew never changes all at once).

**Idle agents stand at their building — until they have been idle for 30 minutes.** Then they walk to the ONE bench, on the pond's north bank, and sit facing the water; new work sends them back. The bench has two seats (three put the figures and panels on top of each other): the two idle longest have them, anyone else stays standing where they are. "Idle since" is the agent's last activity when the map first sees it idle, and the moment it turned idle after that. A seated agent's unread answer is a small **Finished** chip (hover for the summary, click to read). Dragging is yours to keep: the spot you drop an agent on is where it stays, working or idle, until you double-click it home.

**What the records put on the map** (`world/props.ts`; each pod has three fixed spots in `sites.ts props`, clear of its work spots, buildings, gate and of each other — checked pair by pair):

| Prop | What it says |
|---|---|
| Signpost | The project's name, on the drawn board. The board is cut from the signpost art into a left end, a middle and a right end, and the middle stretches to the name (`scripts/world/build_signpost.py`; the sci-fi board is straightened first). A plaque under the post keeps the feature counts and the badges; with features running it is the name only |
| Marker under the signpost | **Yellow, pulsing** = a feature of the project waits on you (the same rules as the "needs you" labels in Projects: `lib/featureStatus.ts`); **green** = features are in their pipeline and moving; none = nothing is in a pipeline. Hover lists the features, click opens the first one in Projects |
| Gauge and pennant | Deadline and delivery (`milestones.ts`), in a row with the marker beside the post's foot |
| Statue | A feature of the project has been delivered for 24 hours or more (hover: how many) |
| Freight | What is left to deliver: open crate = none (or nothing planned) · glowing crate = 1 · small cart = 2–3 · loaded cart = 4 or more |
| Fountain | Scenery: fills the bottom end of the landing field |

**A project past the map's four districts** has no pod, but its agents still stand together: each such project camps around one open spot — the east road first, then the pond's banks (`zones.ts planCamps`).

**What drives the scene.** Every moving thing is tied to a record, and only a CHANGE animates (what is already true when the screen opens is simply drawn that way; nothing is drawn until machines and projects have loaded once):

| Record | On the map | Rule (code) |
|---|---|---|
| Project | ONE district, named on a plate — its agents are never split | oldest project first; repos share buildings when there are more repos than buildings (`zones.ts planZones`) |
| Repo of a project | a building; named on a plate only while it has no character on the map | `zones.ts` |
| Agent | works beside its repo's building and stands there when idle; no project → unclaimed land | `zones.ts placeByZone`, sticky |
| Feature under way | the district's gate opens (4 frames), shuts when none is | `featuresActive > 0` (`FeatureGate`) |
| Running confer | its participants stand at the commons table — only when they come from different pods (or no pod); a confer inside one project stays in its pod | `meeting.ts` |
| Machine | a landing pad named after it (no shuttle parked there) | `fleet.ts padsFor`, sticky; online = runner says so OR an agent is live on it |
| Cartridge launched | the shuttle flies in and lands on the machine's pad, the new agent steps out of the landing zone and walks to its building, the shuttle leaves | `WorldScene` `service`, `ShuttleCraft` |
| Session ends | the agent walks back to its machine's pad, the shuttle lands for it and leaves | `DepartingFigure` |

## Layout

Left view bar (Projects · Agents · Workflows · Tasks · Tokens; Guide and Settings at its foot; a bottom
tab bar on phones). Top bar: view title, burn pill, `+ Launch`, `+ New Repo`, fleet, bell
(right edge). Agents and Projects have a sticky left rail (Workflows / the goals list) beside
the working area. Tasks and Tokens are full width. On phones, the cartridges come before the
workflows.

## Bringing in feature drops written in the old look

1. Apply the drop on top of `main`. On conflict, **take their logic, keep our classes**:
   state, handlers, API calls and new fields come from the drop; class names and layout markup
   stay Night Glass.
2. `npx vitest run` must pass, including `designGuard`.
3. List the components the drop added or changed, screenshot them, and restyle only those
   against the reference canvas using the patterns above.
4. `npm run build` (writes `server/public`, which is what `:4040` serves).

## The Projects bridge

The Projects screen is dressed as a ship's operations deck (`dashboard/src/world/bridge/`): a drawn captain stands over the project list, the workspace sits in a console frame, and a strip of gauges (repos, spent, features) reads the selected project. What the screen does is unchanged — the list and workspace are the ordinary Projects components; the console look is CSS scoped to `.bridge` (index.css), so no other screen is affected.

The captain is a drawn sprite sheet with one look per state, like the crew: **calling** = the project in front of you needs you; **briefing** (tapping his board) = you just selected a project; **standing by** = nothing to say. No art, no figure: `scripts/world/build_bridge.py` builds him and the deck backdrop from `designs/captain-sheet.png` and `designs/bridge-deck.png`.

**The other decks.** Flows is the engine deck, Tasks is the cargo bay and Tokens is the power core, built the same way (`world/bridge/Decks.tsx`, `deckState.ts`): the page's own component in a console frame, a drawn figure beside it, gauges under it, all inside `.bridge`.

| Deck | Figure | Its looks, and what each means |
|---|---|---|
| Flows | engineer + helper robot | wrenching = a run is running; waving = a live run cannot go on without you; arms crossed = nothing running |
| Tasks | quartermaster + cargo drone | scanning a crate = a task is claimed or in progress; waving = a task failed in the last 6 hours; standing = nothing being worked |
| Tokens | reactor core + drone | low / steady / hot = the fleet's tokens per hour (steps at 1M and 20M); red base + drone alarm = quota nearly gone (provider says hold, or ≥ 85% used). The tank beside it holds what is LEFT of the quota |

**The core heats up as the quota runs out** (`coreHeat` in `deckState.ts`), laid over the drawn core as a tint, a glow and embers — one look per stage: under 80% used, nothing; **80–84% amber** ("Core heating up"); **85–89% orange**, more embers, with the drone's alarm ("Quota nearly gone"); **90% and up red**, a fast pulse, the core shakes and the tank turns red ("Core overheating"). The glow grows evenly from 80% to 90%. Reduced motion keeps the colours and drops the movement. Logging or removing a reading on the Tokens page updates the core at once.

**The workflow canvas** is the engine deck's schematic table (`.bridge.flow-canvas`, applied by `components/WorkflowCanvasEditor.tsx`, which is portalled out of the page and so names the scope itself). Steps are console tiles whose lamp and frame are their status (grey pending, cyan pulsing running, green done, red failed, dim skipped) and whose corner colour is their kind (decision amber, confer violet with a second outline, connector teal, gates blue/rose). Connections are glowing conduits that pulse while the run is live. The minimap is a radar scope, the grid is a blueprint, and the engineer stands at the corner with the same three looks as on the Flows page. Behaviour is untouched. `src/__tests__/flowCanvas.theme.test.ts` holds the editor and the CSS together.

**Deadlines, delivery and badges** (`world/milestones.ts`). Each pod with a dated open feature has an oxygen gauge that drains toward the NEAREST target date (full → three-quarters → half → quarter, then a blinking red light under 10% of the time left, then empty and blinking once the date has passed). Each pod with planned features has a pennant that climbs its pole as they are delivered, and a flare goes up over the pod each time one more is. The project's banner carries seven BADGES, one per step of the feature under way — scoped, questions answered, planned, plan accepted, staffed and running, built, delivered — lit as each step is passed. They reset when a new feature starts; after a delivery the full row stays until then. The captain adds three looks: keeping the log (work under way), celebrating (a delivery just landed), worrying (a date is tight or past). The airlock-barrier art is in the kit but unused: the records have no "depends on" link to drive it.

## Themes — the same game in another world

A theme is an **art pack and a vocabulary**, nothing else: the same screens, the same records, the same
animations meaning the same states. Settings → Theme chooses it; the choice is kept in this browser
(`localStorage['neoncore.theme']`) and is read once when the page loads, so choosing reloads the page.

| | `scifi` (default) | `fantasy` |
|---|---|---|
| Map | the outpost | the village (`VILLAGE` in `world/sites.ts` — the same sites, where the village art has them) |
| Crew | mechanic · pilot · scout | blacksmith · ranger · apothecary |
| Decks | captain · engineer · core · quartermaster | guildmaster · artificer · great crystal · storekeeper |
| Roadmap | star chart, destination planet, the ship | quest map, journey's end, the party |

- A pack keeps **the base pack's names** (sprite names, character ids, animation rows), so no screen knows
  which theme it draws. `world/theme.ts` is the only place that chooses: `PACK`, `PLATE`, `word()`.
- A piece a pack lacks is drawn from the base pack (or plainly), never left blank. Missing today: the
  fantasy Tokens backdrop (`designs/fantasy/crystal-chamber.png`).
- Build: `python3 scripts/world/build_theme_pack.py fantasy` and `python3 scripts/world/build_roadmap_art.py`,
  from the sheets in `designs/fantasy/`. Art is generated sheets, never figures drawn in code.
- The iOS app is not themed.

## The roadmap deck

`world/roadmap/RoadmapChart.tsx` (Projects → a project → Roadmap). It is its own screen: it fills the work area over the project page (`RoadmapDeck` in `components/ProjectHub.tsx`; "← Board" goes back to the four columns), on the theme's drawn deck.

- **Vision** across the top: the sentence (click to edit), three half-ring gauges — Delivery (delivered), Scope (has a place on the chart), Readiness (not late) — and the destination.
- **The officer of the deck** at the left: `worry` when a feature is late, `log` when one is under way, else `idle`.
- **The chart**: a whole calendar year of months with the TODAY pill and line; a bordered lane per epic (glyph, EPIC n, name, outcome); a node per feature — green filled = delivered, blue ring = under way, white ring = planned, orange ring with ⚠ = late — with its name tag under it. A lane's route is green up to its last delivery, blue from there to what is under way, faint beyond. Dotted lines are dependencies (orange while still blocking). Features with no date sit in "Not on the chart yet" under the lanes.
- **The selected waypoint's card**, bottom right: its epic, date and state, its summary, START (OPEN once it has started; disabled with the reason while it waits on another feature), and "Edit plan" for its epic, dates and what it waits on.

What it means and how it is planned with: `docs/PROJECT-SPEC.md`.

## Sound

Sparse on purpose: a quiet ambient loop (a steady drone, wind and distant pings — no hum), five interface sounds and ONE cue per kind of event. All fifteen files are synthesized by `scripts/sound/build_sounds.py` (one palette: soft bell tones in D minor pentatonic; nothing sampled) and checked there for clipping, level and clicks.

| Cue | Plays when |
|---|---|
| Needs you ⚠ | an approval, question or plan to review; a workflow or feature waiting on you |
| Agent stuck ⚠ | an agent looks stuck |
| Something failed ⚠ | a step, run or task fails, or a feature pipeline stops |
| Quota nearly gone ⚠ | the Claude quota crosses 90% (the core overheats), on any screen |
| Run finished | a workflow run completes, or a feature's report is ready |
| Feature delivered | a feature is delivered (the flare on the map) |
| Cartridge launched | a new cartridge comes online |
| Notice | any other workflow notice |
| Turn finished | an agent finishes its turn, or a task is done |

Rules (`lib/sound/cues.ts`, tested for every cue and every pair): nothing in the first 6 seconds after the page opens; the same cue is one sound however many arrive, and again only after its cooldown; a less important cue within 3 seconds of a more important one is dropped; at most 8 cues a minute, the four warnings (⚠) always get through; in a background tab only the warnings play. The ambient loop overlaps its copies so no loop point is heard, stops in a background tab and dips under every cue.

Interface: a tap on buttons, tabs and switches, a brighter one on primary buttons, open / close for an agent's card on the map, and "sent" when a command goes out (which replaces that click's tap).

Controls: the speaker button beside the bell mutes everything; Settings → Sound has the volume, the ambient level, switches for interface sounds and event cues, and a Preview for each cue. Kept in this browser (`neoncore.sound`). A browser only allows sound after the first click on the page.

The server labels every bell notification with its kind — `needs-you`, `failed`, `finished`, `notice` (`server/src/lib/notification-kind.ts`); for an older server the kind is read off the title.
