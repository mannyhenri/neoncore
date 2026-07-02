# Task Queue

NeonCore's task queue lets you **queue work for your agents** and track it from
creation to completion. A task is a unit of work — a title plus instructions —
that an agent picks up (or that you push into a terminal) and reports back on.

Open the **Tasks** view from the top nav to see the queue.

## Anatomy of a task

| Field | Meaning |
|---|---|
| **Title** | Short label, e.g. "Fix the 500 on /login" |
| **Instructions** | The prompt the agent runs |
| **Cartridge / project** | Optional pin to a project (see [GOALS.md](GOALS.md)). A pinned task can only run on an agent whose repo matches that project's codebase |
| **Priority** | Higher numbers surface first |
| **Status** | `queued → claimed → in_progress → done / failed / cancelled` |

## Two ways a task reaches an agent

NeonCore supports both a **pull** and a **push** model — they coexist.

### Pull (the agent asks for work)

An agent running the NeonCore MCP server claims work itself using these tools:

- `neoncore_my_queue` — list claimable tasks for this agent
- `neoncore_claim_task` — atomically claim one (race-safe; only one agent wins)
- `neoncore_report_task_done` — mark it `done` / `failed` with a result

This is the lossless path: the agent gets the full instructions and reports a
real result back into the dashboard.

### Push (you dispatch work into a terminal)

You don't have to wait for an agent to poll. From the dashboard:

- **Auto-dispatch on create** — if you pin a task to a project that has a
  connected, idle agent, NeonCore immediately pushes the prompt into that
  agent's terminal (via the command/relay channel) and marks it `in_progress`.
- **Manual "Send to terminal"** — open any task and pick a connected agent to
  push it to on demand.

Pushed prompts arrive in the terminal exactly as if you'd typed them.

## How a pushed task gets completed

Because a pushed prompt is just text in the terminal, NeonCore closes the loop
three ways (they layer — the first that fires wins):

1. **Report-back instruction** — the dispatched prompt includes the task id and
   asks the agent to call `neoncore_report_task_done` when finished. Works when
   the terminal has the NeonCore MCP server registered; captures the result text.
2. **Stop-hook fallback** — when the agent finishes its turn, its `Stop` hook
   fires and NeonCore auto-completes the dispatched in-progress task for that
   repo. No MCP server required (hooks are enough). ⚠️ The `Stop` hook fires at
   the end of *every* turn, so a task can be marked done early if the agent
   pauses mid-way to ask you something — re-dispatch if that happens.
3. **Manual** — open the task and click **Mark done** / **Mark failed** at any
   time. Always available.

## Editing & cancelling

- **Edit** — click a task to open its detail view. While a task is still
  `queued` you can change the title, instructions, cartridge, and priority. Once
  claimed, the agent already holds the instructions, so edits are locked.
- **Cancel** — available on any task that hasn't finished.

## API reference

| Method & path | Purpose |
|---|---|
| `POST /api/tasks` | Create (auto-dispatches if pinned + agent online) |
| `GET /api/tasks` | List (filter by `status`, `agentId`, `projectId`, `goalId`) |
| `GET /api/tasks/queue` | Claimable queue for the calling agent |
| `POST /api/tasks/:id/claim` | Atomically claim (agent) |
| `POST /api/tasks/:id/start` | Mark `in_progress` (owner) |
| `POST /api/tasks/:id/complete` | Report done/failed (owner, via MCP) |
| `POST /api/tasks/:id/dispatch` | Push to a terminal now (dashboard) |
| `POST /api/tasks/:id/done` | Mark done/failed manually (dashboard) |
| `POST /api/tasks/:id/cancel` | Cancel (dashboard) |
| `PATCH /api/tasks/:id` | Edit a queued task (dashboard) |

MCP tools (for the agent side): `neoncore_my_queue`, `neoncore_claim_task`,
`neoncore_report_task_done`.

## Hard-pinning, in one line

A task with a project is **only** claimable or dispatchable to an agent whose
repo matches that project's `primary_repo`. Unpinned tasks (no project) are
claimable by any agent.
