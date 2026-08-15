## Research Brief: Tying development work to projects and goals

**Input:** `.neoncore/research/goals-pm-tooling.md` (deep research, 13 sources)
**Step:** 07597949 (Idea Synthesis → Your Review) · **Date:** 2026-08-12

---

### Executive Summary

The Goals area feels light because it is **structurally disconnected, not because it lacks
features**. Every capability already built on top of it is inert right now: all three projects
have `goal_id = NULL` and an empty `primary_repo`, so `goalCostUsd()` returns **0**, and
`goalForAgent()` returns **NONE** for all four live cartridges — the goal brief injects
**0 characters** into every dispatched prompt. The hierarchy exists in the schema and is empty in
practice.

That matters more than any feature gap, because the research shows NeonCore's one genuine
advantage over Jellyfish/LinearB/Swarmia is that it **captures the work→goal link at dispatch**
instead of reconstructing it afterwards from git and CI. That advantage is worth nothing while
the link is unset. Adding progress rollup, roadmaps or dependencies on top of an unpopulated
hierarchy would produce more inert features.

---

### Key Themes

- **Capture beats reconstruction.** Every commercial tool infers the work→goal link after the
  fact; Swarmia's own ceiling is ~80% categorisation. NeonCore knows the goal, project, cartridge
  and exact token cost at the moment of dispatch. Unexploited.
- **Progress should be derived, never typed.** Linear rolls initiative progress up from project
  and issue completion. NeonCore has richer raw material (step statuses, verified completion
  reports) and consumes none of it.
- **Health is a separate axis from progress**, and NeonCore's is stronger than the category's.
  `workflowNeedsAttention()` derives *needs-a-human* from real state; Linear asks a lead to type
  a status on Friday. NeonCore's version stops at the run and never reaches the goal.
- **Direction of flow is the whole story.** Cost flows *up* (`goal-cost.ts`). Intent flows *down*
  (`goal-brief.ts`). Progress flows **nowhere**. And right now, with `goal_id` unset, neither of
  the working directions actually connects.
- **Controls were built as tripwires, not as portfolio instruments.** `budget_usd` is consulted
  in exactly one place — the heartbeat scheduler — and the current goal has it set to `NULL`
  anyway. Planview's model sets ceilings *at assignment* and enforces *at runtime*.
- **Scale honesty.** 1 goal, 3 projects, 0 heartbeats, 7 runs, 0 tasks. This is a portfolio of
  one. Anything justified by "portfolio management" is premature.

---

### Top Ideas & Opportunities

**1. Make the goal↔project↔cartridge link impossible to leave empty**
*What:* require a goal when creating a project (or make "unassigned" a visible, countable state),
and surface reach directly on the goal card — "this goal reaches 0 cartridges" is the single most
useful sentence the Goals page could show today.
*Why:* it is the root cause. Two shipped features are silently dead because of it, and nothing in
the UI reveals that.
*How:* `routes/projects.ts` validation + a reach count derived from `project_cartridges` and
`primary_repo`, rendered on `GoalCard`.

**2. Derived progress rollup (goal ← project ← run ← step)**
*What:* compute completion from `workflow_steps.status`, aggregate to run, project, goal.
*Why:* Linear's decisive mechanic, and NeonCore has better inputs. Verified feasible: **7/7 runs
carry `project_id`**, and the live run has a clean 39 completed / 13 pending / 2 running split.
*How:* one derived function beside `goalCostUsd`, same join path; expose on the goals API.

**3. Health rollup — lift `workflowNeedsAttention` from run to project to goal**
*What:* the existing 5-reason registry (failed / interrupted / decision / agent-waiting /
manual-advance) already resolves most-urgent-first; roll the worst child reason upward.
*Why:* turns "is anything waiting on me?" into one glance across everything, with no human ritual.
*How:* reuse the function; aggregate rather than reimplement.

**4. Budget enforced at the dispatch funnel, with escalation instead of silence**
*What:* move the ceiling from `heartbeat-scheduler.ts` into `sendCommandToAgent`, the single
funnel that already resolves the goal for the brief.
*Why:* today a manual launch ignores the cap entirely; the scheduler skips *silently*. Planview
halts before commit and escalates to the accountable human.
*How:* `goalForAgent()` already does the resolution — the check is a few lines at a point that all
nine dispatch call sites inherit.

**5. Investment categories on the goal, auto-inherited downward**
*What:* Swarmia's mechanic — categorise the top item, auto-categorise all children.
*Why:* `goalCostUsd` answers "what did this goal cost" but cannot answer "how much of this month
was KTLO vs new work". NeonCore's hierarchy is stricter than an issue tracker's, so inheritance
would be total rather than ~80%.
*How:* one column on `goals`; cost queries group by it.

**6. Autonomy posture declared on the goal**
*What:* the arXiv ladder — Guided / Supervised / Collaborative / Assisted — set per goal.
*Why:* NeonCore already implements two rungs (trust mode, `decision` steps) but per cartridge, per
run. A PM wants to say "this goal touches billing — draft and wait" once.
*How:* a column on `goals`, read by the brief and by workflow step defaults.

**7. Target date + owner**
*What:* the two fields Linear refuses to let you skip.
*Why:* prerequisite for "late" — nothing can currently be behind schedule.
*How:* two columns; only meaningful once (2) exists, since "late" needs progress.

---

### Technical Approaches

Every anchor below was verified to exist before being cited (see Verification).

| Approach | Existing anchor to build on | Nature of change |
|---|---|---|
| Progress rollup | `goal-cost.ts` join path; `workflow_steps.status`; `workflows.project_id` (7/7 populated) | New derived function, same shape as `goalCostUsd` |
| Health rollup | `workflow-attention.ts` → `workflowNeedsAttention`, `ATTENTION_REASONS` | Aggregate existing verdicts upward |
| Budget at funnel | `send-command.ts` → `sendCommandToAgent`; `goal-brief.ts` → `goalForAgent` | Insert a check where the goal is already resolved |
| Link integrity | `routes/projects.ts`; `project_cartridges`; `projects.primary_repo` | Validation + a visible reach count |
| Investment categories | `goal-cost.ts`; `session_usage` | One column + GROUP BY |
| Autonomy posture | `goals` schema; `goal-brief.ts` | One column, consumed by the existing brief |

**Rollup shape.** `session_usage → agent(repo_path) → project(primary_repo | project_cartridges)
→ goal` is already implemented for cost and is the same path progress and health need. Build them
beside it, not parallel to it — one resolution path, three metrics.

**Where enforcement belongs.** The dispatch funnel is the only place that sees every prompt in the
fleet (nine call sites inherit from it: workflow steps, queued tasks, confer turns, epic tasks,
recovery replays, dashboard, mobile). It already carries the work standard and the goal brief.
Budget checks and autonomy posture belong there for the same reason.

---

### Open Questions

1. **Why is `goal_id` unset on all three projects?** Is the goal genuinely new, or does the
   project form make the link easy to skip? This determines whether idea (1) is validation or UX.
2. **Should a project be allowed to exist without a goal?** Requiring one is cleaner but makes
   quick project creation heavier. Alternative: allow it, but count and surface "unassigned".
3. **Budget: block or warn?** Planview halts before commit. Blocking a manual launch mid-session
   is a strong behaviour and needs the same flag-vs-block decision still outstanding on the
   completion gate.
4. **What counts as "done" for a goal?** Acceptance criteria now exist on the goal but nothing
   grades against them. Progress by step count is cheap and shallow; progress against criteria is
   meaningful and unbuilt.
5. **Is a portfolio view wanted at all at this scale?** One goal. Worth confirming before any
   cross-goal surface is designed.

---

### Recommended Direction

**Fix the linkage first, then derive progress and health from it. Do not build portfolio surface.**

The research pointed at rollup as the headline gap, and it is — but the local evidence changed the
ordering. A progress rollup added today would compute correctly and display nothing, exactly as
the cost rollup and the goal brief do now. The binding constraint is not the absence of features;
it is that the hierarchy is unpopulated and **nothing makes that visible**.

Proposed sequence:

1. **Link integrity + reach visibility** (idea 1) — small, and it un-deadens two shipped features.
2. **Derived progress rollup** (idea 2) — verified feasible; all inputs present.
3. **Health rollup** (idea 3) — reuses a function written this week.
4. **Budget at the funnel** (idea 4) — pending the block-vs-warn decision.
5. *Later:* investment categories, autonomy posture, target date + owner.
6. *Not now:* roadmap/Gantt, dependencies, scenario modelling, cross-goal portfolio views.

**Rationale.** Steps 1–3 all reuse one resolution path and one already-written health primitive,
so they are cheap and mutually reinforcing. They also convert the Goals page from a form into
something that answers the three questions a PM actually asks — *what is this costing, how far
along is it, and does anything need me* — for a portfolio of one, which is what exists.
