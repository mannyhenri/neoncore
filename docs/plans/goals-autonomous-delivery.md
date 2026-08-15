# Epic: Goals as the front end of autonomous delivery

> **Status:** planned, not started. Produced by the Deep Research workflow (2026-08-12).
> **Related:** [docs/GOALS.md](../GOALS.md) — how goals/projects/cost work today ·
> [docs/goal-aligned-ai-labor.md](../goal-aligned-ai-labor.md) — the v0.1 design doc this
> supersedes in scope · research inputs in `.neoncore/research/`.
>
> **Prerequisite finding:** `goal_id` is NULL on all 3 live projects, so `goalCostUsd()` returns
> 0 and the goal brief injects 0 characters. Phase 1 exists because of that, not for tidiness.

## Overview

Today the Goals area is a form. It stores a name, a mission paragraph, some intent fields and a
budget, and nothing downstream reads any of it — measurably: all three projects have
`goal_id = NULL`, so `goalCostUsd()` returns `0` and `goalForAgent()` returns `NONE` for every one
of the four live cartridges, which means the goal brief injects **0 characters** into every
dispatched prompt. Two features shipped this week are silently inert, and the UI gives no hint.

This epic turns that form into the front end of delivery. A goal becomes something you *author
with help* rather than type blind; something an AI pass can **decompose into projects and tasks**
using the research workflows that already exist; something that then **executes** without the
user hand-entering work; and something that **reports back** — cost, progress and health rolled
up from real execution state rather than from a status someone remembers to update. Jira becomes
the external system of record for the work produced.

The strategic case comes from the research: every commercial tool in this space (Jellyfish,
LinearB, Swarmia) *reconstructs* the link between work and goals after the fact from git and CI,
and Swarmia's own ceiling is ~80% categorisation. NeonCore **captures that link at dispatch** —
it knows the goal, the project, the cartridge and the exact token cost at the moment work starts.
That advantage is worth nothing while the link is unset, which is why Phase 1 is plumbing and not
features.

## Business Goals

- **Eliminate manual task entry**: a goal stated once produces its own projects and tasks via the
  existing research workflows — "fully eliminating me typing each task or filling them up from
  another source."
- **Concept to shipped feature**: an authored goal can run all the way through execution without
  the user acting as the transport layer between thinking and doing.
- **Make intent reach the workers**: the goal brief already exists and injects nothing; connecting
  it means every dispatched prompt in the fleet carries the outcome, criteria and no-gos.
- **Answer the three PM questions from state, not from memory**: what is this costing, how far
  along is it, does anything need me.
- **Jira as the system of record**: work produced by the fleet is tracked externally where the
  rest of the organisation can see it.
- **Give a PM real authoring tools**: goals and expectations fleshed out with assistance rather
  than typed into eight blank fields.

## Current State

| Component | Current State |
|-----------|---------------|
| `goals` schema | 14 columns: name, description, success_metric, budget_usd, token_budget, status + acceptance_criteria, no_gos, rabbit_holes, invariants, key_results (added this week) |
| `projects` schema | 8 columns: goal_id, name, description, primary_repo, color — **`goal_id` NULL on 3/3 rows**, `primary_repo` empty on 3/3 |
| Goal → cartridge resolution | `goalForAgent()` exists (`lib/goal-brief.ts`), returns **NONE** for all 4 live cartridges |
| Goal brief injection | `buildGoalBrief()` wired into `sendCommandToAgent` (9 call sites inherit) — produces **0 chars** today |
| Cost rollup | `goalCostUsd()` / `projectCostUsd()` (`lib/goal-cost.ts`) work correctly, return **0** for lack of linkage |
| Progress | **None at any level.** `workflows.project_id` populated 7/7; `workflow_steps.status` carries completed/pending/running; nothing consumes them |
| Health | `workflowNeedsAttention()` + `ATTENTION_REASONS` (`lib/workflow-attention.ts`) — derived, 5 reasons, **stops at the run** |
| Budget enforcement | `budget_usd` read in exactly one place (`lib/heartbeat-scheduler.ts`); manual launches ignore it; current goal has it `NULL` |
| Goal authoring UI | 8 hand-typed fields in a modal (`GoalForm`, `GoalsPage.tsx`) |
| Goals page layout | Single full-width column, 1475 lines, 13 components, modal-driven |
| Task creation | `POST /api/tasks` exists; nothing auto-populates it from a goal |
| Decomposition | **Nothing reads a goal and proposes work.** 20 workflow templates exist (Deep Research 7 steps, CE: Full Delivery 47 steps, etc.) but none is goal-aware |
| Jira | **No integration in NeonCore.** No HTTP client, no `atlassian` reference, not exposed via MCP. `jira_task_id` is a dormant column copied template→run. Two prompt-level templates ("Jira Tasks Validation/Completion") rely on the *agent's own* Atlassian MCP |
| Live data | 1 goal, 3 projects, 0 heartbeats, 7 runs, 0 tasks |

## Target State

| Component | Target State |
|-----------|---------------|
| Goal → project → cartridge | Always resolvable, or visibly and countably "unassigned". Reach shown on the goal ("reaches N cartridges") |
| Goal brief | Reaches every dispatched prompt for cartridges under a goal |
| Cost rollup | Unchanged mechanically, but non-zero — plus grouped by investment category |
| Progress | Derived: goal ← project ← run ← step, from `workflow_steps.status` |
| Health | `workflowNeedsAttention` aggregated run → project → goal, worst-reason-wins |
| Budget | Enforced at `sendCommandToAgent` for every dispatch path, with escalation rather than silent skip |
| Goal authoring | Assisted: a conversational/AI pass drafts outcome, criteria, no-gos, invariants, key results for approval |
| Decomposition | A goal can generate candidate projects and tasks via existing research workflows, presented for approval |
| Execution | Approved tasks dispatch through the existing queue, respecting busy-guard, holds and budget |
| Jira | Work synced outward as the external system of record, via the agent's Atlassian MCP |
| Goals page layout | Master–detail: goals list in the left 1/3, working surface in the right 2/3 |
| PM fields | Target date, owner, investment category, autonomy posture on the goal |

## Constraints

- **Linkage is the hard prerequisite.** Every capability in this epic — brief, cost, progress,
  health, decomposition, execution — resolves through `goal → project → cartridge`. It is `0/3`
  today. Nothing else in the epic works until this does.
- **One resolution path, not four.** `session_usage → agent(repo_path) → project(primary_repo |
  project_cartridges) → goal` already exists for cost. Progress and health must be built *beside*
  it, not as parallel implementations that can disagree.
- **One enforcement point.** `sendCommandToAgent` is the only place that sees every prompt in the
  fleet (workflow steps, queued tasks, confer turns, epic tasks, recovery replays, dashboard,
  mobile). Budget and autonomy posture belong there, as the work standard and goal brief already do.
- **NeonCore has no Jira client.** Jira access exists only inside agents via their Atlassian MCP.
  Either NeonCore gains a real client (new surface, credentials, error handling) or sync is
  delegated to a dispatched agent step. This is a decision, not an implementation detail.
- **Autonomous execution must not bypass existing safety.** The queue's busy-guard, per-item
  holds, blocked-wait budget and work-standard completion gate all stay in force. Auto-generated
  tasks are still tasks.
- **Accepted risk — scale.** Live data is 1 goal, 3 projects, 0 tasks. The brief argued a full PM
  surface is premature at a portfolio of one; the user heard that and chose it deliberately. It is
  recorded here rather than dropped.
- **Generated content needs human approval before it executes.** An AI pass that both invents the
  work and runs it, unreviewed, is how a goal quietly burns a budget on the wrong thing.
- **The Goals page is 1475 lines / 13 components.** The master–detail restructure is a real
  refactor, not a CSS change.

## Task Breakdown

### Phase 1: Make the hierarchy real — ✅ DONE (2026-08-13)

Two bugs surfaced by building it, neither visible from reading the code:

- **`goalCostUsd()` read only `projects.primary_repo`.** Any project owning cartridges through
  `project_cartridges` billed $0 permanently. Invisible until reach shipped beside it and one
  card read "reaches 2 cartridges" next to "$0.00" — two numbers on one card contradicting each
  other, which is worse than the silence this phase replaced. Fixed with a UNION over both
  ownership routes.
- **`DELETE /api/projects/:id` orphaned `project_cartridges`.** No FK, and reach/cost both JOIN
  through `projects`, so orphans drop silently out of every query. Found while measuring the
  project cleanup, one step before it would have done the most damage. Fixed with
  `deleteProjectCascade`.

Both were caught by the same rule: reach, cost and the brief all answer *"which cartridges belong
to this goal"*, and the tests assert the three AGREE rather than matching hand-written numbers.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-001 | Surface unassigned projects | **Rescoped 2026-08-13:** do NOT require a goal (decision: keep quick project creation frictionless). Instead expose "unassigned" as a countable state on the projects API and show the count, so an empty hierarchy is visible rather than silent. | S | None |
| GOAL-002 | Backfill the existing 3 projects | One-off: attach the live projects to the goal, or mark them deliberately unassigned. Without this the epic's own dogfooding is inert. | S | GOAL-001 |
| GOAL-003 | Reach count on the goal | Derive "reaches N cartridges" from `project_cartridges` + `primary_repo`; expose on the goals API and render it. Zero must be loud. | S | GOAL-001 |
| GOAL-004 | Reach regression test | Set-based test asserting that a goal with projects but no cartridges reports 0 and is flagged — the exact condition that hid this for a week. | S | GOAL-003 |

### Phase 2: Master–detail Goals UI — ✅ DONE (2026-08-13)

**The 1/3 is App's `<aside>`, not a nested split.** `GoalsPage` rendered inside `<main>` could only
ever produce a 1/3 of the 2/3 — the same proportions in the wrong place. So the page split into
`GoalsProvider` / `GoalsRail` / `GoalsWorkspace`, two surfaces App places in separate regions over
one context. The provider stays mounted and fetches only when Goals is active, so switching views
neither refetches the hierarchy nor remounts the cartridge tree.

Two defects found in flight, both invisible to source-text tests and caught by opening the page:

- **Confer was unreachable from Goals and Tasks.** Moving it beside `+ New Workflow` (an earlier,
  correct styling fix) put it inside `WorkflowPanel`, which renders only on the Agents view. The
  old placement test asserted Confer lived in that panel, so it *locked the defect in*. Moved to
  the header with Launch and New Repo; the test now asserts reachability — that it sits outside
  every view guard — rather than which component owns it.
- **A goal deep link addressed the goal but not the view.** `#goal/<id>` in a fresh tab opened on
  Agents with the goal selected in a pane nothing was rendering. The hash was doing exactly half
  its job, and the skipped half is the half a notification link needs. Fixed on load and on
  `hashchange`.

**Selection is resolved, never trusted.** A deleted goal, a stale link, or `#goal/unassigned` on a
day when every project has a goal each left a blank 2/3 beside a full rail. `resolveSelection()`
separates what was *requested* from what can be *shown*, and always falls back to something real.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-010 | Split Goals into 1/3 list + 2/3 detail | Restructure `GoalsPage.tsx` to the dashboard's existing grid idiom (`lg:grid-cols-3`, sticky aside + main), goals list left, working surface right. | L | GOAL-003 |
| GOAL-011 | Goal detail surface | Right pane shows one goal: intent fields, projects, runs, cost, reach — replacing modal-only editing. | M | GOAL-010 |
| GOAL-012 | Selection state + deep link | Selected goal survives refresh and is addressable, so a notification can point at one. | S | GOAL-010 |
| GOAL-013 | Layout placement test | Extend the existing `AppChrome.placement` pattern: assert list-left / detail-right and that the detail pane owns its own scroll. | S | GOAL-010 |

### Phase 3: Rollups — cost, progress, health — ✅ DONE (2026-08-13)

**One resolution path, now four metrics — enforced structurally, not by assertion.** Reach and
cost each carried their own copy of the ownership UNION *and resolved repo paths by different
rules*: cost through `agentIdsForRepo` (which normalizes case, separators, drive letters and
trailing slashes), reach through an exact `IN (...)` in SQL. They agreed on every test only
because the fixtures spelled each path one way. On a real machine `/Users/x/Repo/` and
`/users/x/repo` are the same cartridge, and a goal would have read "reaches no cartridges" beside
a non-zero spend — Phase 1's contradiction, reintroduced from the other side. Two copies can be
held together by a test; four cannot, so everything now goes through `lib/goal-scope.ts`.

**`null` is not `0`, and that distinction is the whole feature.** "0% complete" claims work
started and got nowhere; "no runs yet" says nothing was ever asked of this goal. Collapsing them
recreates the exact defect this epic exists to fix. `fraction` is null whenever there is nothing
to measure, `progressView()` carries it into words, and the UI draws **no bar at all** — because
all that care dies at the first `?? 0` in a component.

**Health aggregates, it does not re-derive.** `workflowNeedsAttention` owns the reasons and their
order; the goal rollup ranks by index into `ATTENTION_REASONS`, so adding a reason orders it at
goal level automatically. `AttentionReason` was spelled inline in three places — the server types,
the shared client package, and the attention module — and is now defined once.

Two exclusions that would otherwise be permanent, silent distortions:
- **Cancelled runs** leave the denominator entirely. The three cancelled `CE: Full Delivery` runs
  held 133 pending steps between them — enough to cap a finished goal near 30% forever for a
  decision that was deliberate.
- **Templates** never count. They carry `template_id IS NULL` and 165 permanently-pending steps;
  counting them would peg every goal low with no amount of finished work able to move it.

The suite was mutation-tested rather than trusted: four deliberate breakages (fabricate 0 for
null, stop excluding cancelled, admit templates, invert the worst-reason ranking). The first pass
caught three — the template test was **vacuous**, because its fixture left `project_id` NULL, so
the project filter excluded the template before the template filter was ever consulted. Fixed by
attaching the template to the goal's own project.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-020 | Derived progress rollup | New function beside `goalCostUsd` using the same join path; completion computed from `workflow_steps.status`, aggregated run → project → goal. | M | GOAL-001 |
| GOAL-021 | Health rollup | Aggregate `workflowNeedsAttention` upward, worst-reason-wins, reusing `ATTENTION_REASONS` rather than reimplementing. | M | GOAL-001 |
| GOAL-022 | Expose rollups on the goals API | `progress`, `health`, `cost`, `reach` on every goal read; consumed by the Phase 2 detail pane. | S | GOAL-020, GOAL-021 |
| GOAL-023 | Rollup test suite | Set-based over the states: no projects, projects without runs, mixed run states, cancelled runs excluded, finished goals not flagged. | M | GOAL-022 |

### Phase 4: Assisted goal authoring — ✅ DONE (2026-08-13)

**NeonCore still has no LLM client, and that was a decision, not an omission.** A server-side
Anthropic call would have been the shorter path, but `goalCostUsd` is built on `session_usage`,
which only exists for cartridge work — so generation from the server would be real money spent
against a goal whose own cost rollup could not see it. That is exactly the invisibility Phases 1
and 3 were spent removing. Drafting therefore dispatches to a cartridge like every other prompt,
through the same `guardBusy` queue, and its cost lands on the goal it was spent on.

**A draft is a proposal; `applied_at` is the proof.** Goal intent is not notes — `goal-brief.ts`
injects it into every prompt dispatched under the goal, so an invented acceptance criterion does
not stay a bad sentence, it becomes a standing instruction other agents act on. So the design is
per-field accept with the current value shown beside each proposal, and the invariant is tested
as a NEGATIVE: a set-based sweep over every mutating operation (create, submit, submit twice,
fail, submit garbage) asserting the goal row stays byte-identical. Replay of an applied draft is
refused, unknown keys cannot be smuggled through accept, and empty proposals are dropped so
accepting can never blank a field the user typed by hand.

`DRAFTABLE_FIELDS` is the single source for the prompt, the validation and the UI — a field the
prompt asks for but `applyDraft` cannot write would be one the user accepts to no effect, so a
test iterates the registry and applies each field individually.

Mutation-tested rather than trusted: writing the goal on submit, dropping the replay guard,
applying all fields instead of the chosen ones, and admitting unknown keys were each introduced
deliberately and each broke tests. (The first run of the fourth reported a false pass — the sed
anchor missed by two spaces, so no mutation was applied.)

Routing: `neoncore_submit_goal_draft` is registered **T5 (judgement)**. Deciding what is genuinely
measurable, what belongs out of scope, and above all what to leave BLANK rather than invent is the
hard part — and a plausible, fully-populated, confabulated draft is indistinguishable from a
grounded one until the work goes wrong.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-030 | Goal draft endpoint | Given a sentence or two, produce a draft goal: outcome, why-now, acceptance criteria, no-gos, invariants, key results. Returns a draft, never saves directly. | M | GOAL-011 |
| GOAL-031 | Draft-and-approve UI | Detail pane offers "help me write this", shows the draft diffed against current values, user accepts per field. | M | GOAL-030 |
| GOAL-032 | Reuse the research workflows for authoring | Route the draft through an existing template (Deep Research / Product Strategy Session) rather than a bespoke prompt, so authoring improves as templates do. | M | GOAL-030 |
| GOAL-033 | Never auto-save generated intent | Test asserting a draft cannot become a saved goal without an explicit user action. | S | GOAL-031 |

### Phase 5: Decomposition — goal → projects → tasks — ✅ DONE (2026-08-13)

Same contract as Phase 4, higher stakes: a draft proposes TEXT, a decomposition proposes
PROJECTS AND TASKS — and accepted tasks get dispatched to cartridges that change repositories.
So the never-auto-create invariant is tested as a negative, swept over every operation that is
not an explicit accept, asserting the goal's project and task counts are unchanged.

**Validation is the feature.** The point of a structured format is that output can be INSERTED
rather than re-read by a human, which only holds if the shape is guaranteed. Everything a
cartridge sends is normalized, and anything dropped is RECORDED and shown — silent truncation
would present a mangled plan as the model's actual output, in a surface whose only job is review.
Verified live against a deliberately broken submission: a nameless project, a titleless task, a
dependency on a task that does not exist, and a two-task cycle were each dropped and each named.

**Dependencies do something today.** `tasks` had no dependency column, so the proposal's ordering
would have been discarded at accept — throwing away something the user reviewed. It is now stored,
AND acceptance derives each task's `priority` from its dependency depth, so prerequisites sort
ahead of dependents in the queue immediately rather than waiting for Phase 6 to enforce anything.
This is the repo's characteristic failure mode (building a mechanism no data flows through) being
avoided deliberately.

**A task is never created without its project.** Accepting one would produce work attached to
nothing — the exact unassigned state Phase 1 exists to make visible. Those tasks are skipped and
reported rather than having their parent silently created.

**Revert is honest about what it cannot undo.** Work that has already STARTED is never deleted: a
claimed or finished task is a record of what a cartridge actually did. Those are kept and named,
so "reverted" never overstates what happened. It also clears `project_cartridges` explicitly —
there is no foreign key, which is how Phase 1's delete route orphaned rows.

Mutation-tested: dropping the already-accepted guard, creating tasks for unaccepted projects,
constant priority, silent edge-dropping, and deleting started work were each introduced and each
broke tests. The priority mutation initially passed — with equal priorities SQLite returned
insertion order, which happened to equal dependency order, so the test could not tell sorting
from luck. Fixed by declaring the fixture's tasks in reverse dependency order and asserting the
priorities actually differ.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-040 | Decomposition run | From a goal, launch a research/planning workflow whose output is structured candidate projects and tasks, not prose. | L | GOAL-032 |
| GOAL-041 | Structured proposal format | Define and validate the shape the run must emit (project name, task title, description, size, dependency) so it can be inserted rather than re-read by a human. | M | GOAL-040 |
| GOAL-042 | Review-and-accept queue | Proposed projects/tasks land in a review surface; user accepts, edits or rejects per item before anything is created. | M | GOAL-041 |
| GOAL-043 | Create accepted work | Accepted items become real `projects` and `tasks` rows, attached to the goal, inheriting its investment category and autonomy posture. | M | GOAL-042 |
| GOAL-044 | Decomposition provenance | Every generated project/task records which goal and which run produced it, so a bad decomposition is traceable and reversible. | S | GOAL-043 |

### Phase 6: Execution — ✅ DONE (2026-08-13), Jira DROPPED

**GOAL-051/052/053 are not built, and are not deferred — they are cancelled.** The user chose
local-only for Jira (2026-08-13). Building a Jira client, a push, and a status reconciliation
against a decision to keep everything local would be three features nobody asked for. The phase
title is kept as written so the change of scope is visible rather than quietly edited away.

**Ordering is now ENFORCED, not merely influenced.** Phase 5 derived queue `priority` from
dependency depth, which makes prerequisites SORT first — but sorting only decides what a free
cartridge picks up next. A second idle cartridge, or one click of "Send to agent", still starts a
dependent whose prerequisite has not run; it then works against a codebase missing what it was
written to assume and fails looking like a bad prompt rather than a scheduling bug.
`lib/task-dependencies.ts` is the gate, and it lives outside the queue on purpose so BOTH entry
points consult it — a check inside the runner would leave the manual button as an unguarded back
door, which is exactly how the busy-guard was bypassed before it moved to a shared helper.

**A defect from Phase 5, found and fixed here.** `depends_on` stored proposal KEYS (`["bench"]`),
which are unresolvable once the proposal is gone — so nothing at runtime could tell whether a
prerequisite had finished. The column looked populated and meant nothing. Acceptance now rewrites
keys to created task IDs in a second pass, dropping dependencies on tasks the user declined to
create (declining the prerequisite is a decision that it is not required; keeping the edge would
block the dependent forever with no way to clear it).

**Only `done` releases a dependent.** A failed prerequisite does not: the dependent was written
assuming the outcome exists, so running it produces confident work on a false premise — worse
than a task sitting visibly blocked. All six prerequisite states are swept in one test.

**Release goes through the EXISTING queue.** No new dispatch path, because the queue owns the
busy guard, per-item holds, the blocked-wait budget and the completion gate — and decomposition
is the feature that produces tasks in bulk, so bypassing those would do the most damage here.
Three separate sites finish a task (owner report, dashboard override, Stop-hook autocomplete) and
all three must release dependents; a test enumerates them, because the failure being guarded is a
fourth path added later without the release, which no runtime test of the existing three catches.

**GOAL-054: budget at the funnel.** The cap was consulted in exactly one place —
`heartbeat-scheduler` — so manual launches, queued tasks, confer turns, workflow steps and
dashboard prompts all ignored it. It now sits in `sendCommandToAgent`, which nine call sites
inherit from. It **warns and never blocks** (the user's decision): blocking mid-session strands
work someone is actively doing. The heartbeat gate deliberately still BLOCKS — it fires unattended
with nobody watching, so attended-warns/unattended-blocks is a real distinction, not an
inconsistency. Both read spend from `goalCostUsd` so they cannot disagree about "over". Alerts
fire once per escalation, persisted on the goal row because `tsx watch` restarts the server on
every save and an in-memory guard would re-warn several times an hour.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-050 | Dispatch accepted tasks | Accepted tasks enter the existing queue — busy-guard, holds, blocked-wait budget and completion gate all still apply. No new dispatch path. | M | GOAL-043 |
| GOAL-051 | Jira sync decision + spike | Decide: real Jira client in NeonCore vs delegating sync to a dispatched agent step using its Atlassian MCP. Spike whichever is chosen. | M | GOAL-043 |
| GOAL-052 | Push work to Jira | Create/update Jira issues for goal, projects and tasks; persist the external key on the local row. | L | GOAL-051 |
| GOAL-053 | Status reconciliation | Keep local and Jira status in step, with one side declared authoritative on conflict. | M | GOAL-052 |
| GOAL-054 | Budget enforced at the funnel | Move the ceiling from `heartbeat-scheduler` into `sendCommandToAgent` so every dispatch path is covered, escalating rather than skipping silently. | M | GOAL-022 |

### Phase 7: PM surface — ✅ DONE (2026-08-13)

The phase the research argued against at this scale ("1 goal, 3 projects, 0 tasks — a portfolio
of one"). The user overruled it, which is recorded above as an accepted risk. Rather than
re-litigate, the objection is **encoded**: `shouldShowPortfolio()` returns false at one goal, so
the strip the research called premature does not render until there is a portfolio to view.

**Unset is a real state everywhere, never a default.** A goal with no target date has no
schedule — it is not "on time", and a badge on every goal would mean nothing. An unset autonomy
posture stays unset: defaulting to `assisted` would hand every unconfigured goal maximum
latitude, defaulting to `guided` would stall every existing one, and neither is a decision
anyone made. Uncategorised spend is reported as its own slice rather than dropped, because
hiding it makes the split look complete while the largest share is missing.

**Autonomy travels as an instruction, not a label.** "This goal is Supervised" is a word; the
brief carries what the posture REQUIRES ("stop before anything irreversible… and ask"), because
the brief is injected at dispatch and a label changes no behaviour. Verified against the live
goal: the compiled brief contains the instruction.

**Which fields reach the agent was a decision, not an oversight.** The brief test's registry
encodes "authored ⇒ must reach the agent", and Phase 7 added two fields that premise does not
hold for. Rather than weakening the rule or padding the brief with fields that change nothing,
`owner` and `investment_category` are listed in `AUTHORED_NOT_DISPATCHED` **with the reason**.
Target date does travel: it changes how work is scoped.

**Portfolio progress is weighted by steps, not by averaging goal percentages** — otherwise one
finished 2-step goal beside an untouched 200-step goal reads as 50% done.

Two bugs found by opening the page rather than by the tests:
- `GET /goals/portfolio` was declared AFTER `GET /:id`, so Express matched `/:id` first and the
  endpoint answered `{"error":"Goal not found"}`. The comment above the route claimed it was
  declared first while it was not; there is now a test asserting the ORDER rather than the note.
- The shared `Modal` had no height cap, so a form taller than the viewport lost its title off
  the top and its Save button off the bottom, unreachable — a `fixed inset-0` overlay stops the
  page behind it scrolling. Latent before; the planning fields pushed the goal form over the
  line. Fixed on the Modal, not on one form.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-060 | Target date + owner | Two columns on `goals`; "late" becomes computable once progress exists. | S | GOAL-020 |
| GOAL-061 | Investment categories | One column on `goals`, inherited by projects/tasks; cost queries group by it. | M | GOAL-022 |
| GOAL-062 | Autonomy posture on the goal | Guided / Supervised / Collaborative / Assisted, read by the goal brief and defaulting workflow step behaviour. | M | GOAL-054 |
| GOAL-063 | Portfolio strip | Only if more than one goal exists: cross-goal cost/progress/health summary above the list. | M | GOAL-022 |

## Open Questions

> **Checked against [docs/goal-aligned-ai-labor.md](../goal-aligned-ai-labor.md) (v0.1, May 2026).**
> It settles Q1 and Q2; Q3–Q7 are outside its scope. Note its status header is stale — decision
> steps, `outputSchema`, the learnings connector and heartbeats are all now built.

1. ~~**May a project exist without a goal?**~~ **ANSWERED — yes, by design.** v0.1 specifies
   `goal_id TEXT REFERENCES goals(id)` (nullable) and states the principle: *"Project assignment
   is always optional — no friction for existing users."* So `goal_id` NULL on 3/3 projects is the
   design working as intended, not neglect. **This inverts GOAL-001**: requiring a goal would
   reverse a deliberate decision. The remaining question is narrower and is now the user's:
   *is the measured cost of optionality worth reversing it?* **DECIDED 2026-08-13 — keep it
   optional.** User: *"shouldn't require a goal on every project just in case we just need to
   work quickly on something."* This upholds the v0.1 principle. **GOAL-001 is therefore rescoped
   from "require a goal" to "make unassigned visible and countable"** — the real defect was
   silence, not permissiveness.
2. ~~**Budget: block or warn at dispatch?**~~ **ANSWERED — warn.** v0.1: *"Cost cap warning: when
   a project's accumulated spend approaches the parent goal's `budget_usd`, show a warning
   banner."* Softer than blocking at the cap. What shipped is both harder and narrower than
   designed — `heartbeat-scheduler` *skips* at `>= budget_usd`, in one call site only. **GOAL-054
   should therefore warn at the funnel, not block**. **DECIDED 2026-08-13 — warn.** User: *"For
   budget, warn."* Matches v0.1; GOAL-054 is confirmed as a warning, not a block.
3. **What counts as "done" for a goal?** Still open. v0.1 assumed manual judgement — `success_metric`
   is free text ("what done looks like") and `achieved` is a human-set status — so grading against
   acceptance criteria would be new ground, not a return to an earlier intent. *(carried unanswered)*
4. **Jira: client or delegate?** A real client in NeonCore means credentials, rate limits and
   error handling as first-class server concerns. Delegating to an agent step reuses the
   Atlassian MCP but makes sync non-transactional and only as reliable as a dispatched turn.
5. **How much may the decomposition create before a human sees it?** Nothing, a draft, or real
   rows in a pending state? v0.1 has no decomposition at all, so there is no prior position.
   Note GOAL-041 should extend the existing `outputSchema` mechanism (built, per 2b of the design
   doc) rather than inventing a proposal format.
6. **Does the goal own an autonomy posture that can override a cartridge's trust mode**, or only
   default it?
7. **What happens to a goal's generated tasks when the goal changes?** Regenerate, diff, or leave
   them as the historical record of what was decided?

## Success Metrics

- **Linkage is non-zero and visible.** `SELECT COUNT(*) FROM projects WHERE goal_id IS NOT NULL`
  is 3/3, and `goalForAgent()` resolves for every live cartridge under a goal.
- **The brief actually ships.** `goalBriefForAgent()` returns > 0 characters for cartridges under
  a goal, and a dispatched prompt visibly carries the outcome and no-gos.
- **Cost is non-zero and attributable.** `goalCostUsd()` reflects real spend, broken down by
  investment category.
- **Progress is derived, never typed.** Goal progress changes without anyone editing a field, and
  matches the underlying `workflow_steps` counts.
- **Health reaches the goal.** A decision gate or failed step anywhere under a goal surfaces on
  that goal within one poll.
- **A goal produces its own work.** At least one goal goes from a stated sentence to accepted
  projects and tasks with zero manual task entry.
- **Execution runs unattended without bypassing safety.** Generated tasks dispatch through the
  existing queue and are still subject to the busy-guard, holds and the completion gate.
- **Jira reflects the fleet.** Goal, projects and tasks exist in Jira with local rows carrying the
  external keys.
- **The layout matches the ask.** Goals list occupies the left 1/3; the working surface occupies
  the right 2/3.
