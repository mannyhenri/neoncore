# NeonCore Mobile

A React Native (Expo) companion app for the NeonCore orchestrator. Mirror what your
terminals are showing (Claude's live messages and questions) and control agents from your
phone — send prompts, switch autonomy mode, and answer approvals/questions.

**Scope (Phase 2 MVP):** LAN-only · mirror + full control · iOS + Android via Expo.
See [`../docs/mobile-app-research.md`](../docs/mobile-app-research.md) for the design.

## Run it

```bash
cd mobile
npx expo install        # aligns native deps to the Expo SDK
npx expo start          # then scan the QR with Expo Go, or press i / a
```

On first launch, enter your server URL — the `Network:` line from the NeonCore server's
startup banner, e.g. `http://192.168.1.50:4040`. Phone and server must be on the same Wi-Fi.

## Run it on a physical iPhone (TestFlight)

**You cannot use App Store Expo Go.** Expo Go only ever supports the *latest* SDK (57);
this app is on SDK 52. (The iOS simulator works because `expo start --ios` silently
downloads a legacy SDK-52 Expo Go build — that path doesn't exist for real hardware.)

Ship it to TestFlight instead:

```bash
npm i -g eas-cli
eas login                            # manny@gridlight.com
eas build -p ios --profile production   # ~15-20 min in the cloud
eas submit -p ios --latest              # uploads to App Store Connect
```

`eas build` prompts for your Apple credentials and provisions signing itself — you do
not need to touch Xcode or certificates. `eas submit` creates the App Store Connect app
record for `ai.gridlight.neoncore` on first run if it does not exist.

Then in App Store Connect → TestFlight, add yourself under **Internal Testing**.
Internal testing (your own team, ≤100 testers) needs **no App Review** — only the few
minutes of build processing. External testers *do* require review.

### What TestFlight changes

A TestFlight build is a **release** build: the JS is bundled in, so it does **not**
hot-reload from Metro. Rebuild + resubmit to ship changes. `version`/`buildNumber` live
in `app.json`; the `production` profile auto-increments the build number per build.

The app still talks to your NeonCore server over **plain HTTP on the LAN**, so the phone
must be on the same Wi-Fi as the Mac. This works in a release build only because
`NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription` are set in `app.json` — iOS
will show a one-time "allow local network access" prompt on first launch. Say yes, or
nothing will connect.

### Shipping a change without a rebuild (EAS Update / OTA)

JS and asset changes go straight to installed apps — no rebuild, no resubmit, no Apple
review:

```bash
eas update --branch production -m "what changed"   # ~30s; picked up on next app launch
```

**A rebuild is still required for native changes** — a new native module, anything under
`ios`/`android`/`plugins` in `app.json`, or an Expo SDK bump.

> ⚠️ **When you make a native change, bump `version` in `app.json`.**
>
> `runtimeVersion.policy` is `appVersion`, so the runtime version *is* `version` (0.1.0).
> OTA updates are only delivered to builds with a matching runtime version. If you ship a
> native change without bumping `version`, `eas update` will happily push JS that needs
> native code the installed binary does not have — and the app crashes on launch.
> Bumping `version` gives the new build a new runtime version, so old builds correctly
> stop receiving the incompatible JS.
>
> (The `fingerprint` policy automates this, but it is incompatible with
> `autoIncrement` — EAS bumps `ios.buildNumber` server-side mid-build, `buildNumber` is
> an input to the fingerprint, so local and EAS fingerprints never match and the build
> fails in the `Configure expo-updates` phase.)

### Iterating without any of this

For day-to-day work, use the simulator — it reloads instantly:

```bash
npx expo start --go --ios    # --go is required: expo-dev-client otherwise targets a dev build
```

## What it does

| Screen | Backed by |
|---|---|
| **Cartridge grid** — live cartridges only (offline behind a toggle), status, last message / pending question, approvals badge | `GET /api/agents` + `agent_updated` socket |
| **Cartridge detail** — message stream (tap any message for the full, unclamped content), command box, manual/plan/trust toggle | `GET /api/agents/:id/messages`, `transcript_event`, `POST /api/commands/send`, `PUT /api/trust/:id/mode` |
| **Approvals inbox** — allow/deny tool calls, approve plans, answer AskUserQuestion | `GET /api/permissions/pending`, `permission_requested`, `POST /api/permissions/decide` |
| **Workflows** (⚡) — run any workflow template with an optional brief; shows active runs | `GET /api/workflows?templates=true`, `?runs=true`, `POST /api/workflows/v2/:id/start` |

Messages render oldest → newest, newest at the bottom, auto-scrolling as they arrive —
the same reading order as the terminal. Expanding a message does not steal your scroll
position.

Live updates arrive over one Socket.io connection (`src/NeonCoreProvider.tsx`); REST calls
live in `src/api.ts`. Types are ported from `server/src/types.ts` into `src/types.ts`.

## Architecture notes

- **No auth** — matches the server's LAN-only posture. Add a bearer token here + on the
  server before any off-network (Tailscale/public) reach.
- **Message history** relies on `GET /api/agents/:id/messages` (added in Phase 2). Live
  events (`transcript_event`) are merged on top, deduped by id.
- **Navigation** is a lightweight state machine in `App.tsx` (no router dependency) — three
  screens don't warrant one. Swap for Expo Router if the surface grows.

## Not yet (Phase 3+)

Push notifications (Expo push / FCM-APNs), task queue + workflow control screens, off-LAN
connectivity, biometric lock. The server already fires ntfy pushes — subscribe the phone to
the ntfy topic today for background alerts.
