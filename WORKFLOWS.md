# NeonCore Workflow Templates

## Overview

NeonCore seeds ~20 reusable **canvas workflow templates** on first server boot. They appear in the
**Workflows** panel under **Templates**; run any of them as many times as you like on any cartridge
or project. You can also **generate a new workflow from a sentence** (AI Workflow Generator) or build
one by hand in the canvas editor.

Many templates follow a **TDD-first** approach (tests after design, before implementation) and use
**quality-gate** steps with automatic routing — if a gate returns `STATUS: FAIL`, the preceding
implementation step resets and re-runs up to a cycle limit.

> **Workflows vs. tasks vs. goals.** A *workflow* is a multi-step recipe run on a cartridge or
> project. A *task* (see [docs/TASKS.md](docs/TASKS.md)) is a single queued unit of work for an
> agent. Both run against a project, and their cost rolls up to that project's *goal* (see
> [docs/GOALS.md](docs/GOALS.md)). For the gstack session *template* (not a NeonCore workflow) see
> [docs/gstack-feature-delivery-workflow.md](docs/gstack-feature-delivery-workflow.md).

---

## Template catalog

The dashboard is the source of truth for each template's exact steps. Current seeded templates:

**Core dev loop**
- **Bug Hunter** — find and fix a known bug with a regression test (detailed below).
- **Bug Investigation** — root-cause a bug without necessarily fixing it.
- **New Feature** — research → architect → test → build → gate (detailed below).
- **Feature Validation** — verify an existing feature behaves as intended.
- **Code Review & Audit** — structured multi-lens review of a change.
- **Full QA Review** — comprehensive QA pass across the app.

**Pipelines & research**
- **CI/CD Pipeline** — review → tests → security → notify (detailed below).
- **Deep Research** — multi-source investigation and synthesis.
- **Product Strategy Session** — strategy/scoping deliberation.
- **Engineering Architecture Review** — architecture evaluation and recommendations.

**Jira**
- **Jira Tasks Validation** — validate Jira issues against acceptance criteria.
- **Epic: Task by Task** — load an epic (markdown file or tracker key) and work every task to the end. Step 1 counts the outstanding tasks and the engine repeats the work step that many times, so coverage is guaranteed by the runner rather than by an agent remembering to continue; one task and one commit per dispatch, stopping early when the work runs out. Every re-dispatch after the first carries a loop header (which dispatch this is, what the previous one reported, and that the NEXT task is wanted), so a cartridge never receives a byte-identical prompt it could mistake for a duplicate; a dispatch that merely repeats the previous report ends the loop instead of advancing it. A final sweep reports done/skipped/blocked/outstanding and re-runs the suite.
- **CE Develop and Optimize** — processes a plan or tracker one task per dispatch. Each task first becomes a correct runnable vertical slice through TDD, then enters a measured optimization loop only when its declared metric misses the target. Every experiment retains correctness gates and is kept or reverted from comparable evidence. Results append to a durable running document. Bugs, invalid measurements, plateaus below target, and unresolved issues stop inside the current task for discussion; a final zero-retry evidence gate continues to notification only when coverage, correctness and declared goals all pass.

**Compound Engineering (CE) delivery pipeline**
- **CE: Phase 1 — Interrogate**, **Phase 2 — Plan**, **Phase 3 — Implement**,
  **Phase 4 — Review**, **Phase 5 — QA**, **Phase 6 — Ship**, **Phase 7 — Compound**, and
  **CE: Full Delivery** (the end-to-end chain).

> Templates named **Code Improvement**, **Feature Fix**, and **Refactor** were **removed** and are
> deleted on boot if present in an older DB — don't rely on them.

---

## Featured templates

### Bug Hunter
**Purpose:** Find and fix a known bug with automated verification.

**Pipeline:**
```
Investigate & Reproduce → Write Regression Test → Implement Fix → Tests + Security (parallel)
                                                         ↑ (loops back on STATUS: FAIL, max 2×)
```

**At run time:** pick a **cartridge** per step and enter an **objective** on the Investigate step
describing the bug.

**How it works:**
1. Reviewer traces the bug without touching code — root cause with file paths and line numbers.
2. Test Writer writes a **failing regression test** reproducing the bug (TDD).
3. Backend dev implements the minimal fix until the regression test passes.
4. Tests and Security run **in parallel** — if tests fail, Implement Fix resets and retries (max 2×).

---

### New Feature
**Purpose:** Build something new from research through implementation and testing.

**Pipeline:**
```
Research → Architect* → Write Tests → Develop → Quality Gate → Notify + Summary (parallel)
                                          ↑ (loops back on STATUS: FAIL, max 3×)
```
*\* Manual advance — review the architecture before tests are written.*

**How it works:**
1. Researcher surveys current approaches and patterns.
2. Architect designs the plan — **manual advance** so you can review before tests are written.
3. Test Writer writes failing tests that define acceptance criteria (TDD).
4. Developer builds until all tests pass.
5. Full quality gate — on `STATUS: FAIL`, Develop resets and retries (max 3×).
6. On success, a **system-notify** connector fires and a **Summary** step runs in parallel.

---

### CI/CD Pipeline
**Purpose:** Full automated pipeline — review, test, secure, notify.

**Pipeline:**
```
Code Review → Unit Tests  ──┐
           → Integration  ──┴→ Security Scan → Notify (system-notify)
              Tests
```

**How it works:**
1. Quality gate reviews code quality, patterns, and edge cases.
2. Unit and Integration tests run **in parallel** after review passes.
3. Security scan audits for OWASP issues and auth flaws.
4. A **system-notify** connector posts the result (desktop / ntfy push). Swap it for a Slack,
   Discord, GitHub, Linear, or generic HTTP connector in the canvas editor if you want an external
   destination.

---

## How to run a workflow

1. Open the dashboard (`http://<server>:4040`) and scroll to **Workflows**.
2. Find your template under **Templates** and click **Run** (▶).
3. In **Configure & Run**: pick the **project** (a run cartridge) once, and enter the first
   step's **objective**. By default every step runs on that one tool. To fan the workflow
   across tools, use **assign per step** to choose which **tool** (Claude / Codex / Gridlight)
   runs each step — it resolves to a live cartridge of that engine in the project. (You can also
   bake a tool into a step in the editor via its **Tool** field; steps left on *Default* use the
   run cartridge.)
4. Optionally **attach files** — a screenshot, a log, a spec. They are copied into the repo of
   every cartridge the run touches (under `.neoncore/attachments/`, gitignored) and referenced by
   path in **every** step's prompt, so a later reviewer opens the same evidence the implementer had.
   Up to 10 files, 20 MB total. This works for seeded templates and workflows you build yourself.
5. Click **Run Workflow** and watch steps execute on the canvas in real time.

Click ▶ on the same template multiple times to run it on different projects simultaneously — each
run is independent with its own `runNumber` and step progress.

---

## Key behaviors

| Behavior | Description |
|----------|-------------|
| **TDD ordering** | Tests are written after design and before implementation in the dev templates. |
| **Conditional routing** | A routing rule loops the run back to an earlier step when a step's result matches it (up to a max-cycle limit). See *Gate verdicts and routing rules* below. |
| **Context flow** | Each step receives its dependency results when "Include output from previous step" is enabled. |
| **Webhook completion** | Agents call their step's webhook URL (`/api/workflows/webhook/:stepId/complete`) with a result when done. |
| **Auto-advance** | Most steps start automatically when dependencies complete; some (e.g. New Feature's Architect) require manual advance. |
| **Parallel steps** | Steps sharing dependencies run simultaneously. |
| **Per-step tool** | Pick the project once at launch; each step runs on it by default, or choose a specific tool (Claude/Codex/Gridlight) per step. A pinned tool with no live cartridge falls back to the run cartridge. |
| **Deferred cartridges** | Agent steps use deferred selection — pick the cartridge/tool at run time. |
| **Launch attachments** | Files attached in Configure & Run are materialized into each repo the run touches and named in every step's prompt. |

### Gate verdicts and routing rules

**Verdicts.** A gate reads its verdict from the **first line** of the result. That line must be a
bare `PASS` or `FAIL`. A label and markdown are fine (`STATUS: PASS`, `Verdict: **PASS**`, `PASS.`),
but anything else on the line makes it a FAIL: `PASS: with caveats` and `PASS — but two tests
skipped` are qualified passes, and a gate does not accept them. Put the explanation on the
following lines. If the verdict is FAIL, a line `RETRY FROM: <step name>` picks which earlier step
redoes the work.

**Routing rules** (`contains` / `not_contains` / `starts_with` / `matches_regex`, each with a target
step and a `maxCycles` budget):

- **On a work step:** when its result matches, the target and every step between it and this one
  run again, this one included, so the condition is checked again against the new output. The
  target is told why: the matching result is added to its prompt as `[ROUTED BACK …]`. Nothing
  downstream starts until the loop settles. Once `maxCycles` is used up, the run moves on.
- **On a gate:** the rule is read against a **FAIL** verdict and chooses where the retry goes back
  to (an agent's own `RETRY FROM:` takes precedence). A PASS never loops back, even if its text
  happens to contain the rule's trigger. The gate's retry limit still applies.
- A rule whose target is not a step of the run is logged in the run's execution log and skipped.

Routing edges render as **dashed amber lines** on the canvas.

---

## How a step is sent

A run's steps are typed into cartridges, and a cartridge is one live agent session that keeps
everything it was told. Five rules follow from that.

- **One step at a time per cartridge.** A ready step waits while its cartridge has another step
  running (in any run), or has an open question or permission prompt. It starts the moment that
  cartridge is free, and the run log says what it is waiting for. Steps assigned to *different*
  cartridges still run in parallel. Without this, a "parallel" stage on one cartridge reached the
  agent as a single merged message.
- **No waiting on the poll.** An accepted completion, a decision, an Advance click, a launch, a
  confer milestone or a finished connector starts whatever it unblocked immediately. The 12s poll
  remains only as a backstop.
- **A session is told a thing once.** The goal brief, agent memory, completion contract, role persona
  and work-standard block go into a session in full once. After that, prompts carry a one-line
  reference. A result the session reported itself, or was already sent, arrives as its `NEXT:`
  hand-off and first line. A loop iteration or a gate retry refers to the instructions it already
  has. Every reference names where to fetch the full text, for an agent that no longer has it:

  ```
  GET /api/workflows/steps/<stepId>/result          a step's stored result
  GET /api/workflows/steps/<stepId>/instructions    a step's instructions as first dispatched
  GET /api/confer/<sessionId>                       a confer's task
  ```

  Full prompts come back whenever the session may have lost them: a new session (restart,
  `/clear`), a compaction (reported from the transcript by the hook reporter), every 10 prompts as
  a backstop, and always for engines whose compactions NeonCore cannot see (Codex, Gridlight).
  A reference is used only when it is shorter than what it replaces. The logic is in
  `server/src/lib/session-ledger.ts`.
- **A long run moves to a fresh session at phase boundaries** (Claude cartridges). Before a step
  marked `freshSession: true`, or once a run has typed 10 prompts into one session, NeonCore types
  `/clear` into the cartridge and sends the step into the new session, with everything in full:
  goal brief, contract, the previous phase's results. CE: Full Delivery marks the first step of
  phases 2–7. Without it, one session carried all ~38 prompts of that run and everything they
  produced, and it was re-read on every model call. Measured in the workflow test harness, the
  re-read drops by 85% on CE: Full Delivery and by 60–77% on 20-task epics, for +6% prompt text
  on Full Delivery and none on the epics.
  - `/clear` is typed only after the agent's turn has ended (the Stop hook's completion check let it
    stop). Text typed into a busy Claude Code is queued and sent to the model as a message, not run
    as a command. If the turn does not end within 60s, there is no fresh session and the step goes
    into the current one.
  - It is skipped when the run has not yet sent anything into the session (what is there is yours),
    for a gate retry or a routed redo, for Codex and Gridlight, when the turn ended on a question to
    you, and for a step with `freshSession: false`.
  - The step waits for Claude's `SessionEnd` with reason `clear`. If no confirmation arrives within
    20s, the step is sent anyway, in full. A `/clear`, whether typed by NeonCore or by you, no
    longer marks the cartridge offline or offers to resume it.
- **What the next step sees of an answer.** Each dependency result is capped at 1,500 chars, keeping
  its **head and its end** (where the conclusion usually is). A note says how much was dropped and
  where the whole text is. A work step is not forwarded the previous step's scope/verify block. A
  gate is, because it audits it.

A template step can opt out of run-level confer conversion with `conferFill: 'single'` in its
config. It then runs on the first participant's cartridge.

### Confers: waiting and talking

A confer milestone advances only when **every** participant has signalled it done. The conductor
waits, and the watchdog nudges a participant that has gone quiet. Participants can message each
other with `neoncore_message_agent`. Such a message arrives marked as coming from a **peer agent,
not the user**, naming the sender and how to reply. It carries no goal brief or work-standard
block, and it does not replace the recipient's objective. A comment that arrives after the recipient
has already signalled the milestone done **re-opens** the milestone for it, so it answers before
the confer moves on. The task brief and the commit/push instructions are sent in full on the first
milestone and referred to after that.

### The Work Standard Check and the completion report

A launched run with no gate of its own gets a **Work Standard Check** (a quality gate that audits
the work against its complete set and a set-based test). It runs **after the work and before the
trailing connectors**: work → check → Capture Learnings / Save to Project / Notify → completion
report. Before, it ran after "Notify: Done" and saw only Notify's one line. The same check is
added to scheduled and decomposed runs, which used to get none.

Templates that change no code are launched **without** it: the two daily digests, Deep Research,
Product Strategy Session, Engineering Architecture Review, Release Documentation, Jira Tasks
Validation, both Gridlight QA runs, and CE Phases 1, 2 and 7 (`NO_STANDARD_GATE_TEMPLATES` in
`server/src/lib/templates/index.ts`). A workflow created with `skipStandardGate: true` keeps that
opt-out at every launch (stored as `workflows.standard_gate = 'off'`). Before, the launch added the
check back.

The completion report's spec scales with the run: a run with at most 3 agent steps gets the compact
spec (~950 chars), which asks for the same fields and the same single delivery. Larger runs get the
full one (~1,700 chars).

### If the server goes down mid-run

The database survives a power cut (WAL, synchronous `FULL`). Steps, results, confer state and the
run's position are all on disk. After a restart:

- A cartridge whose session died is detected as interrupted within about 1–2 minutes, and the
  dashboard offers **Resume**. Resume relaunches the cartridge natively through its runner and
  replays the transcript. Each session reference in the replayed prompt is expanded back into full
  text, because the new session never saw the originals. The resumed cartridge is then sent a
  continuation prompt for the step it was on: check `git status`, finish, and report, with the path
  to fetch the step's instructions.
- What was lost: the session ledger lives in memory, so the first prompt into each session after a
  restart is sent in full. A step parked for a fresh session is picked up by the poll.
- Known limit: a cartridge that was `waiting` on a question at the moment of the crash is not
  flagged as interrupted until the 24h reaper sees it.

## Connectors

Connector steps run without a cartridge and execute immediately. The executor
(`server/src/lib/workflow-executor-v2.ts`) supports:

| Connector | Config | Use case |
|-----------|--------|----------|
| **system-notify** | none (uses global/per-cartridge ntfy) | Desktop / mobile push on completion — **used by the seeded templates** |
| **capture-learnings** | none | Extract learnings from the run into the project |
| **save-to-project** | none | Persist step output to project knowledge |
| **slack** / **discord** | Incoming Webhook URL | Post to a channel |
| **github** | PAT, repo, action | Create issues, comment on PRs, trigger workflows |
| **linear** | API key, team ID, action | Create/update Linear issues |
| **http** | URL, method, body template | Generic webhook — RequestBin, Zapier, Make, etc. |

**Template variables** in message/body templates:
`{{result}}`, `{{stepName}}`, `{{workflowName}}`, `{{agentName}}`, `{{timestamp}}`.

---

## Customizing templates

Open a template by clicking its name. The canvas editor lets you:

- **Add/remove steps** and drag connections between handles; **delete a connection** via the red X on an edge.
- **Add routing rules** (select a step → Routing Rules) for cyclic retry graphs.
- **Add connector steps** from the step-type selector.
- **Change expert roles** — architect, backend, frontend, reviewer, security, tester, performance, researcher, planner, or general.
- **Switch prompt mode** — free-text or structured (objective + acceptance criteria + constraints).
- **Add quality gates** — test, lint, security, build, full-review, or custom, with typed outputs.
- **Toggle auto-advance** to pause before a step for manual review.
