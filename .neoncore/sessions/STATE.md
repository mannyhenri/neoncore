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

## Next step — TestFlight (IN PROGRESS)
EAS logged in as **gridlight / manny@gridlight.ai**. Project created + linked:
`@gridlight/neoncore-mobile` (projectId 58c8efd5-84b8-4476-8f92-fca6bf3bf691,
owner `gridlight` — stamped into app.json, commit `889aff5`).

Repo is TestFlight-ready (`8671d89`): app icon (was MISSING entirely — ASC rejects
builds without a 1024x1024 no-alpha icon), splash, `ios.buildNumber`,
`ITSAppUsesNonExemptEncryption: false`, EAS production profile + submit block.

Remaining (INTERACTIVE — needs Apple ID + 2FA, user runs it):
1. `cd mobile && npx eas-cli build -p ios --profile production`  ← user running now
   (~15-20 min; registers the new bundle id `ai.gridlight.neoncore`)
2. `npx eas-cli submit -p ios --latest`   (creates the ASC app record if absent)
3. App Store Connect → TestFlight → Internal Testing (no App Review needed).

Note: TestFlight = RELEASE build → no Metro hot-reload; rebuild to ship changes. Keep
using the simulator for iteration. Phone must be on the same Wi-Fi as the server; iOS
shows a one-time local-network prompt on first launch that MUST be accepted (this
never appears in the simulator).

## Also outstanding
- Untested because it mutates real agents: **Send command**, **mode toggle**, and
  **RUN WORKFLOW** deliberately never fired against live cartridges.
- `git push` — 14 unpushed commits (remote is named `github`, not `origin`).

## Older thread (parked): crash-recovery subsystem
Recovery P1 shipped + pushed (`516058c`, `dec3195`). Parked next steps:
- P2: auto-recover Trust-mode agents in the reconciler + mass-crash throttle.
- P3 (optional): native `claude --resume` fast-path.
- Recovery was only unit-tested + typechecked; never verified against a live
  interrupted run.

## Open questions / blockers
- Apple Developer membership required for the EAS device build (see Next step).
