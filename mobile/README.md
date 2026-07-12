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

## Run it on a physical iPhone

**You cannot use App Store Expo Go.** Expo Go only ever supports the *latest* SDK (57);
this app is on SDK 52. (The iOS simulator works because `expo start --ios` silently
downloads a legacy SDK-52 Expo Go build — that path doesn't exist for real hardware.)

So you need a **development build** — your own Expo Go, pinned to this SDK, installed
once on the phone. After that, JS reloads over Wi-Fi exactly like Expo Go.

```bash
npm i -g eas-cli
eas login                                  # manny@gridlight.com
eas device:create                          # register the iPhone (UDID, via QR)
eas build -p ios --profile development     # ~15 min in the cloud; prompts for Apple creds
```

> **Requires a paid Apple Developer Program membership ($99/yr).** iOS ad-hoc /
> internal distribution can't provision a device without one. Free alternative:
> `npx expo run:ios --device` signs with a free personal team via Xcode — installs
> straight to the phone but the app **expires after 7 days** and must be re-signed.

The build finishes with a QR/link — open it *on the phone* to install. Then:

```bash
npx expo start --dev-client   # scan the QR with the Camera app
```

In the app, enter the Mac's LAN address (`http://<mac-ip>:4040`). The phone and the
NeonCore server must be on the same Wi-Fi — `--tunnel` tunnels *Metro*, not your server.

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
