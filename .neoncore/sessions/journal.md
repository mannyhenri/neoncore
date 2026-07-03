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
