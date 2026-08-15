# Deep Research — Improving the Goals area for project managers

**Subject:** how to give project managers better tooling that ties development work to projects/goals.
**Date:** 2026-08-12 · **Step:** 50079ffc (Deep Research → Idea Synthesis)

---

## Web Findings

### 1. Linear — Initiatives, and progress that is *derived* rather than typed
- **Initiatives** — https://linear.app/docs/initiatives
- **Initiative and Project updates** — https://linear.app/docs/initiative-and-project-updates
- **Introducing Initiatives (changelog)** — https://linear.app/changelog/2024-06-25-introducing-initiatives

Three-level hierarchy: **Initiative → Project → Issue**. The decisive mechanic is that *progress
aggregates upward automatically* — "each curve on an initiative graph represents the rate of
completed issues within a single project", and leadership can "assess overall progress without
needing to drill down". No manual progress entry.

Health is a **separate axis from progress**: On track / At risk / Off track, set by the project
lead (in practice a Friday ritual) and rolled up as a colour on the initiative. Projects are
forced to have a **lead, a status, and a target date** — the three fields Linear refuses to let
you skip.

*Relevance:* NeonCore already has the hierarchy. It has none of the rollup.

### 2. Swarmia — investment balance, and auto-categorisation from the top item
- **Investment balance** — https://help.swarmia.com/features/focus/balance-engineering-investments
- **Investment categories** — https://help.swarmia.com/settings/organization/investment-balance
- **Investment distribution** — https://www.swarmia.com/investment-distribution/

"Once your highest-level work items are categorised (e.g. initiatives or epics), Swarmia will
process the issue hierarchy automatically to auto-categorise all remaining child issues and
related coding contributions." Categories are **mutually exclusive and collectively exhaustive**;
the recommended default is Dropbox's Balance framework — *New things / Improvements /
Productivity / Keeping the lights on*. Target: ≥80 % categorised by automated rules.

Cost: "add the average fully loaded cost per engineer, so you can see the exact cost of each
initiative or epic."

*Relevance:* NeonCore computes real cost per goal already, and its cost is exact rather than
estimated (real token spend, not a loaded hourly rate). What it lacks is **categories** — there
is no way to ask "how much of this month went to KTLO versus new work".

### 3. Engineering-intelligence market — three buyers, three products
- **LinearB vs Jellyfish vs Swarmia** — https://wetheflywheel.com/en/comparisons/linearb-vs-jellyfish-vs-swarmia/
- **Jellyfish vs LinearB buyer's guide** — https://linearb.io/blog/linearb-vs-jellyfish-buyers-guide
- **SEI platform guide** — https://codepulsehq.com/guides/software-engineering-intelligence-platform-guide

The segmentation is instructive: **Jellyfish** sells *business alignment* (investment allocation,
board reporting) to VPs/CTOs; **LinearB** sells *workflow efficiency* (cycle-time breakdown,
automation) to EMs; **Swarmia** sells *developer buy-in* to teams. All three aggregate from git,
CI, and the issue tracker — i.e. they **reconstruct** the link between work and goals after the
fact, because that link was never captured at the source.

*Relevance:* NeonCore does not have to reconstruct anything. The link is captured at dispatch.

### 4. Planview — "Agent Resource Management" (the closest prior art to NeonCore's actual problem)
- **Press release** — https://newsroom.planview.com/planview-launches-agent-resource-management-redefining-portfolio-resource-management-for-the-ai-era/

Announced for Fall 2026. Concretely:
- agents are deployed to portfolio work with **authority boundaries, budget ceilings and
  escalation paths set at the moment of assignment**;
- **"human resources, AI agents, and their full associated costs (including compute and token
  spend) in one view, attributed to specific work and strategic initiatives"**;
- **runtime policy enforcement** — "actions are halted before they commit, with automatic
  escalation to the accountable human";
- continuous audit trail of agent actions, human approvals and policy events.

*Relevance:* This is NeonCore's problem statement written by someone else. NeonCore already has
token-cost attribution to goals and a budget field; it lacks assignment-time boundaries,
runtime enforcement, and the portfolio view.

### 5. Academic — *Toward Agentic Software Project Management: A Vision and Roadmap*
- **arXiv 2601.16392** — https://arxiv.org/html/2601.16392v1

Proposes "SPM 3.0" and an **Agentic PM** — a coordinating agent over specialised sub-agents
(planning, risk analysis, task management) with a central database of outcomes and feedback.
Its most usable contribution is **four autonomy modes selected by task risk**:

1. *Guided AI-Autonomy* — agent acts, human reviews after (low-risk, e.g. meeting notes)
2. *Supervised-AI* — agent drafts, human approves **before** execution
3. *Human-AI Collaborative* — mutual contribution (sprint planning, estimation)
4. *AI-Assisted* — human leads, agent analyses (strategy, negotiation)

Humans retain ultimate decision authority and ethical oversight throughout. The authors are
explicit that the vision is **not empirically validated**.

*Relevance:* NeonCore already implements two of these modes without naming them — trust mode is
Guided AI-Autonomy; a `decision` step is Supervised-AI. Naming them at the *goal* level would
let a PM set risk posture per goal instead of per cartridge.

### 6. Fleet organisation patterns
- **AI Agent Fleet Management** — https://fast.io/resources/ai-agent-fleet-management/
- **The PM AI Agent Fleet** — https://medium.com/@falkgottlob/the-pm-ai-agent-fleet-39-agents-mapped-to-the-7-stage-operating-system-92b1b7065bba

Tiering pattern: Tier 1 specialists do the work, Tier 2 coordinators decompose and manage, Tier 3
strategic agents plan from goals. NeonCore's confer/workflow split is a partial Tier 1/2; there
is no Tier 3 (nothing reads a goal and *proposes* the work).

---

## Local Findings

### The data model (10 tables, 19 code surfaces)

| Surface | What it holds |
|---|---|
| `goals` | id, name, description, success_metric, **budget_usd**, status, token_budget, + (added today) acceptance_criteria, no_gos, rabbit_holes, invariants, key_results |
| `projects` | id, **goal_id**, name, description, primary_repo, color |
| `project_cartridges` | project_id → repo_path (the many-repos link) |
| `project_knowledge`, `project_learnings` | per-project memory |
| `heartbeats` | project_id + template_id + schedule (scheduled runs) |
| `workflows` | runs, linked by `project_id`; steps in `workflow_steps` |
| `tasks` | `project_id` |
| `session_usage` | per-cartridge token spend — the raw material for cost |
| `epic_runs` | vestigial (0 rows, no UI) |

Code surfaces referencing a goal or project — 19 files, listed in full because the shape of the
list is itself a finding (server-heavy, one page of UI, almost nothing on mobile):

```
server/src/db.ts                              server/src/types.ts
server/src/routes/goals.ts                    server/src/routes/projects.ts
server/src/routes/heartbeats.ts               server/src/routes/tasks.ts
server/src/routes/workflows.ts
server/src/lib/goal-brief.ts                  server/src/lib/goal-cost.ts
server/src/lib/heartbeat-scheduler.ts         server/src/lib/resolve-agent.ts
server/src/lib/task-autocomplete.ts           server/src/lib/workflow-executor-v2.ts
dashboard/src/components/GoalsPage.tsx        dashboard/src/components/TasksPage.tsx
dashboard/src/hooks/useAgents.ts
packages/client/src/client.ts                 packages/client/src/types.ts
mobile/src/config.ts
```

Note the asymmetry: **one** dashboard page owns the entire PM surface, and `mobile/src/config.ts`
is a constant — a goal is effectively invisible from a phone.

### What already works

- **Cost rolls up correctly.** `lib/goal-cost.ts` → `session_usage → agent(repo_path) →
  project(primary_repo) → goal`. Two functions: `projectCostUsd`, `goalCostUsd`. This is
  Swarmia's cost-per-initiative, with *real* spend rather than a loaded rate.
- **Intent now flows down.** `lib/goal-brief.ts` (added today) compiles the goal into a brief
  injected at `sendCommandToAgent` — the single funnel every prompt passes through, so all nine
  dispatch call sites inherit it.
- **A machine-derived health signal exists.** `lib/workflow-attention.ts` (added today) derives
  *needs-a-human* from step state — failed / interrupted / decision / agent-waiting /
  manual-advance — ordered most-urgent-first.

### What is absent (measured, not asserted)

Grepping `server/src/types.ts`, `routes/goals.ts`, `routes/projects.ts` for PM primitives:

```
targetDate|target_date        0 hits
health                        0 hits
owner|assignee|lead           0 hits
statusUpdate                  0 hits
dependency|depends            0 hits
progress                      1 hit  (unrelated)
milestone                     5 hits (all confer-scoped, nothing to do with goals)
```

- **No progress at any level.** `goal.status` is a flat enum — live data has exactly one value,
  `active`. Nothing computes % complete despite `workflows.status` carrying
  `completed|cancelled|running` per run.
- **No dates.** No target date, no start date, so nothing can be late.
- **No owner.** Nobody is accountable for a goal.
- **No updates/history.** No record of what changed week to week.
- **No portfolio view.** `GoalsPage` renders goals → projects → run buttons. There is no
  cross-goal view, no "where is the money going", no "what is at risk".
- **The budget is nearly inert.** `budget_usd` is enforced in exactly one place —
  `heartbeat-scheduler.ts` skips a scheduled run when `goalCostUsd >= budget_usd`. A **manual**
  launch never checks it.

### Live data shape
`goals=1 · projects=3 · heartbeats=0 · workflow runs=7 · tasks=0` — the feature is barely used,
which is itself the finding: there is nothing in it worth returning to.

---

## Key Ideas & Themes

**1. Every commercial tool reconstructs the work↔goal link. NeonCore captures it at source.**
Jellyfish, LinearB and Swarmia all infer the link after the fact from git/CI/issue data, and
Swarmia's own target is only ~80 % categorisation. NeonCore dispatches through one funnel that
already knows the goal, the project, the cartridge and the cost. Its attribution can be exact and
complete, not inferred. This is the strongest asymmetry available and nothing currently exploits it.

**2. Progress should be derived, never typed.** Linear's rollup is the right model, and Linear
still needs a human to set health every Friday *because humans will not log accurately*. NeonCore's
workers file structured completion reports with `scope:` and `verify:` lines, and step status is
already authoritative. It can compute what Linear asks a person to type. The rollup path is
already half-built: cost flows up, intent flows down, **progress flows nowhere**.

**3. Health and progress are different axes, and NeonCore's health signal is better than the
category's.** "70 % complete" and "at risk" answer different questions. `workflow-attention.ts`
already derives a *needs-a-human* verdict from real state rather than a lead's Friday opinion —
that is a genuinely stronger primitive than Linear's, and it stops at the run. Rolling it to the
project and goal gives a portfolio-level "what needs me" with no human ritual.

**4. The budget is a portfolio control that was built as a tripwire.** Planview sets budget
ceilings *at assignment* and enforces *at runtime*, halting actions before they commit and
escalating to the accountable human. NeonCore's `budget_usd` gates only scheduled runs; a manual
launch ignores it entirely. The enforcement point already exists — the same dispatch funnel that
carries the goal brief.

**5. Investment categories are the missing dimension on a cost model that already works.**
`goalCostUsd` answers "how much did this goal cost". It cannot answer "how much of this month was
KTLO". Swarmia's mechanic — categorise the top-level item, auto-categorise everything beneath —
maps exactly onto goal → project → run → step, and NeonCore's hierarchy is *stricter* than an
issue tracker's, so auto-categorisation would be total rather than 80 %.

**6. Autonomy belongs on the goal, not only on the cartridge.** The arXiv autonomy ladder
(Guided / Supervised / Collaborative / Assisted) is already implemented piecemeal — trust mode and
`decision` steps. Hoisting it to the goal lets a PM say "this goal is exploratory, act freely" or
"this touches billing, draft and wait" once, instead of per cartridge per run.

**7. Nothing reads a goal and proposes work.** The fleet-tiering literature describes a strategic
tier that decomposes goals into work. NeonCore has no Tier 3: a goal cannot suggest its own
projects or workflows. Given the goal now carries acceptance criteria, no-gos and key results,
this is closer than it looks.

**8. The honest counter-argument: this is one user with one goal.** Live data is 1 goal /
3 projects / 0 heartbeats. Building a portfolio-management layer for a portfolio of one would be
premature. The sequencing that follows from the evidence is: make the *existing* goal worth
opening (derived progress, rolled-up health, budget actually enforced) before adding roadmaps,
dependencies or resource modelling.

---

## Recommended focus for the next step (Idea Synthesis)

Rank by *leverage on existing machinery*, not by feature completeness:

1. **Derived progress rollup** — goal ← project ← run ← step. All inputs exist; nothing consumes them.
2. **Health rollup** — lift `workflow-attention.ts` from run to project to goal.
3. **Budget enforced at the funnel** — move the ceiling from the heartbeat scheduler to `sendCommandToAgent`, with escalation instead of silent skip.
4. **Investment categories** on the goal, auto-inherited downward.
5. **Target date + owner** — the two fields Linear refuses to let you skip, and the prerequisite for "late".
6. *(defer)* Roadmap/Gantt, dependencies, scenario modelling — no evidence of need at current scale.
