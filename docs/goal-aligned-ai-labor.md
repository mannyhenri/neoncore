# NeonCore: Goal-Aligned AI Labor Control Plane
## Design Document v0.1 — May 2026

> **Status: design doc, partially implemented.** This describes the target
> vision; not all of it is built. For what works today, see the user guides
> ([docs/GOALS.md](GOALS.md), [docs/TASKS.md](TASKS.md)).
>
> - **Built today:** goals, projects (cartridges), task queue with dispatch +
>   completion, and real USD cost rollup to goals.
> - **Designed, not yet built:** decision checkpoints, typed step outputs
>   (`outputSchema`), the learnings connector, and scheduled heartbeats.

---

### Vision

NeonCore evolves from "watch your Claude Code agents" to "run your AI development team."

You set business goals, assign projects, run structured workflows, and capture what your AI team learned. The mental model shifts from **debugger → CEO dashboard**.

Two reference points shape the direction:
- **Paperclip** — organizational model: agents have jobs, goals, budgets, and the human governs strategy
- **gstack** — workflow granularity: every kind of work has a structured recipe, every decision is documented, every run leaves a receipt

NeonCore already has the bottom half of both (V2 canvas workflows, step executors, gstack skill routing). What's missing is the **top layer** (what business goal is this work advancing?) and **structured receipts** (typed outputs, decision checkpoints, learnings capture).

---

## Part 1: Goal Cascade Layer

### New data model

```
goals
  id            TEXT PRIMARY KEY
  name          TEXT NOT NULL
  description   TEXT              -- mission statement: "why this matters"
  success_metric TEXT             -- "what done looks like"
  budget_usd    REAL              -- optional spending cap
  status        TEXT DEFAULT 'active'  -- active | achieved | paused
  created_at    TEXT NOT NULL

projects
  id            TEXT PRIMARY KEY
  goal_id       TEXT REFERENCES goals(id)
  name          TEXT NOT NULL
  description   TEXT
  primary_repo  TEXT              -- default repo path for agent assignment
  color         TEXT              -- UI accent color
  created_at    TEXT NOT NULL

workflows (existing — add column)
  + project_id  TEXT REFERENCES projects(id)  -- nullable, optional assignment
```

### Goals Dashboard (new top-level page)

Replaces or supplements the Workflows list as the primary entry point.

**Goals list view:**
- Each goal card: name, success metric, status badge, # active projects, estimated $ spent this month
- Click goal → Project list for that goal
- Click project → All workflow runs serving that project, current agent activity, learnings history

**The framing shift:** instead of "here are your running workflows," the first thing you see is "here are your business objectives and what AI labor is running against each one."

### Workflow launch flow change

When launching a workflow (the Configure & Run popup):
- New optional "Assign to project" picker dropdown (shows goals → projects tree)
- If launched from within a project's detail page, `project_id` is pre-filled
- Project assignment is always optional — no friction for existing users

### Cost tracking (V1: estimate)

- Each workflow run accumulates `estimated_tokens` from step dispatched prompt lengths + result lengths
- Shown per-project and per-goal as "~$X spent" using claude-sonnet-4-6 pricing as a proxy
- No API integration needed yet — token estimation from text length is sufficient for V1
- Cost cap warning: when a project's accumulated spend approaches the parent goal's `budget_usd`, show a warning banner

---

## Part 2: gstack-Style Workflow Granularity

The V2 canvas is already well-structured. The gap: steps are open-ended text blobs and results are untyped strings. gstack's power comes from **receipts** — every decision is documented, every phase has a typed output that can be read and built upon.

### 2a. Decision Step (new executor type: `decision`)

A structured human checkpoint — the gstack D-N format as a first-class canvas step.

```typescript
executorType: 'decision'
executorConfig: {
  question: string         // the decision headline
  eli10: string            // plain-English stakes for a non-expert
  stakes: string           // what breaks if we pick wrong
  recommendation: string   // which option id to recommend
  options: Array<{
    id: string
    label: string
    description: string
    pros: string[]
    cons: string[]
    nextStepId: string     // route to this step when chosen
  }>
}
```

**Runtime behavior:**
- Workflow pauses at a `decision` step
- The canvas side panel shows a decision brief card (styled like the gstack D-N format: question, ELI10, stakes, options with pros/cons, recommendation highlighted)
- Human picks an option via the panel UI — no VS Code agent involved
- Workflow routes to the chosen `nextStepId`
- Decision + chosen option + rationale is stored as the step's `result`

**Why this matters:** right now "human checkpoints" in workflows are just `review-gate` steps — the agent dumps text, the human clicks Advance. A `decision` step makes the *human's judgment* structured and auditable. You can look back at a workflow run and see exactly what was decided and why, not just what the agent produced.

### 2b. Typed Step Outputs

Add optional `outputSchema` to any step's `executorConfig`:

```typescript
outputSchema?: 'code_review' | 'test_results' | 'design_doc' | 'decision_log' | 'free_text'
```

When set:
1. The executor injects a structured output format instruction into the step's prompt (e.g., "Output your review as JSON with fields: files_reviewed, issues_by_severity, overall_pass")
2. The step result panel renders with schema-appropriate UI instead of a raw text box:
   - `code_review` — file-by-file breakdown, severity counts (critical/high/medium/low), pass/fail badge
   - `test_results` — pass count, fail count, failed test names, error excerpts
   - `design_doc` — rendered markdown with section navigation sidebar
   - `decision_log` — list of decisions extracted from the agent's output (key, chosen option, rationale)

**Priority order for V1:** `test_results` first (pairs perfectly with the Feature Validation template), then `code_review`, then `design_doc`.

### 2c. Workflow Learnings

A new `connector` subtype: `capture-learnings`.

Placed as the final step of any workflow that should accumulate knowledge.

**What it does:**
1. Reads all step results from the completed run
2. Calls Claude directly (via the Anthropic API, not through a VS Code agent) with a prompt: "Extract the 3-5 most valuable learnings from this workflow run: key decisions made, what worked, what was surprising, recommended next steps for future runs."
3. Stores the extracted learnings as `project_learnings` records tied to the project:

```
project_learnings
  id, project_id, workflow_id, run_id, content (text), tags (JSON), created_at
```

4. Future workflow runs in the same project: the "Shared Context" field is auto-populated with the 3 most relevant past learnings (matched by workflow name / template type)

**This is gstack's `~/.gstack/projects/{slug}/learnings.jsonl`** — but project-scoped, living in NeonCore's DB, and automatically populated at the end of every run instead of requiring the developer to manually save context.

---

## Part 3: Heartbeat Scheduler (Phase 2)

Paperclip's defining feature: AI labor runs on a schedule, not just when a human fires a workflow.

```
heartbeats
  id, project_id, workflow_id (template to run),
  schedule (cron expression), last_run_at, next_run_at,
  agent_id (which registered agent to dispatch to),
  active (boolean), created_at
```

**UI:** each project detail page has a "Scheduled Runs" section. Examples:
- "Every Monday 9am — Code Health Check — neoncore repo — agent: Cursor #1"
- "Daily at midnight — Feature Validation — against last Jira sprint tasks"

**Runtime:** a server-side cron loop (node-cron or similar) checks for due heartbeats every minute, dispatches the workflow against the assigned agent, and records the run against the project.

**Why this is powerful:** heartbeats are how you ensure *ongoing* AI labor against a goal, not just one-off runs. A goal without heartbeats is a wish. A goal with heartbeats is a managed process.

---

## Build Order

| Phase | Work | Est. |
|-------|------|------|
| 1 | Goal Cascade: goals + projects tables, workflow FK, Goals dashboard page, launch flow picker | 3–4 days |
| 2a | Decision step executor type + decision brief UI in canvas side panel | 2 days |
| 2b | Typed outputs: `test_results` schema first, then `code_review` | 2–3 days |
| 2c | Workflow learnings: `capture-learnings` connector + project learnings panel | 2 days |
| 3 | Heartbeat scheduler: cron table, server-side runner, project schedule UI | 3 days |

**Total to full vision: ~3 weeks of focused building**

---

## What NeonCore Becomes

Before: "A dashboard for watching Claude Code agents run on your machine."

After: "The control plane for your AI development team — you set the goals, your agents do the work, NeonCore shows you what's advancing and what it's costing."

The pitch tightens to: **Paperclip for Claude Code power users** — all the organizational intelligence of Paperclip, but with deep native integration into Claude Code's hooks, permission system, and V2 canvas workflows that generic agent-agnostic tools can't match.

---

*Generated during /office-hours session, May 2026.*
