# Session journal — append-only

> Never rewritten. Each entry is a timestamped record of what happened, the
> result, and why. Two kinds of entries:
> - **`###  <ts> — heartbeat`** — auto-written by `snapshot.sh` (Stop hook)
>   every turn. Records branch + working-tree status. Forensic breadcrumb:
>   tells you *when* a session died and what was dirty at the time.
> - **`##  <ts> — <title>`** — narrated by Claude on meaningful steps. Carries
>   reasoning, decisions, results, and the next step.

---

## 2026-07-03 — Worklog system created
- **Why:** sessions can crash / power can drop; we want to resume without
  re-deriving state. Chose a repo-local file over storing state inside the
  running NeonCore app (NeonCore is the thing that may be crashing/unreachable).
- **Design:** `STATE.md` (live snapshot, overwritten) + `journal.md`
  (append-only trail). A `Stop` hook runs `snapshot.sh` every turn to stamp a
  heartbeat and auto-commit `.neoncore/sessions/` — so the freshest recoverable
  point is always committed.
- **Decisions (from user):** auto-commit each update; hook stamps + Claude
  narrates.
- **State at this point:** parity-eval backend-aware probe done, 17/17 eval
  tests green; GuideModal copy pass done; all still uncommitted.
- **Next:** wire the Stop hook, verify heartbeat fires, then decide commit
  strategy for the eval + guide work.

### ⏱ 2026-07-03T18:32:14Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 6 file(s) dirty

### ⏱ 2026-07-03T18:39:01Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 5 file(s) dirty

### ⏱ 2026-07-03T18:57:04Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 5 file(s) dirty

### ⏱ 2026-07-03T18:59:21Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 5 file(s) dirty

## 2026-07-03 — Recovery subsystem design started (via /plan-eng-review)
- User requirement sharpened across turns: NeonCore must durably keep the full
  claude/gridlight interaction so a crashed run resumes "as if in terminal".
- Read agent/relay/{launch.js,index.js}. Relay = PTY byte-pipe; does NOT parse
  transcript and registers sessionId=relay-<pid> (NOT native session id).
- Two explore agents run: (1) run/step recovery [done], (2) transcript-capture
  audit [in progress, agentId a59ef5a7...].
- Root gap identified: native session id never captured -> resume impossible
  today, though relay already supports `-- --resume` passthrough.
- Next: await transcript audit -> present Step 0 scope + key decision (native
  --resume vs transcript-replay vs hybrid) via AskUserQuestion.

### ⏱ 2026-07-03T19:23:10Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 5 file(s) dirty

## 2026-07-03 — D1 decided: transcript-replay backbone
- Transcript-capture audit result: messages table (db.ts:352-373) ALREADY stores
  full turn-by-turn transcript keyed by native session id, unified claude+gridlight,
  but WRITE-ONLY (nothing SELECTs it). Native session id known via hooks. Blocks
  size-capped (reporter.py:25-27) = lossy copy.
- User chose A: Transcript replay (NeonCore-owned), NOT native --resume. Rationale:
  transcript already captured; sidesteps the fragile JSONL that SIGTERM corrupts.
- Architecture drafted: detection (reconcile running+offline steps -> interrupted),
  recovery (rebuild context from messages -> dispatch), relay hardening (capture
  native session id + POST interrupted on SIGTERM before killing PTY).
- Next decision (D2): automation posture — human-gated Resume vs auto-recover by
  trust mode vs always auto.

## 2026-07-03 — D2 decided + plan written
- D2: auto-recover by trust mode (Trust=auto-replay, Manual/Plan=human-gated Resume).
- Simplification: relay stays dumb — on SIGTERM it POSTs {machine,repo,type};
  server resolves agent -> latest session -> messages. No session-id capture in relay.
- Full plan written: .neoncore/docs/recovery-subsystem-plan.md (architecture,
  data model, test plan, failure modes, P1/P2/P3 phasing, NOT-in-scope).
- Next: user decides implement P1 vs review plan further.

## 2026-07-03 — Recovery P1 built + green
- Implemented transcript-replay recovery backend. 10 files (2 new lib + 1 new
  test + db/index/routes/types/package + relay). server tsc clean; 18/18 tests
  pass; migration ran on real neoncore.db (4 columns confirmed).
- Design for testability: recovery-core.ts is pure + dependency-injected
  (database, now, isAlive, dispatch); recovery.ts is the thin production wiring.
- Endpoints: POST /api/agents/interrupted (relay fast path),
  POST /api/workflows/steps/:stepId/recover (Resume). Socket: workflow_step_recovery.
- Reconciler runs in the existing 30s sweep + once on startup.
- Relay now POSTs interrupt on SIGTERM/SIGHUP (not SIGINT) before killing PTY.
- CODE UNCOMMITTED (awaiting ok). Remaining P1 slice: dashboard Resume button.

### ⏱ 2026-07-03T20:59:38Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 15 file(s) dirty

## 2026-07-03 — Recovery P1 shipped (backend + UI) + committed + pushed
- 4 commits pushed to github: 516058c (recovery backend), 3a77d76 (eval probe),
  17c851f (guide copy), dec3195 (dashboard Resume button).
- Dashboard: WorkflowStep API now carries recoveryStatus/interruptedAt/
  recoveryAttempts (both normalizeStep sites); useSocket onWorkflowStepRecovery;
  api.recoverStep; canvas node shows red Resume/Retry button + Recovering state.
- Verified: server tsc clean, dashboard tsc clean, 18/18 server tests pass.
- Stop hook confirmed auto-firing (saw c64cd03 heartbeat I didn't run manually).
- `local` remote offline (localhost:3000) — only pushed to github.
- Left for later: P2 trust-auto-recover + throttle; P3 native --resume; live e2e verify.

### ⏱ 2026-07-03T21:07:55Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 0
0 file(s) dirty

### ⏱ 2026-07-05T10:28:57Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 0
0 file(s) dirty

### ⏱ 2026-07-05T10:49:27Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 0
0 file(s) dirty

### ⏱ 2026-07-05T10:50:31Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-05T10:51:18Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-11T17:47:58Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 1 file(s) dirty

### ⏱ 2026-07-11T17:59:39Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 4 file(s) dirty

### ⏱ 2026-07-11T18:01:54Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-11T18:06:19Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-11T18:09:22Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-11T18:12:40Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-11T18:16:23Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-11T18:17:43Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-11T18:18:46Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

## 2026-07-12 — Mobile app: first real run against a live server
- Ran the Expo app for real (iOS sim + server on :4040). It had only ever been
  proven to *bundle*; this is the first time it talked to NeonCore.
- Curl-verified the API contract first. Two things LOOKED like bugs and were not:
  `content` is a JSON string by design (socket + REST agree), and message ordering
  is correct (route reverses to chronological; `seq` restarts per session).
- Real bugs found + fixed: ConnectScreen prefilled the example IP as a VALUE (dead
  placeholder underneath); detail header wrapped "‹ Cartridges" onto two lines.
- Built to user's asks: live-only cartridge list (4 of 23), tap-to-expand full
  messages (with auto-scroll gated so expanding doesn't yank the list), and a
  Workflows screen that runs any of the 20 templates.
- Commits d253484, c5202a6. Working tree clean; 8 commits unpushed.
- KEY CONSTRAINT for physical phone: app is SDK 52, App Store Expo Go is SDK 57 →
  Expo Go on hardware cannot work. EAS dev build path set up (expo-dev-client +
  eas.json); remaining steps are interactive and need a paid Apple Dev account.
- NOT tested (would mutate real agents): send command, mode toggle, RUN WORKFLOW.

### ⏱ 2026-07-12T20:20:16Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

## 2026-07-12 — TestFlight prep
- User has a paid Apple Dev account → chose TestFlight over a dev-client build.
- Blocker found before burning a cloud build: **no app icon existed at all**.
  App Store Connect rejects builds without a 1024x1024 no-alpha icon, so this
  would have failed at processing. Generated icon/adaptive-icon/splash from the
  app palette. Also added ios.buildNumber + ITSAppUsesNonExemptEncryption:false
  (else every submission stops to ask) and an EAS production/submit profile.
- Verified `expo config` resolves it all and `expo export --platform ios` is clean.
- Commit 8671d89. Handoff: `eas login` / `eas build` / `eas submit` are interactive
  (Expo password + Apple 2FA) — user runs them.

### ⏱ 2026-07-12T20:28:29Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-12T20:59:22Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-12T21:14:26Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-12T22:06:05Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

## 2026-07-12 — "Can't answer questions on mobile" (root-caused, verified)
- FIRST DIAGNOSIS WAS WRONG. I blamed the server's 2-min permission TTL vs the
  hook's ~10-min wait. That IS a real bug (fixed, d313882) but the user pushed back
  ("no the approvals weren't showing it before") and was right.
- ACTUAL BUG (8436e77): NeonCoreProvider refresh()'d only on MOUNT. socket 'connect'
  set connected=true but never refetched. Socket events have no replay → any question
  raised while the phone slept was lost; on reconnect the UI said "live" while
  `permissions` was the stale mount array → Approvals empty, agent blocked.
- LESSON: a fresh app launch is NOT a valid test of a reconnect bug — mount always
  refetched. Had to insert a permission directly into the DB (no socket emit), prove
  the app stayed blind, then bounce the server to force reconnect WITHOUT remount.
- Also: questions now answerable inline in cartridge detail; pending_question
  invariant sweep kills stale "❓" banners.
- Earlier this session: tab bar (Workflows was hidden behind an unlabeled ⚡ emoji —
  discoverability bug, not a missing feature), live-only cartridge list,
  tap-to-expand messages, workflow launcher.
- TestFlight: EAS linked (@gridlight/neoncore-mobile). User running eas build now.

### ⏱ 2026-07-12T23:39:10Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T11:12:55Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T11:21:11Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T11:23:03Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T11:25:51Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T13:54:24Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

## 2026-07-13 — Mobile app SHIPPED to TestFlight (build 4)
- Build 4 submitted. ASC app id 6790428906. ascAppId pinned in eas.json → build AND
  submit are now both non-interactive (the Apple 2FA gate was one-time only).
- Build 3 failed first: autoIncrement is INCOMPATIBLE with runtimeVersion fingerprint
  policy (EAS bumps ios.buildNumber server-side; buildNumber feeds the fingerprint, so
  local≠EAS every time). Proved with @expo/fingerprint, then switched to appVersion policy.
- Also fixed this session: no app icon existed at all (ASC rejects that); emoji icon set
  replaced with SVG matching the dashboard's Heroicons-outline language (bell → inbox).
- OTA (EAS Update) wired: JS changes now ship in ~30s via `eas update`, no rebuild.
  RULE: bump `version` on native changes or OTA pushes incompatible JS → crash.

### ⏱ 2026-07-13T13:59:34Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T14:14:09Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T14:23:48Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

## 2026-07-13 — Apple REJECTED build 4 (ITMS-90725) → Expo SDK 52→57
- The mystery "app never showed up in TestFlight" was NOT a distribution/tester-group
  problem. The submit succeeded; **Apple rejected the binary by email**. It never became
  a TestFlight build at all.
- ITMS-90725: built with iOS 18.2 SDK; Apple now requires the **iOS 26 SDK (Xcode 26+)**.
- ROOT CAUSE: the **EAS build image is chosen by the Expo SDK version.** SDK 52 →
  `macos-sequoia-15.3-xcode-16.2` → iOS 18.2 SDK. Pinning a newer image in eas.json does
  NOT work: RN 0.76 can't compile against the iOS 26 SDK. The SDK had to move.
- Upgraded 52 → 57 (e00f353). SDK 57 default image = `macos-tahoe-26.5-xcode-26.6`.
  React 19, RN 0.86, New Arch mandatory. All 3 native deps (svg, async-storage,
  socket.io) already New-Arch-ready → zero source changes; tsc clean first try.
  `splash` key removed in SDK 57 → expo-splash-screen plugin. version → 0.2.0 (native).
- Chose NOT to pin an eas.json `image`: `auto` follows the SDK, so a pin would rot the
  next time Apple raises the bar — precisely this failure mode.
- LESSON: "✔ Scheduled iOS submission" only means Apple RECEIVED it. Verify the build
  reaches **Ready to Test** in App Store Connect before believing it shipped.

### ⏱ 2026-07-13T14:37:59Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: 1 file(s) dirty

### ⏱ 2026-07-13T15:10:55Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T15:23:15Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T15:23:28Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T15:25:48Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T15:32:59Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T15:43:32Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### 2026-07-13 — build 5 (0.2.0) submitted to Apple
- `eas submit` exit 0, fully non-interactive. Submission ac0a76b7. Awaiting Apple processing.
- Verified the ITMS-90725 fix FROM THE IPA, not the docs: unzipped it and read
  Info.plist → `DTSDKName: iphoneos26.5`, `DTXcode: 2660` (Xcode 26.6). Those are the
  exact fields Apple's validator reads. Build 4 had `iphoneos18.2`.
- NEW HABIT: unzip the IPA + PlistBuddy Info.plist before submitting. Turns a 30-min
  round trip through Apple's email into a 5-second local check.
- Note: piping `eas submit` through `tee|tail` hides progress — the CLI spinner uses
  carriage returns and only renders on a TTY. The process staying alive IS the signal
  (the CLI exits only on a terminal submission state).

### ⏱ 2026-07-13T16:13:03Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean

### ⏱ 2026-07-13T16:40:09Z — heartbeat
- branch `feature/dual-runtime-parity-eval` — working tree: clean
