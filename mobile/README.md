# NeonCore Mobile

A **native React Native** companion app for the NeonCore orchestrator. Read what your agents are
doing, answer their approvals, launch workflows and unblock work — from your phone, over your LAN.

> **This app is not an Expo app.** It was ejected, and `expo-updates`, EAS and Expo Go are all
> gone. If you find instructions here or elsewhere that say `npx expo start`, `expo prebuild` or
> "OTA update", they are wrong — see [RELEASE.md](RELEASE.md) for why the eject was necessary and
> what replaced each piece.

**Scope:** LAN-only · iOS · no cloud relay, by design.

---

## Run it locally

Requires Xcode and CocoaPods. From `mobile/`:

```bash
npm install
cd ios && pod install && cd ..
npm run ios              # builds and boots the simulator
```

On a **device**, open `ios/NeonCore.xcworkspace` in Xcode, pick your team, and run. Two things you
will have to change because they are hardcoded to Gridlight's account:

| Setting | Current value | What to do |
|---|---|---|
| `DEVELOPMENT_TEAM` | `3AXRJ22S9P` | Your own Apple Developer Team ID |
| Bundle identifier | `ai.gridlight.neoncore` | Your own reverse-DNS identifier |

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

Six tabs: **Cartridges · Goals · Workflows · Queue · Tasks · Approvals**.

The app is deliberately not a second dashboard. It covers checking and unblocking; authoring stays
on the desk.

| On the phone | Left on the desktop |
|---|---|
| Read transcripts (long-press a message to copy) | — |
| Answer approvals and agent questions | — |
| Watch goals; pause, resume, mark achieved | Drafting and decomposing goals |
| Dispatch or cancel a task | Creating and editing tasks |
| Watch the queue; hold, start, retry an item | Pausing a whole lane |
| Launch a workflow or a Confer | Authoring workflows on the canvas |

The rule behind the split: a goal's intent reaches every working cartridge at dispatch, so
accepting an AI-drafted field is consequential writing rather than a glance. Long prose and
multi-field forms want a keyboard.

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
