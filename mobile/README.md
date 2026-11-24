# NeonCore Mobile

A **native React Native** companion app for the NeonCore orchestrator. Its job is to **keep the
ball rolling on projects already under way**: see what needs you and clear it, see where each
project stands, and start what comes next — from your phone, over your LAN.

> **This app is not an Expo app.** It was ejected; `expo-updates`, EAS and Expo Go are gone.
> Updates now come **over the air from your own NeonCore server** (`npm run ota:publish`) — see
> [RELEASE.md](RELEASE.md) for that and for native builds (`npm run ios:release`).

**Scope:** LAN-only · iOS · no cloud relay, by design.

---

## Look and art

The app follows the dashboard's design, **Night Glass** (`docs/DESIGN.md`): near-black page, dark
panels with thin blue-grey borders, neon blue for what is live or selected, ember orange for what
needs you, segmented meters. Every colour comes from `src/theme.ts`; the mark is the **captain's
head in a neon ring** (from the dashboard's captain art) — on the app icon, the launch screen and
beside the name in the header. Regenerate every size from the art with
`python3 scripts/world/make_app_icon.py`.
`src/__tests__/night-glass.test.ts` fails if the retired violet/pink look or the old logo mark
comes back.

The drawn art is the dashboard's, not a second set: the **captain** on the Needs-you bridge panel
(calling when something waits on you) and on each project in its rank's costume, the seven
**feature badges** on every banner, and the **rank plate** (stars and title). Badges and captains
load from the server, so a custom theme shows on the phone too.

The badge list, the scenery sprite registry and the captain sheets are **imported from the
dashboard** (`dashboard/src/world/milestones.ts`, `kit.generated.ts`, `bridge/bridge.generated.ts`),
so the two cannot drift. The images are copied and halved by
`python3 scripts/world/sync_mobile_art.py` — run it after rebuilding the dashboard's art.

`npm run bundle:check` bundles the app with Metro without Xcode. Run it before an iOS build: it is
what catches an import Metro cannot follow.

## Run it locally

Requires Xcode and CocoaPods. From `mobile/`:

```bash
npm install
cd ios && pod install && cd ..
npm run ios              # builds and boots the simulator
```

On a **device**, open `ios/NeonCore.xcworkspace` in Xcode, pick your team, and run. Two things you
will have to change because they are hardcoded to the original developer account:

| Setting | Current value | What to do |
|---|---|---|
| `DEVELOPMENT_TEAM` | set in Xcode | Your own Apple Developer Team ID |
| Bundle identifier | `com.mannyhenri.neoncore` | Your own reverse-DNS identifier |

The Metro bundler starts with `npm start` if you want it separately.

---

## Connect it

1. Start a NeonCore server on your machine (`npm start` in the repo root)
2. Open the app and enter `http://<SERVER>:4040` — hostname or IP, whichever your network resolves
3. The rest of the fleet appears on its own; the phone adopts every peer the server advertises

If nothing appears, check the server answers **from the phone's network**:

```bash
curl http://<SERVER>:4040/api/health     # → {"status":"ok"}
```

---

## What's on the phone, and what isn't

Four tabs: **Needs you · Projects · In progress · Settings**.

| Tab | What it does |
|---|---|
| **Needs you** (home) | Everything waiting on you across every server, oldest first — agent permission requests, planner questions, plans to accept, tests to approve, stopped pipelines, merges, features to sign off — each with its one action right on the card. |
| **Projects** | Every project with its captain's rank and progress. Open one for its **Board** (To do · In Progress · QA · Done, with *Passed QA* per epic and *Mark done*) and its **Route** (epics with due dates, late/on-time, *Start next*). |
| **In progress** | The feature banners with their badges across every sector, and the cartridges working right now (tap one for its transcript). |
| **Settings** | Servers, the app version, and *Check for an update*. |

A **feature** opens on top: start it (intake prefilled, planner picked), answer the planner's
questions or leave them to the agents, accept or revise the plan, start the pipeline, resume it,
approve its tests, merge, mark it done (fireworks included).

The app is deliberately not a second dashboard: authoring (workflows, the queue, tasks, token
reports, goal drafting) stays on the desk.

---

## Push notifications

Approvals arrive as push, which is most of the point of carrying the app. This needs **APNs
configured on the server**, not in the app:

```bash
APNS_KEY_PATH=/path/to/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=XXXXXXXXXX
```

Use an **APNs Auth Key** from Apple Developer ▸ Keys ▸ Apple Push Notifications service. That is
*not* the App Store Connect upload key — different page, not interchangeable.

**Environment must match.** TestFlight and App Store builds use the **production** gateway; Xcode
debug builds use **sandbox**. The server defaults to production, with `APNS_SANDBOX=1` available.
Mismatching these is the classic "push works in Xcode, silent in TestFlight".

---

## Tests

No renderer is available in this test setup, so display logic lives in plain modules
(`src/goalDisplay.ts`) where it can actually be asserted on, and types carry more weight than usual.

```bash
npm test              # vitest
npx tsc --noEmit      # not optional — see below
```

Three guards exist because of bugs that shipped, and they are worth understanding before you
change anything:

- **`contract-drift.test.ts`** — fails if a local type is *stricter* than the shared contract in
  `@neoncore/client`. A field the server marks optional and mobile marks required does not fail the
  typecheck, it **removes** it: the unguarded read then compiles clean and crashes the screen at
  runtime. Import shared types; never hand-copy them.
- **`screen-loading.test.ts`** — every screen must reach a decided state. It proves a request to a
  silent server returns an error rather than hanging, against a **real socket**, because a mocked
  `fetch` that ignores `signal` would keep a mocked test green while the phone hung.
- **`navigation.test.ts`** — every tab renders a route. A missing screen is silence, not an error.

---

## Releasing

Build numbers, archiving and TestFlight upload: **[RELEASE.md](RELEASE.md)**.
App Store submission: **[../docs/APP-STORE-RELEASE.md](../docs/APP-STORE-RELEASE.md)**.

Because there is no OTA path, **every JS change needs a full build and upload**. Batch your fixes.
