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
