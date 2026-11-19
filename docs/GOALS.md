# Projects, Features & Cost

NeonCore organizes work as **projects that hold a list of features**. You name the project and the
repos it lives in, list the features you want built, and take them one at a time through the
feature pipeline.

```
Project  ─────────────▶  a name, what it is, and the repos/cartridges involved
  └─ Feature  ────────▶  one thing to build — scoped, planned and run on its own
       └─ Pipeline ───▶  scoping questions → brief + acceptance criteria + workflows → repos → run
            └─ Runs ──▶  the workflow runs that build it (each tagged to the feature)
```

> A **feature is a goal** under the hood: the `goals` table holds features, filed under a project by
> `goals.project_id`. Everything the goal pipeline does — the scoping conversation, the brief every
> agent receives, the acceptance contract, the report, cost and progress — works for every feature
> unchanged. See **[GOAL-PILOT.md](GOAL-PILOT.md)** for the pipeline itself. The API answers under
> both `/api/goals` and `/api/features`.

## In the dashboard — the Projects view

1. **+ New project** — a name, an optional description (the planner reads it when it scopes each
   feature), the **repos & cartridges involved** (pick any repo a cartridge has worked in, or add a
   folder), the main repo (where documents and saved files go) and a colour.
2. **Add the features** — type one and press Enter, or **paste a whole list** (one per line; bullets
   and numbers are stripped). They are added in order, nothing starts. Reorder with ▲ ▼: the list is
   the order you want them built.
3. **Start a feature** — the **Up next** card (or ▶ Start on any row) opens the feature onto its
   questions, pre-filled from the list entry. From there it is the pipeline: the planner cartridge
   (one in the project's repos is offered first) asks what is still open, writes the brief and the
   acceptance criteria, proposes the workflows; you edit and accept; you confirm which of the
   project's repos build it (they are pre-selected; a repo from outside the project is added to it);
   the workflows run one after another.
4. **Finish** — when the pipeline ends, read the feature report and **✓ Mark done**. The page then
   offers the next feature on the list.

Each row of the list says where its feature stands, and which ones need you:

| Status | Means | The row offers |
|---|---|---|
| Not started | On the list, never scoped | ▶ Start |
| Scoping… / Choosing workflows… | The planner is working | Open |
| Questions for you | The planner asked something | Answer |
| Plan ready to review | Brief, criteria and workflows are proposed | Review plan |
| Pick repos & start | The plan is accepted | Start run |
| Running · 2/4 | Stages are running | Open |
| Needs your review / Waiting on you | Approve the acceptance tests, confirm verdicts, a decision in a run | Review / Open |
| Paused — needs you | A stage failed, the budget ran out, a locked test changed | Resolve |
| Finished — check report | Every stage finished | Review |
| Done | Marked done by you | Open |

The rail shows each project with `done/total` features, how many are in progress, how many need
you, its repos and its spend.

Links: `#project/<projectId>` opens a project, `#project/<projectId>/feature/<featureId>` a feature.
Older links (`#goal/<id>`, and the `#goal=<id>` desktop notifications send) still open the feature.

## The project's documents

Beside the feature list, the project page has **Spec** (every feature's intent beside what was verified),
**Roadmap** (Now / Next / Later / Done — drag features between columns — with a shareable page),
**Changelog** (an entry per feature marked done, releases) and **Architecture** (how it is built). For a
codebase new to NeonCore, **✦ Generate with AI** has a cartridge write the architecture, the existing
features with their specs, the changelog from git, and the backlog — reviewed before anything is kept. All of it can be published into the repo as `docs/product/`, on demand or kept in
sync. See **[PROJECT-SPEC.md](PROJECT-SPEC.md)**.

## What belongs to a feature

A project's repos are shared by all of its features, so a feature's numbers come from **its own
work**, not from everything its repos did:

- **Runs** — every run the pipeline launches is tagged with the feature (`workflows.goal_id`) and
  attached to the feature's project. Progress and health read those runs.
- **Brief and contract** — each run's steps receive **that feature's** brief and acceptance contract
  (the run's tag decides, not the project).
- **Cost** — the usage each cartridge recorded while doing the feature's work: every step of its runs
  and every request put to a cartridge for it (planner, test writer, reviewer). A cartridge does one
  thing at a time (the busy guard), so these windows do not overlap another feature's. A feature's
  **budget** is checked against this number before each stage starts.
- **Reach** — the cartridges in the project's repos.

A **project's** cost is everything spent in any of its repos.

## Fields

**Project** — name, description, repos (`project_cartridges`), main repo (`primary_repo`), colour.

**Feature** — name, description, "done when", status (`active` / `achieved` = done / `paused`),
budget, target date, and the brief fields the pipeline fills in when you accept a plan (acceptance
criteria, invariants, no-gos, rabbit holes). Edit them any time with **Edit** on the feature.

## Old goals (before projects held features)

The hierarchy used to be the other way round: a goal owned projects (`projects.goal_id`). On first
start after the change:

- a goal owned by **exactly one** project is filed under that project as a feature;
- a goal spread over several projects (or none) is left **unfiled** — the Projects view lists it
  under **Features without a project**, with a *Move to…* picker.

Nothing is deleted, and the old links still count: a legacy goal keeps its projects' untagged runs
and, while unfiled, its whole-repo cost attribution.

## Tasks

Tasks (the Tasks view) are quick one-offs for a cartridge, separate from features. A task can be
pinned to a project; it is then dispatched to a cartridge in the project's **main** repo. See
[TASKS.md](TASKS.md).

## API reference

| Method & path | Purpose |
|---|---|
| `GET /api/projects` | Projects, with `cartridges`, `featureCount`, `featuresDone`, `featuresActive`, `featuresNeedYou`, `costUsd` |
| `POST /api/projects` | Create a project `{ name, description, primaryRepo, cartridges, color }` |
| `PUT /api/projects/:id` | Update it (sending `cartridges` replaces the set) |
| `DELETE /api/projects/:id` | Delete it **and its features** (pipelines are stopped first); `?keepFeatures=1` leaves them unfiled |
| `POST /api/projects/:id/features` | Add features to the end of the list: `{ features: [{ name, description? }] }` or `{ names: [...] }` |
| `PUT /api/projects/:id/features/order` | Set the build order: `{ ids: [...] }` |
| `GET /api/features?projectId=` | A project's features in order (also `/api/goals`), each with `pilot` — where its pipeline stands |
| `POST /api/features` | Create one feature (`projectId` files it) |
| `PUT /api/features/:id` | Update it; `projectId` moves it to another project (to the end of its list) |
| `DELETE /api/features/:id` | Delete it (its live pipeline is cancelled; runs stay as history) |
| `POST /api/goal-pilots` | Start a feature's pipeline: `{ goalId, intake, plannerAgentId }`, or `{ projectId, intake, … }` to add a new feature and start it |
| `/api/goal-pilots/…` | The pipeline — see [GOAL-PILOT.md](GOAL-PILOT.md#api) |

## Relationship to the design doc

The broader vision — decision steps, typed step outputs, a learnings connector, and scheduled
heartbeats — lives in [goal-aligned-ai-labor.md](goal-aligned-ai-labor.md). That document is a
design spec written for the earlier goal → project hierarchy.
