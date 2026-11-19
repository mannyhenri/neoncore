# NeonCore design — Night Glass

The dashboard's look. Every screen follows it, and new features are built in it from the start.
Reference canvas (all 14 screens): https://claude.ai/artifact/2UEYxNSgz4RZWyFzSVbTx2 ·
reference images: `design/`.

Enforced by `dashboard/src/__tests__/designGuard.test.ts`. That test fails if the retired
Gridlight look comes back. Run it with `cd dashboard && npx vitest run designGuard`.

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
| Engines | Claude `#7CC4FF` · Codex `#2EE6D6` · Gridlight `#FF7AC0` | engine pills only |

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

**One look per state.** What a figure is doing IS its state, wherever it stands: on the floor with a tool = working; standing still = idle; waving = needs you (approval, question, review, waiting); calling out = stuck; a jump = its turn just finished; walking = it is going somewhere because something changed. No state borrows another's look (`anim.ts animationFor`, checked for every status × attention × posture).

**What drives the scene.** Every moving thing is tied to a record, and only a CHANGE animates (what is already true when the screen opens is simply drawn that way; nothing is drawn until machines and projects have loaded once):

| Record | On the map | Rule (code) |
|---|---|---|
| Project | ONE district, named on a plate — its agents are never split | oldest project first; repos share buildings when there are more repos than buildings (`zones.ts planZones`) |
| Repo of a project | a building; named on a plate only while it has no character on the map | `zones.ts` |
| Agent | works AND rests beside its repo's building, whatever its status; no project → unclaimed land, resting in the commons | `zones.ts placeByZone`, sticky |
| Feature under way | the district's gate opens (4 frames), shuts when none is | `featuresActive > 0` (`FeatureGate`) |
| Running confer | its participants stand at the commons table | `meeting.ts` |
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
