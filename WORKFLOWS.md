# NeonCore Workflow Templates

## Overview

NeonCore seeds **22 workflow templates** on every server boot (`server/src/lib/templates/`). They
appear in the **Workflows** panel under **Templates**, filed under six tabs: Strategy, Plan, Dev,
Quality, Delivery and Learn. Run any of them as many times as you like on any cartridge or project,
or build your own with **+ New Workflow** in the canvas editor.

Templates are re-seeded on every boot: a template keeps its id across restarts (so runs and
schedules keep pointing at it) but its steps are rewritten from the code. A template removed from
the code is also deleted from existing databases on the next boot; its past runs are kept.

Many templates follow a **TDD-first** approach (tests after design, before implementation) and use
**quality-gate** steps or **routing rules** that send the run back to an earlier step when a check
fails, up to a cycle limit.

> **Workflows vs. tasks vs. features.** A *workflow* is a multi-step recipe run on a cartridge or
> project. A *task* (see [docs/TASKS.md](docs/TASKS.md)) is a single queued unit of work for an
> agent. Both run against a project; a workflow can also run as a stage of one of the project's
> *features* (see [docs/GOALS.md](docs/GOALS.md)). For the gstack session *template* (not a NeonCore workflow) see
> [docs/gstack-feature-delivery-workflow.md](docs/gstack-feature-delivery-workflow.md).

---

## Template catalog

The dashboard shows each template's exact steps. Every run also ends with a **Workflow Completion
Report** step, and most runs get a **Work
Standard Check** — see [below](#the-work-standard-check-and-the-completion-report).

**Strategy**
- **Deep Research** — web and local research → synthesis → your review → epic plan, saved in the
  repo at `docs/plans/EPIC-<slug>.md` → optionally created in Jira (task files in
  `docs/plans/tasks/`).
- **Product Strategy Session** — premise challenge → alternatives → dream state → CEO-vs-PM debate →
  10-dimension review → action plan (you review it).
- **CE: Phase 1 — Interrogate** — challenge the idea before planning; writes
  `docs/<slug>/brainstorm.md`.

**Plan**
- **Engineering Architecture Review** — map an existing system → bottlenecks and risks →
  alternatives → recommendation (you review it) → roadmap.
- **CE: Phase 2 — Plan** — CEO, engineering and research reviews in parallel → `docs/<slug>/plan.md`.

**Dev**
- **Confer** — two or more cartridges, usually in different repos, agree a plan, split the work and
  build in rounds. Give it a task, or a **Jira epic**: the epic is looked up first, the rounds are
  sized to its task count, and the run does not finish until every task in it is done (details
  below). Can be scheduled and used as a Goal Pilot stage, with two or more cartridges.
- **Epic: Task by Task** — one cartridge works every task of an epic (a markdown file or tracker
  key), test-first, one commit per task, unattended. The engine repeats the work step once per
  outstanding task, so coverage does not depend on an agent remembering to continue.
- **Epic: Two Repos** — one epic split up front between two repos; each side's cartridge works its
  own tasks in parallel, and a join step reports both sides. Use it when you already know who owns
  what; use Confer when the split is the hard part.
- **CE Develop and Optimize** — works a task list one task per dispatch: a correct slice via TDD,
  then a measured optimisation loop when a task's metric misses its target. Stops to ask you on
  bugs, invalid measurements or a plateau below target.

  These four are **task-list workflows**: each keeps a progress document at
  `docs/progress/<ID>.md`, and none of them finishes while tasks are open — see
  [Task-list runs](#task-list-runs-every-task-and-where-to-watch).
- **Bug Investigation** — reproduce a known bug → root cause → impact → fix plan (you approve it) →
  fix → verify → capture learnings.
- **CE: Phase 3 — Implement** — git worktree → failing tests → implement → tests (loops back on
  failure) → build summary. When the build summary passes, **CE: Phase 4 — Review starts
  automatically** on the same project and cartridge.

**Quality**
- **Super QA** — one QA workflow for a change (branch, PR, files) or a product (feature, URL, the
  whole app): read the code → functional testing → logic & error handling → security → performance
  & accessibility → test coverage → one QA report and verdict (you review it) → capture learnings.
- **Feature Validation** — a feature spec (optionally a Jira epic) → find and write tests (you
  approve them) → evaluate the code → implement the gaps → tests → validation report.
- **Bug Hunter** — hunts for bugs nobody has reported yet: static analysis → dead code → bug
  patterns → prioritised fix plan (you approve it) → fixes → verify.
- **QA Testing Guide** — writes a reusable testing guide, `docs/qa/testing-guide.md`: every flow,
  its steps, expected results and failure modes. Not a report of one run.
- **Jira Tasks Validation** — checks every task of a Jira epic against the code and moves the ones
  that meet their requirements to *In QA*.
- **CE: Phase 4 — Review** — six specialist reviews in parallel → triage P1/P2/P3 → your decision →
  fix → open the PR.
- **CE: Phase 5 — QA** — real-browser QA on staging: walk every flow, fix bugs, add regression tests.

**Delivery**
- **Release Documentation** — the documents you ship with a release: notes, upgrade steps, install
  and configuration, support runbook, in `docs/release/<version>/`.
- **CE: Phase 6 — Ship** — document the release → merge approval → land and deploy → 10-minute
  canary → your decision (all clear, roll back or hotfix).
- **Resolve PR Conflicts** — run it on its own on a feature branch whose PR conflicts with its base
  (features built side by side, then merged one after the other): bring the base in → resolve
  keeping both sides' intent → re-test (failures loop back) → push and comment on the PR. Never
  force-pushes, never merges.

**Learn**
- **CE: Phase 7 — Compound** — capture what the feature taught: compound doc, `CLAUDE.md` updates,
  retro.

> **Removed templates** are deleted from existing databases on boot (`deprecatedNames` in
> `server/src/lib/templates/index.ts`), so don't rely on them: *CE: Full Delivery* (run the seven
> phases instead; Phase 3 continues into Phase 4 itself), *Spec Intake → Dev Spec* (use Feature
> Validation), *Epic: Confer Across Repos* (use Confer with a Jira epic), *Full QA Review* and
> *Code Review & Audit* (use Super QA), the two daily digests (*Daily AI Research Digest*, *Daily
> AI Filmmaking Digest*), the three *Gridlight* QA and performance templates,
> *New Feature*, *CI/CD Pipeline*, *Code Improvement*, *Feature Fix*, *Refactor* and
> *Jira Tasks Completion*.

---

## Featured templates

### Confer — one task, or every task of a Jira epic

**At launch:** pick two or more cartridges under **Run on**, then either describe the task, give a
**Jira epic** in the epic field (a key such as `GRD-1712` or the epic's URL), or both — with both,
the text is extra direction for the epic. The epic field adds a `JIRA EPIC: <KEY>` line to the
launch context. A schedule or a Goal Pilot stage can pass the same line (see
[Confer on a schedule or in a goal](#confer-on-a-schedule-or-in-a-goal)).

```
Scope the Work → Confer & Build → Verify Coverage → Work Standard Check → Notify → report
                       ↑                │
                       └─ tasks open ───┘  while each pass gets further; then it asks you
```

1. **Scope the Work** (one cartridge). With an epic, it reads the epic from Jira (the Atlassian MCP,
   or the project's Jira CLI) and lists **every** child task, recursing into sub-epics, into the
   progress document `docs/progress/<EPIC-KEY>.md`. Without an epic, it states the task and writes
   `docs/progress/<slug>.md`. Either way it states the objective, the repos involved, how done is
   verified and `TASK_COUNT`, and leaves the split to the participants.
2. **Confer & Build.** The participants agree one plan, give every task exactly one owner, agree the
   interface between repos first, and build in rounds, each in its own repo, one commit per task,
   marking each task DONE in the progress document. **The number of build rounds comes from the
   task count**: two tasks per participant per round, **capped at 2** (a step can raise the cap
   with `maxBuildRounds`); what two rounds leave open, the coverage check sends back.
   **Each participant does only its own part**: a task that is a day of backend work and one line
   of frontend is a day for one and one line for the other, and a participant with nothing in a
   step says so and signals at once rather than waiting.
   **The confer runs only the steps that are its job**: agree → build → land. The merge step
   (Converge) runs only when two participants share one repo; the Cross-review step is left out
   when the run is a stage of a feature pipeline that has a QA or review stage after it.
   **Nobody is waited on in silence**: a cartridge that is working, or waiting on you, is left
   alone; one that is idle and has not signalled is reminded every 8 minutes, and after two
   reminders with no answer it is *presumed done* — the confer moves on, the session says so, and
   the coverage check catches anything it did not finish.
3. **Verify Coverage** (one cartridge) checks every task is owned and done, every suite is green and
   the shared interface matches on both sides, and reports `COVERAGE: <done>/<total>` with the
   open tasks. A task whose suite is red or whose interface does not match is not done. The engine
   reads that line — see [Task-list runs](#task-list-runs-every-task-and-where-to-watch): tasks
   open → a **fresh confer session on what is left**, handed the open list, its rounds sized to
   it — or, when only **one or two tasks** are open, no confer at all: they go as a single step
   straight to the cartridge whose repo owns them. No progress → the run waits for you.

### Super QA

Put what to QA in the context. A **change** (branch, PR, commit range, files) is reviewed as a
change: the diff's files are read in full. A **feature, URL or the whole app** is tested as a
product; if a URL is given and the cartridge has a browser tool, journeys are exercised live,
otherwise traced through the code. Every lens runs either way, and the **QA Report** gives one
verdict — *SHIP*, *SHIP WITH FIXES* or *DO NOT SHIP* (for a change: approve, approve with changes,
request changes) — with a health score and every issue by severity. It waits for you before
learnings are captured. Security is a review step scoped to what is being QA'd, not a gate.

### The CE pipeline

Seven templates, one per phase, linked by files under `docs/<slug>/` and `todos/<slug>/`. Put the
feature slug in each launch's context. Phases 1, 2, 4, 5, 6 and 7 end by notifying you and waiting
for you to start the next phase — each has a human checkpoint worth reading first. **Phase 3
continues by itself:** its last step is a *Continue to Workflow* connector that starts
*CE: Phase 4 — Review* on the same project and cartridge, with the same context and autonomy, but
only if *Build Summary* reported `STATUS: PASS`. When Phase 3 runs as a stage of a **Goal Pilot**
pipeline it does not continue: the pilot decides what runs next.

### Task-list runs: every task, and where to watch

Confer, Epic: Task by Task, Epic: Two Repos and CE Develop and Optimize work a list of tasks. Two
things hold for all four.

**They do not finish while tasks are open.** Each ends its work with a coverage step that reports
`COVERAGE: <done>/<total>` and the open tasks. The engine reads that line itself
(`server/src/lib/coverage-loop.ts`); it is not left to an agent's judgement:

| What the coverage step reports | What the engine does |
|---|---|
| every task done | the run goes on (Work Standard Check, notify, report) |
| tasks open, and more done than at the last check | sends the run **back to the work** — the loop, or a fresh confer session — on what is left: told which tasks are open, and with a budget sized to them. Then checks again. |
| tasks open and **no more done than last time**, no `COVERAGE` line, or 10 passes used | **holds the run** and asks you |

A held run shows **NEEDS YOU** with *"5 of 23 task(s) are still open … Keep working, or accept the
run as it is"*, rings the bell, pushes to your phone, and offers two choices — on the run card, in
its Progress window, on the step in the canvas, on a Goal Pilot stage, and as notification buttons:

- **Keep working** — back to the work on the open tasks (a task that was BLOCKED or SKIPPED is tried
  again).
- **Accept as is** — the run goes on with those tasks open, and the run's record says so.

No autonomy level answers this for you, not even `full`: it is the one reason
(`tasks-outstanding`) that is never auto-resolved, because "finish every task" must not quietly
become "finish some". A coverage step that reports without a `COVERAGE` line is refused on the spot
and told the exact line to add, so a forgotten count never turns into a hold.

What still stops a run early, and how you hear about it: a task that fails three times is marked
BLOCKED and the loop moves on (a later pass retries it); a cartridge that repeats its last report
ends its loop and alerts you. In both cases the coverage check then sends the run back or holds it,
rather than letting it read as finished. A confer milestone that runs past its time limits (4 hours
without a signal while its cartridges are idle, 12 hours at most) fails the step instead, which
ends the run as **failed** and alerts you — never as completed.

**You can read where they are at any time.**

- **The progress document** — `docs/progress/<EPIC-KEY>.md` (or `<slug>.md`) in the repo: one row
  per task with its status (TODO, DONE, BLOCKED, SKIPPED), owner, commit and notes, and a `## Log`.
  The first step creates it (or keeps its statuses if it exists); every task updates it; every
  agent re-reads it before picking the next task, so it survives a cleared session or a restart.
  It is in git.
- **The Progress window** — on the run card, *"14 of 23 tasks done · 2 blocked"* and a
  **Progress** button (also on each Goal Pilot stage). It shows the document (rendered, when the
  cartridge is on the server's machine; on another machine it says where), and what the engine
  itself saw: every task a dispatch reported DONE, BLOCKED or SKIPPED, and every coverage check and
  what was done about it (`GET /api/workflows/<runId>/progress`).

### Confer on a schedule or in a goal

A confer needs two or more cartridges, and every way of starting one now carries them:

- **Scheduled:** in the launch dialog pick two or more cartridges under **Run on**, then *Schedule
  this run*; or use the ⏱ schedule control on the template and add cartridges with **With…**. A
  Confer schedule with one cartridge is refused when you create it.
- **In a goal (Goal Pilot):** a Confer stage is staffed with **two or more repos**, which work it
  together; by default every repo you chose for the goal, or tick the ones you want under *Where
  each stage runs*. The stage waits until all its cartridges are live and free. To work a Jira epic,
  put `JIRA EPIC: <KEY>` in the stage's focus (the planner is told to). When the confer run
  finishes — every task done, or accepted by you — the pipeline moves to the next stage as usual;
  while it holds with tasks open, the stage shows the same two choices.
- **Continue to Workflow:** a confer run continuing into another confer workflow passes its
  cartridges on; a run that was not a confer cannot continue into one, and says so.

**Try it without AI:** `npm run sandbox:goal-confer` runs a goal with a Confer stage on a 5-task
Jira epic against simulated cartridges in two repos and prints the timeline as it happens: the
coverage loop sending the run back for an unclaimed task, and (the `blocked` scenario) a task that
cannot be finished holding the run until *Keep working* / *Accept as is*. See
[docs/sandbox.md](docs/sandbox.md).

### Bug Hunter

**Purpose:** find bugs nobody has reported yet, and fix them.

```
Static & Lint Analysis → Dead Code Scan → Bug Pattern Hunt → Prioritize & Plan Fixes* → Implement Fixes → Verify (tests)
```
*\* Waits for you to approve the plan.*

The three scans change nothing. The plan ranks every finding P0–P3; fixes go in that order, dead
code last. For a bug you already know about, use **Bug Investigation**.

---

## How to run a workflow

1. Open the dashboard (`http://<server>:4040`) and scroll to **Workflows**.
2. Find your template under **Templates** and click **Run** (▶).
3. In **Configure & Run**: pick the **project** (a run cartridge) once, and enter the run's
   **context** — what it should work on. Some templates ask for something specific here: the
   feature to validate (Feature Validation, required), the epic (Epic: Task by Task), the Jira epic
   (Jira Tasks Validation), or the task and an optional Jira epic (Confer, one of the two
   required). Pick two or more cartridges under **Run on** to run a template as a confer. By
   default every step runs on that one tool. To fan the workflow
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
| **Coverage** | A task-list run's coverage step is read by the engine: the run goes back to the work while tasks are open and progress is being made, and otherwise waits for you. See *Task-list runs* above. |
| **Context flow** | Each step receives its dependency results when "Include output from previous step" is enabled. |
| **Webhook completion** | Agents call their step's webhook URL (`/api/workflows/webhook/:stepId/complete`) with a result when done. |
| **Auto-advance** | Most steps start automatically when dependencies complete; some finish and then hold the run until you advance it, so you can read the output first (e.g. Super QA's QA Report, Bug Hunter's fix plan, Feature Validation's test manifest). Decision steps always wait for your choice. |
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
  goal brief, contract, the previous phase's results. No seeded template marks a step this way now
  (CE: Full Delivery did, before it was replaced by running the phases as separate runs); a
  template you build can. The 10-prompt threshold applies to every run. Without it, one session
  carried every prompt of a long run and everything it produced, re-read on every model call.
  Measured in the workflow test harness, the re-read drops by 60–77% on 20-task epics, for no
  extra prompt text.
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

Of the seeded templates:

- **Get the check:** Confer, Epic: Task by Task, Epic: Two Repos, and CE Phases 4, 5 and 6.
- **Have a gate of their own, so no second one is added:** Bug Hunter, Bug Investigation, Feature
  Validation, QA Testing Guide, CE Develop and Optimize, and CE Phase 3. (Confer's loop is the
  engine's coverage rule, not a gate, so that it keeps the check.)
- **Change no code, so are launched without it:** Deep Research, Product
  Strategy Session, Engineering Architecture Review, Release Documentation, Jira Tasks Validation,
  Super QA, and CE Phases 1, 2 and 7 (`NO_STANDARD_GATE_TEMPLATES` in
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
| **capture-learnings** | none | Save a one-line-per-step summary of the run as a project learning. Later runs of the same template in that project start with the last three. |
| **save-to-project** | none | Write the run's step results as a Markdown file to the project's primary repo, under `.neoncore/docs/` |
| **launch-workflow** (*Continue to Workflow*) | template name; optionally a step name and the text its result must contain | Start another workflow on the same project and cartridge (or, into a confer workflow, the same team of cartridges), with this run's launch context and autonomy — **used by CE: Phase 3** to continue into Phase 4 only when Build Summary reported `STATUS: PASS`. It starts the next run once however often it is re-executed, stands down when the run is a Goal Pilot stage (the pilot sequences its own stages), refuses to start its own template, and fails the step if the template does not exist or the run has no cartridge. The new run waits for this run's remaining steps on that cartridge. (`server/src/lib/workflow-continue.ts`) |
| **slack** | Incoming Webhook URL | Post to a channel |
| **github** | PAT, repo, action | Create issues, comment on PRs, trigger workflows |
| **linear** | API key, team ID, action | Create/update Linear issues |
| **http** | URL, method, body template | Generic webhook — RequestBin, Zapier, Make, etc. |

**Template variables** in message/body templates:
`{{result}}`, `{{stepName}}`, `{{workflowName}}`, `{{agentName}}`, `{{projectName}}`, `{{timestamp}}`.
`{{result}}` is filled only when the connector has *Include output from previous step* on.

---

## Customizing templates

Open a template by clicking its name. The canvas editor lets you:

- **Add/remove steps** and drag connections between handles; **delete a connection** via the red X on an edge.
- **Add routing rules** (select a step → Routing Rules) for cyclic retry graphs.
- **Add steps of any type** from the step-type selector: a standard cartridge step, a command
  template, a quality gate, a critic/review gate, a multi-cartridge deliberation, a connector, or a
  decision checkpoint.
- **Change expert roles** — architect, backend, frontend, reviewer, security, tester, performance, researcher, planner, or general.
- **Switch prompt mode** — free-text or structured (objective + acceptance criteria + constraints).
- **Add quality gates** — test, lint, security, build, full-review, or custom, with typed outputs.
- **Toggle auto-advance** off to hold the run after a step until you have reviewed its output and advanced it.
