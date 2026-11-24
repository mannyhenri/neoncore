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
| Signpost | The project's name, on the drawn board. The board is cut from the signpost art into a left end, a middle and a right end, and the middle stretches to the name (`scripts/world/build_signpost.py`; the sci-fi board is straightened first). The sign carries the name only, with the project's medals under it. **Features are not on the map**: their banners — ✦ name · stage · needs you, and the feature's seven badges — are in **the features HUD** along its bottom (`FeatureHud.tsx`), one per feature being built in every sector, with its project's colour (named when pointed at); those that need you first, then the furthest along. A click opens the feature. The bar hides and comes back (remembered in this browser, `neoncore.world.hud`), and closed it still says how many are running and how many need you. |
| Marker under the signpost | **Yellow, pulsing** = a feature of the project waits on you (the same rules as the "needs you" labels in Projects: `lib/featureStatus.ts`); **green** = features are in their pipeline and moving; none = nothing is in a pipeline. Hover lists the features, click opens the first one in Projects |
| Gauge and pennant | Deadline and delivery (`milestones.ts`), in a row with the marker beside the post's foot |
| Statue | A feature of the project has been delivered for 24 hours or more (hover: how many) |
| Freight | What is left to deliver: open crate = none (or nothing planned) · glowing crate = 1 · small cart = 2–3 · loaded cart = 4 or more |
| Fountain | Scenery: fills the bottom end of the landing field |

**A pod holds four.** A project with more than four agents on the map takes a second pod — the next district no project holds — and its signpost goes up there too (`zones.ts planAnnexes`, `buildingFor`). Each agent has a sticky place in its project (0–3 home, 4–7 the second pod…), and a feature's team takes its places together, so two features of one project work in two pods. With no district free, the extra agents share the pods the project has.

**Five or more projects: sectors.** The world has a district for four projects. Past that, the projects are spread over *sectors* ("provinces" in the fantasy theme) — the same world again, four projects each, oldest project first, so adding a project never moves one that is already there (`zones.ts planSectors`). One sector is on the map at a time; a switcher at the top of the map appears only when there is more than one, and each sector's tab names its projects, counts its agents and carries a badge when an agent there needs you — nothing waits unseen on a map you are not looking at. An agent is on the map of its own project's sector; one whose repo no project owns is on the open land of every sector. The status counts and the list always cover every agent. The sector you were on is remembered. **A sector keeps room to work**: a project with more than two repos counts for two districts (one agent per repo, two while a feature is built in a branch of each — eight agents, two pods of four), so its second pod is always on the same map, and the next project starts the next sector instead of squeezing it. A spot an agent was dragged to on open ground while its project had no district does not keep it away from the district the project has now; an agent of no project keeps any spot it was given.

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

**One column, the full width.** The project on screen is chosen from a dropdown in the bar at the top of the page (`ProjectPicker`, with "+ New project") — not from a list down the left side, which took the width the project's own page needs. The closed picker says when another project has features waiting on you ("+2 elsewhere"). A project's tabs are Roadmap · Design system · Features · Spec · Changelog · Architecture; the page opens on Features. **Roadmap is first** because it is where the project is planned before anything is built — and its features are the project's features, one and the same record: one added on the roadmap is in the Features list at once, and one added in Features waits in the roadmap's tray until it is given an epic. The roadmap deck names its project first thing, at the left of the vision bar (`data-roadmap-project`). (Design system: see below.) **The captain stays full size**: he stands at the left across the picker's bar and the head of the page (the title and repos move over for him — `.projects-stage`, `data-stage-head`); from the tabs down the page has the whole width. Reorganizing a screen never shrinks its character to an icon.

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

**Deadlines, delivery and badges** (`world/milestones.ts`). Each pod with a dated open feature has an oxygen gauge that drains toward the NEAREST target date (full → three-quarters → half → quarter, then a blinking red light under 10% of the time left, then empty and blinking once the date has passed). Each pod with planned features has a pennant that climbs its pole as they are delivered, and a flare goes up over the pod each time one more is. Each feature's banner in the HUD carries seven BADGES, one per step of the feature — scoped, questions answered, planned, plan accepted, staffed and running, built, delivered — lit as each step is passed. They reset when a new feature starts; after a delivery the full row stays until then. The captain adds three looks: keeping the log (work under way), celebrating (a delivery just landed), worrying (a date is tight or past). The airlock-barrier art is in the kit but unused: the records have no "depends on" link to drive it.

**Fireworks when a feature is marked done** (`components/Fireworks.tsx`, `lib/celebrate.ts`), on whatever screen you are on: seven rockets rise and burst over the page, a banner says "✦ Feature complete ✦" and the feature's name, and the *delivered* cue plays; gone after 5.6 s, never in the way of a click. Fired by every way a person marks a feature done — **Mark done** on the feature page, a drag to **Done** on the Board, the pipeline panel's Done step — once the server has accepted it. With reduced motion, the banner only.

## Themes — the same game in another world

A theme is an **art pack and a vocabulary**, nothing else: the same screens, the same records, the same
animations meaning the same states. **Settings → Themes** lists them; **one is in use for everyone**
(the server's `theme.active` setting). A browser follows it: on load it asks the server and, if it was
built with the other base, switches once (`lib/activeTheme.ts`; remembered in
`localStorage['neoncore.theme']`, read once when the page loads, so a switch reloads the page).

**Themes of your own — the theme creator** (`components/ThemesSettings.tsx`, `components/AssetBrowser.tsx`,
server `lib/custom-themes.ts`). Two themes are built in (*Neon Outpost* = `scifi`, *Guild Village* =
`fantasy`). Each card shows its captain and its home map, the badges *Built in* / *In use for
everyone*, and **Browse its assets** (built in) or **Edit its pictures and sounds** (yours),
**Duplicate** (asks for a name), **Use for everyone**, and for your own **Rename** and **Delete**.
The browser shows every picture and sound grouped — Captain, Bridge crew, Bridge decks, Crew on the
map, World map, Further maps, Map props, Ambient motion, Roadmap, Sounds (`lib/themeCatalog.ts`):
each with its path, a checkerboard preview, its size (and for a sheet "4 × 6 frames of 224 × 320"),
**Download**, and for a sheet **Show the N sets** (each row animated, by name). In a theme of your
own, **Replace…** fits the picture to the shape it replaces before anything is kept
(`lib/fitImage.ts`): a sprite sheet is cut into its grid, each frame trimmed and drawn at one scale,
bottom-centred; a map is cropped to cover; an icon is contained — with **Make a plain background
see-through** on by default (off for maps). You see the result, then **Use this**; **Revert to the
original** takes a replacement back. Sounds are kept as they are.

A theme of your own is a base (`scifi` or `fantasy`) plus replacements, stored in
`~/.neoncore/themes/<id>/` (`NEONCORE_THEMES_DIR`) with `theme.json`; the server serves each
replacement **at the original's own address** while that theme is in use (no-cache), so no screen
knows a picture was replaced. A replacement keeps the original's shape (a sheet its grid, a map its
proportions — everything on it is placed by fractions); it may be larger or smaller. Allowed: PNG,
JPEG, GIF, WebP, MP3, WAV, OGG, by their bytes, up to 20 MB, under `/world/ /sound/ /rewards/ /qa/
/triage/`. API: `GET/POST /api/themes`, `PUT /api/themes/active {id}`, `PUT/DELETE /api/themes/:id`,
`PUT /api/themes/:id/assets {path, dataBase64}`, `DELETE /api/themes/:id/assets?path=`,
`GET /api/themes/:id/files?path=` (to preview a theme not in use).

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

`world/roadmap/RoadmapChart.tsx` (Projects → a project → Roadmap). It is its own screen: it fills the work area over the project page (`RoadmapDeck` in `components/ProjectHub.tsx`; "← Board" goes to the four columns), on the theme's drawn deck. It has one view: **the Route**.

- **Vision** across the top: the sentence (click to edit), three half-ring gauges — Delivery (delivered), Scope (has a place on the chart), Readiness (not late) — and the destination.
- **The officer of the deck** at the left: `worry` when a feature is late, `log` when one is under way, else `idle`.
- **The Route** — the only view (a dated timeline of lanes and months was retired: it read as noise) (`RouteView.tsx`, `routeLayout.ts`) is the plan as a flight path: the project launches at the left and flies to its destination — the vision's planet — at the right, and every epic is a **stop** on the way, in plan order, alternately above and below the line so their names never meet. A stop is the epic's glyph in a ring that fills as its features are delivered, lit by where the epic stands: delivered (green; gold with a star when it was on time — a commendation), under way (blue, breathing), late (orange), waiting on another epic (amber, locked), planned (grey). The line behind the ship is solid green, the leg being flown is blue and moving, the rest is faint and dashed; the ship is where the project is now — at its stop once that epic has started, on the way to it before. Under the route, **the epic cards** (`EpicCards.tsx`): a summary line ("The route · 4 epics · 7 of 12 features done") and **+ New epic**, then one card per epic in plan order — its glyph, EPIC n and name, pills for its state, its date ("🎖 On time · due Dec 13, 2026", "Late · was due …", "Delivered 3 days after …") and what it waits on (struck through once met), its outcome, a progress bar, its features as chips (drag a chip onto another card to move the feature there), **+ Feature**, **Start next**, ← → to reorder, **Edit** and **Delete** (asks first; its features stay in the project). Selecting a stop highlights its card; features in no epic are listed after them. A plan with more stops than fit makes the route wider (it scrolls, opening on the ship) rather than tighter; with no epic yet the route runs straight to the destination with one button, "Plot the first epic on the route".
- **Top down: vision → epics → features.** "+ Add epic" is in the chart's header and "+ New epic" over the cards; every epic's card has "+ Feature" (a name and, if known, a target date — it is created in the project, in that epic). With no epic yet the route offers "Plot the first epic on the route".
- **An epic has a date and can wait on other epics.** **Edit** on its card sets its name, outcome and glyph, the day the whole epic is **due**, and the epics it **waits on** (any other epic of the project; never itself, never in a circle — the server refuses). Its card's pills say where it stands ("Due Dec 24, 2026", "Late · was due …", "Delivered 3 days after …", "🎖 On time · due …", "⛓ Needs Epic 2"), and its stop on the route is lit the same way. A waiting epic offers nothing to start — no "Start next" — until what it waits on is delivered.
- **The officer wears the project's rank** (see *Commendations and the captain's rank*): the plate under him shows it.
- **The selected waypoint's card**, bottom right: its epic, date and state, its summary, START (OPEN once it has started; disabled with the reason while it waits on another feature), and "Edit plan" for its epic, dates and what it waits on.

What it means and how it is planned with: `docs/PROJECT-SPEC.md`.

## Sound

Sparse on purpose: five interface sounds and ONE cue per kind of event — and no background loop or music: between sounds the app is silent. All fourteen files per theme are synthesized by `scripts/sound/build_sounds.py` (one palette: soft bell tones in D minor pentatonic; nothing sampled) and checked there for clipping, level and clicks.

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

**A set per theme.** The same fourteen sounds exist once per world theme, in the same key, and the page plays the set of the theme it was loaded with (`SOUND_PACKS`): sci-fi is soft bell tones with a little echo; fantasy is a medieval village in D dorian — a lute with paired strings, a hunting horn, a church bell, a hand drum, a tambourine and knocks on wood, in a stone hall rather than an echo. A cue means the same thing in both — "needs you" rises a fourth, "failed" falls a fourth, "stuck" is the same sound three times.

Rules (`lib/sound/cues.ts`, tested for every cue and every pair): nothing in the first 6 seconds after the page opens; the same cue is one sound however many arrive, and again only after its cooldown; a less important cue within 3 seconds of a more important one is dropped; at most 8 cues a minute, the four warnings (⚠) always get through; in a background tab only the warnings play.

Interface: a tap on buttons, tabs and switches, a brighter one on primary buttons, open / close for an agent's card on the map, and "sent" when a command goes out (which replaces that click's tap).

Controls: the speaker button beside the bell mutes everything; Settings → Sound has the volume, switches for interface sounds and event cues, and a Preview for each cue. Kept in this browser (`neoncore.sound`). A browser only allows sound after the first click on the page.

The server labels every bell notification with its kind — `needs-you`, `failed`, `finished`, `notice` (`server/src/lib/notification-kind.ts`); for an older server the kind is read off the title.

## Logs

**Logs** in the left bar, after Tokens (`components/LogsPage.tsx`; server `lib/log-stream.ts`,
`GET /api/logs`). One stream, newest at the bottom, of three kinds:

- **Events** — every machine's activity, read straight from the activity record.
- **Terminal** — output of background work NeonCore runs on this machine: QA runs (`qa · <host>`) and
  the repo commands it runs itself (source = the repo's folder). Cartridges run in their own visible
  terminals, so their output is not here.
- **NeonCore** — the server's own console (`installConsoleCapture`; warnings and errors are problems).

Each source is a chip in its own colour: a click hides or shows it, a double-click shows it alone.
Filters for the three kinds, **Problems only**, a search, and **Pause**. The stream follows the newest
line until you scroll up; scrolling to the top loads older lines (cursor paging, newest first). Kept:
the last 20,000 terminal and console lines (`pruneLogs`); events are as old as the activity record.

## A project's design system — step 1: the direction

Projects → a project → **Design system** (`components/DesignSystemTab.tsx`). The first step finds the project's direction; later steps build the system from it.

1. **Inspiration** — up to 8 pictures of interfaces the person likes (dropped or picked). Each is scaled down in the browser and its colours are read off it.
2. **Directions** — the designer answers with a round of FOUR directions. Each is a set of tokens (colours, heading and body type, corner radius, density, how surfaces are told apart) with a name and a reason, and is DRAWN: the same small piece of interface for every direction (`DesignPreview.tsx`), so what differs between two previews is the design.
3. **Keep designing** — comment on any direction, write what should change, optionally mark one "More like this", and ask for four more. A plain new round is four directions not shown just before; "More like this" is four takes on that one (refined, new type, accent forward, the other light/dark mode). Earlier rounds stay, folded away.
4. **Select** — one direction, from any round. It is shown at the top as the project's direction; it can be changed or undone.

Everything is kept with the project — pictures, every round, every comment, the selection (`server/src/lib/design-system.ts`, `GET/PUT /api/design-system/:projectId`). A server from before this existed answers "not found": then it is kept in the browser and the page says so.

**The designer is Claude's `/design`, run in the project's main repo** (server `lib/design-request.ts`). "Design 4 directions" sends one request to the Claude cartridge open on the project's primary repo; the request begins with `/design`, so Claude Code's own design command does the work there — it reads the inspiration pictures (written as files under `~/.neoncore/design/<project>/`, never into the repo) and the repo itself, and publishes a canvas of four artboards. It then answers through `neoncore_submit_design` with the canvas link and, for each direction, a name, a rationale and its tokens; those four are the round the page shows, and the round links to the canvas. The note, the comments on the round in front of you and "More like this" go with the next request. The page designs nothing itself: the Designer panel says which cartridge and repo will do it, or exactly why none can (no main repo, no Claude cartridge there, it is offline). A busy cartridge is not interrupted — the request waits and the page says so; a round that never arrives is said with its reason (not delivered, Claude ended its turn without submitting, 30 minutes passed, cancelled). `/design` needs Claude Code 2.1.233 or later, signed in with a claude.ai account.


**Step 2 — the system, and the repos** (`components/DesignSystemFinal.tsx`; server `lib/design-system-build.ts`, `lib/design-system-publish.ts`). Selecting a direction *finalizes* it: the server works the direction out in full — primary, accent and neutral scales (50–900), four meaning colours checked for contrast, a type scale, spacing, radius, shadow — and the page shows the result under the selected direction: the reference page itself in a sandboxed frame, the version, and the files. Selecting another direction makes the next version; the same direction again is the same version. Finalizing commits nothing.

**Publishing is one button, and only that button**: "Commit & push vN to N repos". For every repo of the project (its primary repo and its cartridges) the server writes `design-system/` — `tokens.json`, `tokens.css`, `components.css`, `index.html` (the reference page, self-contained), `DESIGN-SYSTEM.md` (the rules) — and a marked block in `CLAUDE.md` (and in `AGENTS.md` where the repo has one) telling agents to build with it; a later version replaces that block in place and touches nothing else in the file. Then **one commit of those paths only** — whatever else is modified, staged or untracked in the repo stays exactly as it was — and a plain push to the branch's upstream, never forced. Each repo answers for itself and one never stops the others: *Committed and pushed* · *Committed here, not pushed* (no upstream, or the push was refused — the reason is shown) · *Already up to date* · *Not published* (not a git repository, folder missing). When the system moves to a new version the panel says the repos are behind until it is published again. Finalizing is a calculation from the direction's tokens, not a model; the files, commits and pushes are real.


## Project rewards

A project earns **medals** as its own records pass thresholds (server `lib/project-rewards.ts`,
`GET /api/rewards`; dashboard `components/rewards/`). Nothing is awarded by hand and nothing is
stored: a medal is exactly as true as the records.

| Family | Counts | Tiers |
|---|---|---|
| Features delivered | features delivered (imported ones are history, not deliveries) | 1 · 5 · 10 · 25 · 50 · 75 · 100 |
| Epics delivered | epics whose every feature is delivered | 1 · 5 · 10 · 25 |
| Releases shipped | versions cut in the project's changelog | 1 · 5 · 10 · 25 |
| Bugs fixed | Triage issues merged or released, in the project's repos | 1 · 5 · 10 · 25 · 50 · 100 |
| QA runs | QA test runs finished against the project's app | 5 · 25 · 50 · 100 |
| Clean deliveries | features delivered with every acceptance criterion passing | 1 · 5 · 10 · 25 |
| Clean streak | the longest run of clean deliveries in a row | 3 · 5 · 10 |
| On time | features delivered on or before their target date | 5 · 10 · 25 |
| Fast fixes | bugs taken from report to pull request within an hour | 1 · 5 · 10 |

**The medal** (`RewardMedal.tsx`): a ring in the tier's metal — Bronze, Silver, Gold, Platinum,
Diamond, Legend, Mythic, in tier order — the family's emblem, and the threshold on a plate. Every
medal carries the project's name ("Gridlight AI — 10 features delivered"). An unearned medal is the
same medal dimmed, so the next one is always in sight. The emblem is an **art slot**
(`public/rewards/<family>.png`, built with `scripts/world/build_qa_art.py … --section rewards`);
until the art exists the slot shows a line icon.

**Where they show**: on the project's page, a Rewards row beside the captain — the highest medal of
each family, and "All rewards" opens the whole board with the count and the distance to the next
medal; on the map, the same highest medals hang under the project's signpost.

### Commendations and the captain's rank

An epic delivered **on or before its date** — every feature in it delivered by that day — is a
**commendation** for the project (`commend` family: one medal each for the first four, a star over
a ribbon). Late, undated, unfinished and empty epics are not. Each commendation promotes the
project's captain one rank (`RANKS` in `lib/project-rewards.ts`, `rankFor`):

| Commendations | 0 | 1 | 2 | 3 | 4+ |
|---|---|---|---|---|---|
| Rank | Captain | General | Commander | Admiral | President |

The medals are earned at 1, 2, 3, 4 and 10 commendations and named **General's Star**, **Commander's
Cross**, **Admiral's Anchor**, **Presidential Medal** and **Order of the Fleet**
(`COMMENDATION_NAMES`). Each is drawn as a laurel wreath and a red ribbon with the explorer statue in
the middle and its threshold on a plate (`components/rewards/Commendation.tsx`), named under it in the
trophy case; under the family, **the rank ladder** shows the five ranks with the current one lit and
those passed ticked.

The rank is the project's own and is counted, never set. It shows as a **rank plate** — five stars,
one lit per rank reached, and the title — under the captain on the Projects bridge (for the project
on screen) and under the officer of the roadmap deck; pointing at it says how many commendations the
project has and what the next rank takes (`world/bridge/rank.tsx`). **The costume is an art slot**:
`RANK_SHEETS` holds a captain sheet per rank (same rows and frames as `captain.png`); a rank whose
sheet is not drawn yet wears the captain's own, and the plate still says who he is.

The sci-fi captain has all four: **General** (olive field coat, gold epaulettes, red sash),
**Commander** (navy armour with cyan trim, half-cape), **Admiral** (white naval coat, gold braid,
peaked cap), **President** (black and gold coat, crimson cape, star medallion) — the same man, robot
and six cycles, drawn as `designs/captain-<rank>-sheet.png` + `-sheet-2.png` and built by
`scripts/world/build_bridge.py` into `public/world/bridge/captain-<rank>.png`. Costumes are read
from the theme's OWN registry (`costumesFor`): the fantasy guildmaster never borrows the sci-fi
captain's coat, and keeps his own until his are drawn.

### A new map to discover

Rewards also open the world. A **new map** unlocks when every project together has done all of:
10 features delivered · 5 epics delivered · 5 QA runs · 5 releases shipped · 5 features delivered on
time · 5 bugs fixed (`NEW_MAPS` in `lib/project-rewards.ts`; `GET /api/rewards/world`). Counts add
up across projects. It is unlocked the first time all six are true and stays unlocked — a feature
reopened later does not close a place that was discovered; the date is kept.

On the map, a chip beside the sector switch says how far it is ("🔒 New map · 4 of 6 done"); open,
it lists each requirement with its count and a bar. Unlocked, it reads "★ New map open".

**The maps.** Each theme has three (`theme.ts MAPS_BY_THEME`): its home map, an **interior**, and
**the isles**. The one unlock opens both extra maps.

| Theme | Home | Interior (four pods) | The isles (six pods) |
|---|---|---|---|
| Sci-fi | The outpost | Orbital station — four bays round the reactor | Sky isles — floating islands joined by light bridges |
| Fantasy | The village | The great hall — four chambers round the rune dais | Lagoon isles — islands joined by bridges |

A new map is the same world charted onto another painted terrain (`sites.ts charted`): the same
buildings, gates, work spots, bench, pond and landing pad by id, each given a position read off the
art, so every rule that holds on the home map (spacing, props clear of figures, nobody on the landing
field) is checked on all six by the same tests. The isles add two pods (`withSixPods`: districts
`p5`, `p6`), so a sector there holds six projects, or leaves a crowded project a neighbouring island.
Source art: `designs/terrain-station.png`, `designs/terrain-sky.png`, `designs/fantasy/terrain-hall.png`,
`designs/fantasy/terrain-lagoon.png`; served as `/world[/fantasy]/terrain-<map>.jpg`.

**Travelling.** A map still to earn is **not shown at all**: until the unlock, the progress chip is
the only sign of it. Once unlocked, the map switch (`MapSwitch.tsx`) appears at the top of the map,
before the sectors, listing the open maps; with only the home map open there is no switch. An open
map is travelled to: the whole crew works there from then on, and the choice is remembered
(`neoncore.world.map`). The world never opens on a locked map, even one remembered from before
(`resolveMap`). Dragged spots are kept per map. The moving water
is cut from the outpost's own art and plays there only.
