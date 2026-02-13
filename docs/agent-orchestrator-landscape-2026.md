# The Agent Orchestrator Landscape in 2026

## Key Competitors

**Conductor** — macOS app that runs Claude Code + Codex agents in parallel, each in isolated git worktrees. Visual dashboard shows what each agent is working on, with centralized PR review and merge.

**Gas Town (Steve Yegge)** — Manages 20-30+ concurrent agents with 7 distinct roles (Mayor coordinator, Polecats workers, etc.). Uses a git-backed "Beads" issue tracking system for persistent work state that survives agent crashes.

**Claude Flow** — Deploys multi-agent swarms with distributed coordination, RAG integration, and MCP protocol support.

**Open Agent / Sandboxed.sh** — Self-hosted orchestrator with containerized workspaces, real-time CPU/memory/network graphs, iOS app with Picture-in-Picture monitoring, and multi-runtime support (Claude Code, OpenCode, Amp).

**Code Conductor** — GitHub-native approach using Issues as tasks with automatic PR creation and parallel agent execution.

**Claude Code Agentrooms** — Routes tasks to specialized agents with @mention-based collaboration.

---

## What NeonCore Already Does Well

- Real-time multi-agent monitoring with activity feed
- Permission proxy with trust mode
- Stuck detection and auto-recovery alerts
- Agent memory system and notes
- Bulk command dispatch to multiple agents
- Plan mode visibility (just added plan content display)
- Repo launcher with directory browser (just added)
- Mobile-responsive dashboard
- Cross-platform hooks (macOS, Linux, Windows)

---

## Suggested Improvements & Additions

### Tier 1 — High Impact, Builds on Existing Infrastructure

**Task Board / Work Decomposition** — A kanban-style board where you create tasks, assign them to agents, and track progress (Todo / In Progress / Review / Done). Similar to Gas Town's "Beads" but with a visual UI. NeonCore already has the command-sending infrastructure — tasks would be commands auto-dispatched when an agent becomes idle.

**Git Worktree Management** — Let agents work on separate branches without conflicts. Dashboard shows per-agent branch, lets you create worktrees, and view diffs. NeonCore already tracks branch info per agent — this extends it with active management.

**Cost / Token Tracking** — Track API token usage and estimated cost per agent/session. The reporter hook already captures tool use events — adding token counts from the transcript would enable cost dashboards. Multiple users report $200+/month in API costs, so visibility matters.

**Code Diff Viewer** — See what code each agent has changed directly in the dashboard. Could show git diff output per agent, making review possible without opening VS Code.

### Tier 2 — Differentiation Features

**Agent Roles & Specialization** — Define agent roles (Implementer, Reviewer, Tester, Researcher) with pre-configured CLAUDE.md instructions and memory. When a task is assigned, the agent gets role-specific context automatically.

**Workflow Templates** — Predefined multi-step workflows like "Scope → Implement → Test → Review → PR". Each step auto-assigns to an agent with the right role. The CommandBar's existing command categories could extend into full workflow chains.

**Inter-Agent Messaging** — Let agents share findings. Agent A finishes research and sends context to Agent B for implementation. NeonCore's command infrastructure already supports this — add a "forward to agent" action.

**Scheduled Tasks** — Cron-like scheduling: "Run /full-test on all agents at 8am" or "Run /full-review every night". The server already has setInterval-based background jobs — scheduling fits naturally.

### Tier 3 — Advanced / Future

**Resource Monitoring** — CPU, memory, network per agent process (like Sandboxed.sh's Mission Control).

**Multi-Model Support** — Support Codex, Gemini CLI, or other coding agents alongside Claude Code, with unified monitoring.

**PR Dashboard** — Aggregate view of all open PRs created by agents, with approve/merge/close actions from NeonCore.

**Agent Health Score** — Beyond stuck detection: a composite score based on error rate, task completion rate, time-to-idle, and API cost efficiency.

**Session Replay** — Browse the full conversation history of any agent session, not just the activity summary.
