# NeonCore Features

A complete map of what NeonCore does today. For install/setup see **[INSTALL.md](INSTALL.md)**;
for connecting machines see **[SETUP.md](SETUP.md)**. Items marked _(macOS only)_ or
_(not active)_ have caveats called out inline.

---

## Cartridges (connected agents)

- **Cartridge grid** — every connected agent (a Claude Code / CLI session in a repo) shows up
  as a live card with status (working / waiting / idle / offline), an activity feed, token +
  USD cost, and a command box. Filter by status; offline cards are hidden from the grid.
- **Machine+repo dedup** — multiple agents on the same `machine:repoPath` merge into one
  cartridge; sibling sessions are aggregated (activity, permissions, cost).
- **Send a prompt/command** — type into a cartridge's box to inject a prompt into the live
  session (via the relay PTY, the VS Code extension, or macOS terminal typing).
- **Focus** — bring the agent's VS Code/terminal window to the front _(macOS)_.
- **Delete/remove** — tear down a cartridge and all its child data.
- **Agent lifecycle** — a cartridge leaves the grid when its session **actually ends**, not
  when it goes quiet:

  | Transition | Trigger | Note |
  |---|---|---|
  | `working → idle` | 2 min with no tool activity | Display only. **An idle cartridge stays visible.** |
  | `→ offline` | `SessionEnd` hook (session exited) | The normal path. Requires the hook — re-run the installer on older machines. |
  | `→ offline` | socket disconnect | Relay / VS Code extension. |
  | `→ offline` | relay caught SIGTERM | Fast path; also flags interrupted workflow steps. |
  | `→ offline` | **24h zombie reaper** | Backstop only, for sessions killed without firing any of the above (`kill -9`, terminal closed, laptop slept). |

  Death is **reported, not inferred from silence**. Earlier versions guessed by timeout —
  idle 5 minutes meant offline, and offline cards are hidden — so live sessions vanished
  out of the grid while you were still sitting in them. That timeout is gone.
- **Auto-reaping** — agents offline > 14 days are deleted outright; activity/commands/
  sessions/memory are pruned on a 6-hour schedule. (Distinct from the 24h zombie reaper
  above: that one *marks* a stranded agent offline, this one *deletes* long-dead rows.)

## Permission gating & autonomy modes

Each agent runs in one of three modes (per-cartridge selector):

- **Manual** — every risky tool call (`PreToolUse`) pauses and waits for you to Approve/Deny on
  the dashboard. Unanswered requests long-poll ~10 min then fall back and expire.
- **Plan** — the agent proposes a plan (ExitPlanMode) you review/approve/reject-with-reason.
- **Trust** — auto-approve all tool calls for that agent. A **"Plans auto-approved"** sub-toggle
  additionally auto-captures ExitPlanMode plans into running workflow steps.
- **Trust at install time** — set `NEONCORE_TRUST=1` when installing hooks so a machine's agents
  start in Trust mode (good for unattended/remote machines). Flip any agent back on the dashboard.
- **AskUserQuestion** — an agent's multiple-choice / free-text questions surface on the card and
  in the Notification Center for you to answer.

## Task queue

- **Create tasks** (title, agent instructions, project/cartridge, priority) and track them
  through `queued → claimed → in_progress → done/failed/cancelled`.
- **Push (dispatch)** a task's prompt straight into an assigned agent's terminal, or leave it in
  the **pull** queue for any agent to `claim` via MCP.
- **Completion** three ways: the agent reports done via MCP, a Stop-hook auto-completes a
  dispatched task (matched by repo path), or you mark it done/failed manually (optionally sending
  the result to an agent).
- Full reference: **[docs/TASKS.md](docs/TASKS.md)**.

## Goals, projects & cost

- **Goals** — top-level objectives with a mission, success metric, and **token + USD budget**.
- **Projects** — work areas under a goal, each pinned to a primary repo (which links cartridges
  and tasks to the project by repo path).
- **Real USD cost rollup** — token usage is priced per model (Opus/Sonnet/Haiku/Fable, including
  cache-read/write) and rolls up `session → project → goal`. The same number shows on cartridge
  cards, in the Goals view, and enforces budgets.
- Full reference: **[docs/GOALS.md](docs/GOALS.md)**.

## Heartbeat scheduler

- Cron-like **recurring workflow runs** (hourly / daily / weekly) that clone a workflow template
  into a fresh run and inject the project's recent learnings as context.
- **Budget gate** — a scheduled run is **skipped when its goal is over `budget_usd`**.
- **"Fire now"** to trigger a heartbeat manually.

## Canvas workflows (V2)

- **Visual step graph** (React Flow) — add steps, draw dependency arrows (same-level steps run in
  parallel), and run. Step types include agent steps (`claude-code`), **decision/deliberation**,
  **quality-gate / review-gate** with typed outputs (e.g. Test Results, Code Review), and
  **connector** steps.
- **AI Workflow Generator** — describe a workflow in a sentence and generate the full graph
  (uses the Anthropic API key from Settings).
- **Connectors** — `system-notify` (desktop/ntfy notification), `capture-learnings`,
  `save-to-project`, plus an external `webhook` completion callback. See **[WORKFLOWS.md](WORKFLOWS.md)**.
- **Steering & lifecycle** — pause / resume / cancel / delete runs; steer or skip individual steps.
- **Learnings** — insights extracted from runs, scoped per project and fed back into heartbeats.
- **Epic Autopilot** — the dashboard has an Epic panel (scan tasks by prefix, batch-run with a
  prompt template), **but its server-side executor is currently disabled** — treat as preview.

## Multi-engine agent support

NeonCore isn't Claude-only. Supported agent types: **claude · gridlight · gemini · amazonq ·
codex · cursor**.

- **Hooks per engine** — install/uninstall NeonCore hooks for each CLI from **Settings → Tools**
  (Claude Code, Gemini CLI, Amazon Q, Codex CLI, Cursor). This writes each tool's own hook config
  (`~/.codex/hooks.json`, `~/.gemini/settings.json`, `~/.aws/amazonq/…`, `~/.cursor/hooks.json`)
  and can npm-install the CLI if missing.
- **Command delivery** — Claude/Gridlight receive commands over the socket (relay/extension);
  Gemini/Codex/Amazon Q receive them by **typing into iTerm2/Terminal via AppleScript** _(macOS
  only)_.
- The Claude hook installer (`agent/install.py`, used by `bootstrap.sh/.ps1`) wires 7 events:
  `PreToolUse, PostToolUse, Stop, Notification, SubagentStop, UserPromptSubmit, SessionEnd`.
  `SessionEnd` fires once when a session actually exits and is what marks the cartridge
  offline. (`Stop` is **not** that signal — it fires at the end of every assistant turn.)

## MCP servers & tools

- **Managed MCP servers** — add/edit/start/stop MCP server processes from Settings; view their
  tools; running servers are restored after a restart.
- **MCP marketplace** — browse a registry of MCP servers by category and one-click install.
- **Per-cartridge MCP tools** — virtual cartridges can enable MCP servers and pin specific tools
  as one-click action buttons.
- **NeonCore coordination MCP server** — agents get 8 tools to self-coordinate:
  `neoncore_register`, `neoncore_report`, `neoncore_request_permission`, `neoncore_report_step_done`,
  `neoncore_my_queue`, `neoncore_claim_task`, `neoncore_report_task_done`, `neoncore_list_agents`.
  Registered project-scope (`.mcp.json`) by `install.py`; global scope via
  `claude mcp add-json neoncore '…' --scope user`.

## Virtual cartridges

- **Folder workspaces** for directories that don't have a live agent yet — **launch an agent** in
  that directory picking the type (Claude·Terminal, Claude·VS Code, Gridlight, Gemini, Codex,
  Amazon Q), set a per-project ntfy topic, enable MCP servers, and pin MCP tool buttons.

## Project memory & journal

- **Auto-captured memory** — the memory analyzer learns error→fix pairs, repeated failed
  approaches, and files-that-change-together, and can inject them into commands. Auto memories
  start **inactive** until you toggle them on.
- **Per-agent notes** — project-scoped notes CRUD on each cartridge.
- **Session journal + FTS search** — session history with LLM summaries and editable per-project
  knowledge files, all full-text searchable (`/api/journal/search`).
- **Send context** — push selected sessions/progress/decisions into an agent, or forward content
  to another cartridge.

## Git & worktrees

- Per-cartridge **Git panel**: working-tree status + diff, branch list, and **worktree**
  management (list, create by branch, open in VS Code, remove).

## Notifications & stuck detection

- **Stuck detector** — flags error loops (3+ consecutive errors), long silence (>1h while
  working), and permission stalls (>5 min), raising a dashboard alert and an **ntfy mobile push**
  (global or per-cartridge topic). "Send Hint" pushes a suggested fix back to the agent.
- **Notification Center** — a bell dropdown aggregating pending permissions, stuck alerts, and
  workflow notifications.

## Server & deployment

- Single Node server (Express + better-sqlite3 + Socket.io) on **port 4040** (`PORT` to override),
  listening on `0.0.0.0` for LAN access; the built dashboard is served from the same origin.
- **SQLite** at `server/neoncore.db` (WAL). No external DB.
- **Port piggyback** — launching a second instance detects the running one via `/api/health` and
  no-ops instead of erroring.
- **First-launch** auto-installs Claude Code hooks on the server machine (resettable from Settings).

---

_This catalog reflects the current codebase. Keep it in sync when adding routes, panels, or
agent-facing tools — it's the fastest way for a new dev to see the whole surface._
