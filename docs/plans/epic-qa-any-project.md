# Epic QA for any project — with or without a web UI

**Ask (2026-11-23):** "we have to have a way to test any epics whether it has a web UI or not" — and
"a failed run blocks Passed QA".

**Why now:** automated epic QA (`server/src/lib/qa/feature-link.ts`) is browser-only. It needs a
`qa_targets` row (a base URL); none exists for any project, so it has never run. FacetDB (a database)
and Beam (a relay, no UI until Phase 7) finished Phase 0 and nothing was checked — silently.

## What already exists and is reused

- Every feature's **locked acceptance tests**: `acceptance_contracts.tests` = locked `test` criteria +
  `command` criteria, each a command from the repo root that passes on exit 0. Phase 0 of FacetDB has
  19 criteria (18 test + 1 command), Beam 34 (all test).
- Running them: `runCheck(access, test)` (acceptance-runner.ts:86, private) + the tamper check
  `findTampering(lockedFiles(...))`, as `retestLockedTests` (runner:880) does. Through `repoAccessFor`
  (local or the machine's runner), timeout `checkTimeoutMs()`.
- Epic membership and completion: `epicProgressOf` (feature-link.ts:83), `epicQaOf` (project-spec.ts:370).
- Sign-off: `setEpicQa` (roadmap.ts:364), `PUT /api/roadmap/epics/:id {qaPassed}`.

## Design

### 1. The epic acceptance run (new: `server/src/lib/qa/epic-acceptance.ts`)

When an epic's last feature is done, one run checks the epic **as it stands**:

| Check | Source | Per |
|---|---|---|
| Locked tests + command criteria | each feature's newest pilot → `getContract`, `status === 'locked'` | criterion |
| Tamper check | `findTampering` on the locked files | feature (a tampered feature fails) |
| The project's QA command (gate) | new `projects.qa_command`, e.g. `bash scripts/run_gates.sh 0` | run |
| Browser QA | existing `runEpicQa` — only if the project has a QA target | criterion (existing) |
| Checklist criteria | carried forward from the feature's confirmed review verdicts, shown as such | criterion |

Stored in a new table `epic_qa_runs (id, epic_id, project_id, for_finished_at, status
running|passed|failed|error|no-tests, results JSON, summary, error, started_at, finished_at)`.
The feature contracts' own `verifications` are NOT written (their history stays the feature's).

Statuses: `passed` every check green · `failed` any red, timed out or tampered · `error` could not run
(no runner for the repo's machine) · `no-tests` nothing runnable (no locked tests, no QA command, no target).

**Trigger:** the existing 15 s sweep (`startFeatureQa`) also starts an epic acceptance run for every epic
whose `epicQaOf` is `waiting` and has no run for its current `finishedAt`. Epics already finished when
this ships do not fire on their own (a project's history would run at once) — "Run QA" by hand.
One run per epic at a time (in-memory guard + `running` row).

### 2. A failed run blocks Passed QA

`setEpicQa(epicId, true)` additionally refuses (409, with the reason) unless the newest
`epic_qa_runs` row for the epic's current `finishedAt` is `passed` — or `no-tests` (nothing to block on;
the card says so plainly). `running` → "QA is still running"; `failed` → "QA failed: N of M — <first
failing criteria>"; `error` → the error; no run yet → "QA has not run — run it first". If the project has
a browser target, its epic run must have passed too. Un-passing (`qaPassed: false`) is never blocked.

### 3. Surfaces

- `RoadmapEpic` gains `qaRun: { status, passing, total, at, failing: [{feature, criterionId, text}] } | null`.
- Epic card (route) + the Board's QA column group: a chip *QA running / QA passed / QA failed N/M /
  No tests to run*; **Passed QA ✓** disabled with the blocking reason; **Run QA again** button.
- QA section: an "Epics" block per project — each run, each check, its command and output (last 8000
  chars), so a failure is actionable.
- Project settings: the **QA command** field.
- Routes: `GET /api/qa/epics/:epicId` (newest run), `POST /api/qa/epics/:epicId/run`.

### 4. A step can be BLOCKED on a person (CE Phase 3 "always fails once")

Today `neoncore_report_step_done` can only say "done". A step that needs a person (run the phase
gate with sudo, amend a locked test) reports done with "NEXT: Person…" in its text; every following
step is dispatched, reports done having done nothing, the quality gate fails and retries twice with
nothing changed, the run is marked failed (runs #14, #17). The rerun after the person acts passes.

- `neoncore_report_step_done` + the webhook gain `blocked: "<what the person must do>"`.
- A blocked report completes the step with a `_blockedHold { ask, at }` on its config — the same
  shape and path as the coverage hold (`holdForCoverage`, workflow-executor-v2.ts:1782):
  `notifyNeedsAttention`, `emitRunHeld`, and the readiness check (:3102) lets nothing after it start.
- The step and the run show **Needs you: <ask>** with **Done — continue** (re-dispatches the blocked
  step, the person's note attached) and **Stop the run**. No quality gate runs, no retry is spent,
  the run is not failed.
- The work-standard prompt tells agents: blocked on a person → `blocked`, never "done".

### 5. The next epic waits for the previous one to pass QA

Beam run #17 started a Phase 1 feature while Phase 0's gate was not recorded. In `advancePilot`
(goal-pilot-runner.ts:748), before a WORKFLOW stage launches: if any earlier epic of the project
(lower `epics.position`) that has features has not passed QA (`epicQaOf !== 'passed'`), the stage
waits — `setWaiting(stage, 'Waiting for "Phase 0: Setup" to pass QA')`. Stage 0 (writing the
acceptance tests) is not held: planning ahead is fine, building ahead is not. Pressing Passed QA
re-advances the pilots waiting on that epic. Un-passing an epic does not stop work already running.

### 6. Background work is a status, not silence

An agent that starts a long suite in the background and ends its turn shows "waiting for your input"
→ idle, on the agent, its step and its feature, though work is progressing (Ravinia Prep, 2026-11-23:
a 10+ min gateway suite under Monitor, dashboard said waiting).

- **The source of truth is the Stop hook's `background_tasks`** (documented: id, type shell|subagent|
  monitor|workflow|…, status, description; empty when nothing is in flight; "to distinguish session is
  done from session is paused waiting for background work"). `agent/hooks/reporter.py` forwards it on
  Stop and SubagentStop. Recorded in `agent_background_tasks (agent_id, task_id, kind, description,
  started_at, deadline_at, ended_at, end_reason)`.
- **Earlier and richer, undocumented:** PostToolUse already carries `backgroundTaskId` (Bash) and
  `taskId` + `timeoutMs` (Monitor) in our live activity data — used for the start time and the
  deadline when present, never relied on alone.
- **A new agent status `background`:** a Stop or a "waiting for your input" notification while the
  agent has open background tasks sets `background`, not `waiting`/`idle`. The staleness/zombie sweep
  does not age a `background` agent out before its deadline.
- **Shown on all three:** the agent card, the running step, and the feature/pilot —
  "Running in background: final G1 suite + Postgres tests · 12 min (up to 30)".
- **The Stop gate:** a stop with open background tasks is allowed without counting as a block (no
  `needs_review`), and is not "the turn is over" (no queue advance, no step completion inferred).
- **The "waiting for your input" notification** (`idle_prompt`) is ignored while the agent has open
  background tasks — Claude Code suppresses it for background subagents but, as observed, not for
  background shells/Monitor.
- **End:** no hook fires when background work finishes (documented). A task closes when a later Stop's
  `background_tasks` no longer lists it (`end_reason: finished`), or its deadline passes
  (`end_reason: overran` → the step shows "background task overran", attention). Between those, any
  tool use already sets `working`.

## Tests (set-based)

1. Every check kind × outcome lands in the run with the right status: {test, command, qa-command,
   tamper} × {pass, fail, timeout} — real temp repo with `.mjs` checks, as acceptance-contract.test.ts does.
2. Every run status × Passed QA: {none, running, passed, failed, error, no-tests} → allowed or refused,
   with the reason; un-pass always allowed.
3. The sweep: fires once per finish, not for epics finished before the boot marker, re-fires when a
   feature is reopened and done again.
4. Dashboard: every run status renders its chip and the button's enabled/disabled state.
5. Blocked: for every executor type that reports through the webhook (claude-code, command,
   quality-gate, review-gate, panel), a `blocked` report holds the run, dispatches nothing after
   it, spends no retry, and "continue" re-dispatches exactly that step.
6. Epic order: every combination of {earlier epic none/open/waiting/passed} × {stage kind
   acceptance/workflow/review} → launches or waits, with the reason; passing re-advances.

7. Background: every start signal kind (Bash backgroundTaskId, Monitor taskId, background Agent) ×
   {Stop, waiting notification, later tool use, deadline} → the right status on agent, step and
   pilot; the Stop gate allows without a block; the sweep does not reap.

## Open questions for review

- **A clean checkout.** The next epic's features may already be editing the same repo (Beam run #17).
  Run in a `git worktree add --detach` of the repo's HEAD, or in the repo and skip while a cartridge is
  working there?
- **Checklist criteria:** carry the confirmed verdicts forward (v1), or re-dispatch an independent
  reviewer per epic (costly; needs pilot/stage plumbing)?
