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
