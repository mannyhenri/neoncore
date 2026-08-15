# Epic: Goals as the front end of autonomous delivery

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

### Phase 1: Make the hierarchy real

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-001 | Link integrity on project create/edit | Require a goal, or persist an explicit "unassigned" state that can be counted and surfaced. Applies at `routes/projects.ts`. | S | None |
| GOAL-002 | Backfill the existing 3 projects | One-off: attach the live projects to the goal, or mark them deliberately unassigned. Without this the epic's own dogfooding is inert. | S | GOAL-001 |
| GOAL-003 | Reach count on the goal | Derive "reaches N cartridges" from `project_cartridges` + `primary_repo`; expose on the goals API and render it. Zero must be loud. | S | GOAL-001 |
| GOAL-004 | Reach regression test | Set-based test asserting that a goal with projects but no cartridges reports 0 and is flagged — the exact condition that hid this for a week. | S | GOAL-003 |

### Phase 2: Master–detail Goals UI

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-010 | Split Goals into 1/3 list + 2/3 detail | Restructure `GoalsPage.tsx` to the dashboard's existing grid idiom (`lg:grid-cols-3`, sticky aside + main), goals list left, working surface right. | L | GOAL-003 |
| GOAL-011 | Goal detail surface | Right pane shows one goal: intent fields, projects, runs, cost, reach — replacing modal-only editing. | M | GOAL-010 |
| GOAL-012 | Selection state + deep link | Selected goal survives refresh and is addressable, so a notification can point at one. | S | GOAL-010 |
| GOAL-013 | Layout placement test | Extend the existing `AppChrome.placement` pattern: assert list-left / detail-right and that the detail pane owns its own scroll. | S | GOAL-010 |

### Phase 3: Rollups — cost, progress, health

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-020 | Derived progress rollup | New function beside `goalCostUsd` using the same join path; completion computed from `workflow_steps.status`, aggregated run → project → goal. | M | GOAL-001 |
| GOAL-021 | Health rollup | Aggregate `workflowNeedsAttention` upward, worst-reason-wins, reusing `ATTENTION_REASONS` rather than reimplementing. | M | GOAL-001 |
| GOAL-022 | Expose rollups on the goals API | `progress`, `health`, `cost`, `reach` on every goal read; consumed by the Phase 2 detail pane. | S | GOAL-020, GOAL-021 |
| GOAL-023 | Rollup test suite | Set-based over the states: no projects, projects without runs, mixed run states, cancelled runs excluded, finished goals not flagged. | M | GOAL-022 |

### Phase 4: Assisted goal authoring

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-030 | Goal draft endpoint | Given a sentence or two, produce a draft goal: outcome, why-now, acceptance criteria, no-gos, invariants, key results. Returns a draft, never saves directly. | M | GOAL-011 |
| GOAL-031 | Draft-and-approve UI | Detail pane offers "help me write this", shows the draft diffed against current values, user accepts per field. | M | GOAL-030 |
| GOAL-032 | Reuse the research workflows for authoring | Route the draft through an existing template (Deep Research / Product Strategy Session) rather than a bespoke prompt, so authoring improves as templates do. | M | GOAL-030 |
| GOAL-033 | Never auto-save generated intent | Test asserting a draft cannot become a saved goal without an explicit user action. | S | GOAL-031 |

### Phase 5: Decomposition — goal → projects → tasks

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-040 | Decomposition run | From a goal, launch a research/planning workflow whose output is structured candidate projects and tasks, not prose. | L | GOAL-032 |
| GOAL-041 | Structured proposal format | Define and validate the shape the run must emit (project name, task title, description, size, dependency) so it can be inserted rather than re-read by a human. | M | GOAL-040 |
| GOAL-042 | Review-and-accept queue | Proposed projects/tasks land in a review surface; user accepts, edits or rejects per item before anything is created. | M | GOAL-041 |
| GOAL-043 | Create accepted work | Accepted items become real `projects` and `tasks` rows, attached to the goal, inheriting its investment category and autonomy posture. | M | GOAL-042 |
| GOAL-044 | Decomposition provenance | Every generated project/task records which goal and which run produced it, so a bad decomposition is traceable and reversible. | S | GOAL-043 |

### Phase 6: Execution and Jira as system of record

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-050 | Dispatch accepted tasks | Accepted tasks enter the existing queue — busy-guard, holds, blocked-wait budget and completion gate all still apply. No new dispatch path. | M | GOAL-043 |
| GOAL-051 | Jira sync decision + spike | Decide: real Jira client in NeonCore vs delegating sync to a dispatched agent step using its Atlassian MCP. Spike whichever is chosen. | M | GOAL-043 |
| GOAL-052 | Push work to Jira | Create/update Jira issues for goal, projects and tasks; persist the external key on the local row. | L | GOAL-051 |
| GOAL-053 | Status reconciliation | Keep local and Jira status in step, with one side declared authoritative on conflict. | M | GOAL-052 |
| GOAL-054 | Budget enforced at the funnel | Move the ceiling from `heartbeat-scheduler` into `sendCommandToAgent` so every dispatch path is covered, escalating rather than skipping silently. | M | GOAL-022 |

### Phase 7: PM surface

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| GOAL-060 | Target date + owner | Two columns on `goals`; "late" becomes computable once progress exists. | S | GOAL-020 |
| GOAL-061 | Investment categories | One column on `goals`, inherited by projects/tasks; cost queries group by it. | M | GOAL-022 |
| GOAL-062 | Autonomy posture on the goal | Guided / Supervised / Collaborative / Assisted, read by the goal brief and defaulting workflow step behaviour. | M | GOAL-054 |
| GOAL-063 | Portfolio strip | Only if more than one goal exists: cross-goal cost/progress/health summary above the list. | M | GOAL-022 |

## Open Questions

1. **May a project exist without a goal?** Hard-require, or allow with a visible "unassigned"
   count? Decides whether GOAL-001 is validation or UX. *(carried unanswered from the brief)*
2. **Budget: block or warn at dispatch?** Blocking a manual launch mid-session is strong
   behaviour; the same flag-vs-block decision is still open on the completion gate.
   *(carried unanswered)*
3. **What counts as "done" for a goal?** Step-count progress is cheap and shallow; grading against
   the acceptance criteria that now exist is meaningful and unbuilt. *(carried unanswered)*
4. **Jira: client or delegate?** A real client in NeonCore means credentials, rate limits and
   error handling as first-class server concerns. Delegating to an agent step reuses the
   Atlassian MCP but makes sync non-transactional and only as reliable as a dispatched turn.
5. **How much may the decomposition create before a human sees it?** Nothing, a draft, or real
   rows in a pending state?
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
