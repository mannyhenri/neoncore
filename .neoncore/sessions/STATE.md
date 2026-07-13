# Session STATE — live snapshot

> Overwritten on each meaningful step. Read this FIRST on resume: it is
> "where we are right now." If its **Next step** looks stale, cross-check the
> tail of `journal.md` (append-only) to see what actually happened last.

- **Updated:** 2026-07-13
- **Branch:** `main` (feature branch merged + deleted; `dev` deleted — main is the default)
- **Working tree:** clean, pushed

## Where we are
Mobile companion is **DONE and user-tested** (~2h of real device testing, 2026-07-13).
The mobile thread is CLOSED unless bugs surface.

**NEXT THREAD (user's words): test NeonCore driving *Gridlight* — their own AI —
"to see how it breathes with our own ai." Nothing started yet. More detail coming
from the user.**

## Shipped 2026-07-13
### Apple / TestFlight — the actual blocker
Build 4 was **rejected by Apple** (ITMS-90725: built with iOS 18.2 SDK, requires iOS 26).
It never reached TestFlight — that's why it never appeared on the phone. NOT a
tester/group problem. **The EAS build image follows the Expo SDK**: SDK 52 →
`macos-sequoia-15.3-xcode-16.2`. No eas.json tweak fixes it (RN 0.76 can't compile
against the iOS 26 SDK) — the SDK had to move.
→ **Expo SDK 52 → 57** (React 19, RN 0.86, New Arch mandatory). Zero source changes.
Build 5 (0.2.0) accepted, installed, working.
**HABIT WORTH KEEPING:** before submitting, `unzip` the IPA and PlistBuddy
`Payload/*.app/Info.plist` → check `DTSDKName` / `DTXcode`. Turns a 30-min round trip
through Apple's email into a 5-second local check. That's how build 5 was verified.

### Mobile OTA loop (works, use it)
`cd mobile && npx eas-cli update --branch production --environment production`
- ⚠️ `--environment` is REQUIRED in `--non-interactive` (undocumented).
- ⚠️ `fallbackToCacheTimeout: 0` → **relaunch the app TWICE** (1st downloads, 2nd runs).
- ⚠️ Native dep = new binary + Apple round trip. **Keep everything pure JS.** This is why
  the markdown renderer was hand-written (`src/components/Markdown.tsx`) and why
  `react-native-safe-area-context` was avoided.
- ⚠️ RULE: bump `version` in app.json on any NATIVE change (runtimeVersion policy is
  appVersion) or OTA ships incompatible JS to the old binary → crash.

Shipped OTA: newest-first transcript, tab-bar/input-bar safe-area gap, keyboard covering
the prompt input, markdown rendering. All user-verified on device.
**Approvals scrolling was NOT broken** — simulated 7 pending approvals incl. a
4-question AskUserQuestion; both intra-card and list scrolling work. No fix needed.

### Agent lifecycle — cartridges no longer vanish while in use
Death is now **reported, not inferred from silence**:
- NEW **`SessionEnd` hook** → `POST /api/agents/session-end`. (`Stop` fires every TURN —
  it can never mean "dead". That's why a 5-min timeout was standing in for a death signal.)
- socket disconnect / relay SIGTERM (already existed)
- **24h zombie reaper** for sessions killed without firing any of the above.
The 5-min idle→offline sweep is DELETED. Idle agents stay visible.
Two things this surfaced, both fixed:
1. `last_seen` was being CORRUPTED (the idle sweep overwrote it with now()).
2. Recovery was COUPLED to `status='offline'` — stretching that to 24h would have blinded
   crash recovery for a day. Now keys off activity staleness (`EXECUTOR_STALE_MS`).
   **2 regression tests pin this.** 20/20 server tests pass.

### The DHCP footgun (cost ~3 days of a Mac being silently offline)
`NEONCORE_URL` is **baked as a literal string** into `~/.claude/settings.json` at install
time and NEVER re-read. A DHCP lease change silently orphans an agent machine — no error
on either side, the cartridge just stops appearing.
→ Always install with `--server-url http://<hostname>:4040`, never a raw IP.
Diagnose: `grep -o 'NEONCORE_URL=[^ ]*' ~/.claude/settings.json`

## Dismiss a cartridge — SHIPPED + device-verified (2026-07-13)
Swipe right on mobile / ✕ on the web card = "I'm done with this one for now." Does NOT stop
the agent or end the session. It comes back **automatically** on any activity from that
session, or when you send it a command / start a workflow. Manual restore from a "Hidden"
section on both clients.

**KEY DESIGN — do not undo this.** Dismissal is a SEPARATE COLUMN (`agents.dismissed_at`),
not a new `status` value. `status` = liveness; `dismissed_at` = the user's view preference.
They are orthogonal — a hidden cartridge is very often still `working`, and the Hidden list
shows "still working" beside it to make that visible. Conflating them is exactly the bug
that made live cartridges vanish mid-session (`offline` meaning both "quiet" and "hide it").

Auto-revive hangs off two choke points:
- `register()` — every hook tool call passes through it → clears `dismissed_at`.
- `sendCommandToAgent()` — activity YOU originate, which lands before any hook fires. Must
  ALSO emit `agent_updated`, or the agent un-hides in the DB while the grid keeps hiding it.

Two traps found and fixed while building it:
- The web ✕ **already existed and ran a cascading DELETE with no confirm**, sitting exactly
  where a user expects "close". ✕ is now dismiss; delete moved to a trash icon + confirm.
- The empty-grid early-return rendered BEFORE the Hidden section → dismissing everything
  would have stranded the user with "INSERT CARTRIDGE" and no way to restore.

**MOBILE SWIPE GOTCHA (cost a round trip):** the card is a `TouchableOpacity`, which grabs
the responder the instant a finger lands. A PanResponder that only asks in the BUBBLING
phase (`onMoveShouldSetPanResponder`) is never consulted → every swipe silently did nothing.
Must claim in the **CAPTURE** phase (`onMoveShouldSetPanResponderCapture`), plus
`onPanResponderTerminationRequest: () => false` so the FlatList can't yank it back mid-swipe.
Built on RN core PanResponder + Animated, NOT react-native-gesture-handler — that ships
native code and would force a new binary. Stays pure JS → OTA-able.

**DEBUGGING TRICK WORTH REUSING:** to tell "the OTA didn't land" apart from "the feature is
broken", create a throwaway agent and dismiss it server-side. The "Show N put away" UI only
exists in the new bundle, so seeing it *proves* the phone is running the new code. Separated
the two failure modes in one shot.

## Outstanding (not blocking)
- **Other Mac + Windows box need re-bootstrapping** from the fresh zips in `dist/`
  (`./scripts/package.sh`). They carry BOTH the `SessionEnd` hook and the corrected URL.
  Existing sessions keep old hooks — hooks load at session start.
- **Never fired against live cartridges:** Send command, mode toggle, RUN WORKFLOW.
- Parked: crash-recovery P2 (auto-recover Trust-mode agents in the reconciler + mass-crash
  throttle). P1 shipped. Never verified against a live interrupted run.
