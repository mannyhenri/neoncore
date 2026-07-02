# Goals, Projects & Cost

NeonCore organizes work in three layers so you can connect "why" to "what the
agents actually did" — and what it cost.

```
Goal  ──────────────▶  a business objective + success metric + budget
  └─ Project  ───────▶  a work area that serves the goal, tied to one repo ("cartridge")
       └─ Task  ─────▶  a unit of work, pinned to that project  (see TASKS.md)
```

## Goals

A **goal** is a top-level objective. Fields:

| Field | Meaning |
|---|---|
| **Name** | e.g. "Cut onboarding drop-off" |
| **Description** | Context for the objective |
| **Success metric** | How you'll know it worked |
| **Budget** | Optional spend ceiling (USD) |
| **Status** | `active` by default |

Each goal rolls up live stats from the work beneath it: number of projects,
workflow runs, tokens used, and **real USD cost**.

## Projects (cartridges)

A **project** is a work area that serves a goal and is tied to a single
repository via its **primary repo**. That repo binding is what makes a project a
"cartridge": an agent working in that repo is the one that serves the project.
Projects carry a color used throughout the dashboard.

The primary-repo binding drives two things:

- **Task pinning** — a task pinned to a project can only run on an agent whose
  repo matches the project's primary repo (see [TASKS.md](TASKS.md)).
- **Cost attribution** — agent sessions in that repo are attributed to the
  project, and up to its goal.

## Cost tracking

NeonCore records **real USD cost** from agent session usage (not an estimate),
then rolls it up:

```
session usage (per agent)  ──by repo──▶  project  ──▶  goal
```

Set a **budget** on a goal and the dashboard shows spend against it as the agents
work. Because attribution follows the repo, any connected agent (VS Code or
relay) working in a project's codebase contributes to that project's and goal's
cost automatically.

## API reference

| Method & path | Purpose |
|---|---|
| `GET /api/goals` | List goals with rolled-up projectCount, runCount, tokensUsed, costUsd |
| `POST /api/goals` | Create a goal |
| `PUT /api/goals/:id` | Update a goal (name, metric, budget, status) |
| `DELETE /api/goals/:id` | Delete a goal (its projects are unlinked, not deleted) |
| `GET /api/projects` | List projects (filterable by goal) |

## Relationship to the design doc

The broader vision — decision steps, typed step outputs, a learnings connector,
and scheduled heartbeats — lives in
[goal-aligned-ai-labor.md](goal-aligned-ai-labor.md). That document is a design
spec; only part of it is built today. This guide covers what currently works:
**goals, projects, task pinning, and USD cost rollup.**
