# Session STATE — live snapshot

> Overwritten on each meaningful step. Read this FIRST on resume: it is
> "where we are right now." If its **Next step** looks stale, cross-check the
> tail of `journal.md` (append-only) to see what actually happened last.

- **Updated:** 2026-07-12
- **Branch:** `feature/dual-runtime-parity-eval`
- **Base:** `main`

## Goal
ACTIVE THREAD: **NeonCore mobile companion (Expo app in `mobile/`)** — mirror the
terminals and drive the orchestrator from a phone. Phase 2 (grid / detail /
approvals) was built on 07-11 but had only ever been proven to *bundle*. This
session ran it for real against a live server and extended it.

## Done this session (2026-07-12)
First real end-to-end run: iOS simulator (iPhone 16 Pro) + live NeonCore server
on :4040. History loads, socket `transcript_event`s stream in, all screens render.

- API contract verified by curl against the live server: `/api/health`,
  `/api/agents`, `/api/agents/:id/messages` (the Phase-2 endpoint), and
  `/api/permissions/pending` all correct. `content` being a JSON *string* and the
  message ordering both looked like bugs and are NOT — the route reverses to
  chronological and `seq` restarts per session.
- **Bug fixed:** `ConnectScreen.tsx:8` seeded the input *value* with the example IP
  `http://192.168.1.50:4040`, so first launch always pre-filled an unreachable URL.
  The correct `placeholder` was already there, dead. Now starts empty.
- **Bug fixed:** detail header clamped the back button to 80px → "‹ Cartridges"
  wrapped to two lines. Widened to 96px + `numberOfLines={1}`.
- **Feature:** cartridge list shows **live agents only** (4 of 23 here; 19 offline),
  with a "Show N offline" toggle.
- **Feature:** **tap any message to expand it** — tool bodies were hard-clamped at 6
  lines with no escape. Expanded = unclamped + selectable. Auto-scroll is gated on
  new messages so expanding no longer yanks the list to the bottom.
- **Feature:** **Workflows screen (⚡)** — lists the 20 templates, launches any with an
  optional brief, shows active runs. Server already had the whole contract
  (`GET /api/workflows?templates=true`, `POST /api/workflows/v2/:id/start` clones a
  template into a run); this was purely the missing client.
- EAS set up for physical-device builds: `expo-dev-client` + `eas.json`.

## Commits (branch feature/dual-runtime-parity-eval, NOT yet pushed)
- `d253484` mobile: live-only cartridges, full-message expand, workflow launcher
- `c5202a6` mobile: expo-dev-client + EAS config
- (plus 6 older unpushed commits incl. the 07-11 mobile app + heartbeats)

## Bug thread — "I can't answer questions on the phone" (FIXED, verified)
Two independent bugs; the FIRST diagnosis was wrong and the user correctly pushed back.

1. **THE actual cause** (`8436e77`): `NeonCoreProvider` called `refresh()` only on
   MOUNT. The socket `connect` handler just set `connected = true` and never
   re-fetched. Socket events are fire-and-forget (no replay), so any question raised
   while the phone was asleep/backgrounded was emitted into the void — on reconnect
   the UI said "live" but `permissions` was the stale mount-time array, so Approvals
   was EMPTY while the agent sat blocked. A phone drops its socket constantly, so
   this fired nearly every time. Fixed: refresh() on every reconnect + on AppState
   'active' + pull-to-refresh on Approvals.
   VERIFIED by inserting a pending permission straight into the DB (no socket emit),
   confirming the app stayed blind (no badge), then bouncing the server to force a
   reconnect WITHOUT remounting → badge appeared, answered from phone, server stored
   decision=allowed. (A fresh app launch proves nothing here — mount always refetched.)

2. **Real but NOT the reported symptom** (`d313882`): the hook waits ~10 min
   (POLL_TIMEOUT 120s x MAX_POLL_RETRIES 5) but the server expired pending permissions
   at **2 min**, so minutes 2-10 the agent blocked on a question no client could see.
   Raised server TTL to 15 min. Also `agents.pending_question` was never cleared →
   stale "❓" forever; now cleared on decide + an invariant sweep on boot/every 2 min.
   Also: questions are now answerable INLINE in the cartridge detail (PermissionCard
   extracted out of ApprovalsScreen), not just in the Approvals tab.

DECISION: user chose to LEAVE the agent wait at ~10 min (not extend for async phone
use). Server TTL 15 min correctly sits above it.

## ⚠️ Build 4 was REJECTED BY APPLE (ITMS-90725) — SDK 57 upgrade in flight (2026-07-13)
The submit worked; **Apple rejected the binary**. It never reached TestFlight, which is
why it never appeared on the phone — no amount of tester/group config would have helped.

> ITMS-90725: This app was built with the iOS 18.2 SDK. All iOS apps must be built with
> the iOS 26 SDK or later (Xcode 26+) to be uploaded to App Store Connect.

ROOT CAUSE: **the EAS build image follows the Expo SDK.** SDK 52's default image is
`macos-sequoia-15.3-xcode-16.2` → Xcode 16.2 → iOS 18.2 SDK. No `eas.json` tweak can fix
it: RN 0.76 does not compile against the iOS 26 SDK. The SDK itself had to move.

FIX (`e00f353`): **Expo SDK 52 → 57** (default image `macos-tahoe-26.5-xcode-26.6`).
- react 18.3→19.2, react-native 0.76.9→0.86.0 (**New Arch now mandatory**; svg /
  async-storage / socket.io all had New-Arch-ready versions — nothing to port)
- expo-* now **unified versioning** (all 57.x). typescript 5.6→6.0.
- top-level `splash` key REMOVED in SDK 57 → moved to `expo-splash-screen` plugin
- version 0.1.0 → **0.2.0** (runtimeVersion policy is appVersion; native change MUST
  bump it). buildNumber auto-incremented to **5**.
- Verified: `tsc --noEmit` clean, expo-doctor 20/20, iOS bundle exports (738 modules).
- Deliberately did NOT pin `image` in eas.json — `auto` tracks the SDK, so a pin would
  go stale the next time Apple raises the bar (the same trap that caused this).

LESSON: "submitted successfully" ≠ "on TestFlight". EAS scheduling the submit only means
Apple *received* it. Apple then validates the binary and can reject it by email. Always
confirm the build reaches **Ready to Test** in App Store Connect.

## TestFlight — build 4 (SUPERSEDED, rejected — see above)
EAS: **gridlight / manny@gridlight.ai**. Project `@gridlight/neoncore-mobile`
(projectId 58c8efd5-84b8-4476-8f92-fca6bf3bf691).
**Build 4 submitted to TestFlight.** App Store Connect app id **6790428906**
(bundle `ai.gridlight.neoncore`). ASC API key stored on EAS servers by the first
interactive submit ([Expo] EAS Submit HFuZptwEYS / P37RNR78AB).

`ascAppId` is now pinned in eas.json (`d21e74c`), so **build AND submit both run
non-interactively from here — no more Apple 2FA gate.**

### Update loop from now on
- **JS/UI/logic (≈everything): `eas update --branch production` → ~30s**, no rebuild.
- Native change (new module, SDK bump, app.json native keys): `eas build` + `eas submit`
  (~20 min).
- ⚠️ **RULE: bump `version` in app.json on any NATIVE change.** runtimeVersion policy is
  `appVersion`, so skipping it lets `eas update` push JS needing native code the
  installed binary lacks → crash on launch.

### Build failures worth remembering
- Build 3 died in CONFIGURE_EXPO_UPDATES: **`autoIncrement: true` is incompatible with
  `runtimeVersion.policy: "fingerprint"`**. EAS bumps `ios.buildNumber` server-side
  mid-build; buildNumber is an input to the fingerprint; local ≠ EAS fingerprint, always.
  Proved it with @expo/fingerprint (changing buildNumber changes the hash). Fixed by
  switching to the `appVersion` policy (`3ccb2f6`).
- The app had **no icon at all** — ASC rejects builds without a 1024x1024 no-alpha icon.
  Generated one (`8671d89`).
- Simulator now needs `npx expo start --go --ios` — expo-dev-client otherwise targets a
  dev build that isn't installed.

## Also outstanding
- **iOS first launch shows a one-time "allow local network access" prompt — MUST be
  accepted** or the app can't reach the server. Never appears in the simulator.
- Untested because they mutate real agents: **Send command**, **mode toggle**, and
  **RUN WORKFLOW** deliberately never fired against live cartridges. Test from the phone.
- `local` remote (localhost:3000) may be offline; `github` is the real one.

## Older thread (parked): crash-recovery subsystem
Recovery P1 shipped + pushed (`516058c`, `dec3195`). Parked next steps:
- P2: auto-recover Trust-mode agents in the reconciler + mass-crash throttle.
- P3 (optional): native `claude --resume` fast-path.
- Recovery was only unit-tested + typechecked; never verified against a live
  interrupted run.

## Open questions / blockers
- Apple Developer membership required for the EAS device build (see Next step).
