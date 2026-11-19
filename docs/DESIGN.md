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
font, no sprites, no pink/purple gradients.

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

## Layout

Left view bar (Projects · Agents · Tasks · Tokens; Guide and Settings at its foot; a bottom
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
