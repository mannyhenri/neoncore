# NeonCore

A retro-themed **orchestrator for AI coding agents**. Run, watch, and coordinate
many Claude Code (and other CLI) agents across machines and repos from a single
dashboard — with permission gating, a shared task queue, goal/cost tracking, MCP
server management, and canvas workflows.

```
┌──────────────────────────────┐        ┌─────────────────────────────┐
│  Your machines / repos       │        │   NeonCore server (:4040)   │
│  Claude Code + hooks         │◀──────▶│   • dashboard UI            │
│  + VS Code ext  OR  relay    │  WS/HTTP│   • task queue + goals      │
│  ("Gridlight terminal")      │        │   • permissions + activity  │
└──────────────────────────────┘        └─────────────────────────────┘
```

## What it does

- **Cartridge grid** — every connected agent (a Claude Code session in a repo)
  shows up as a live "cartridge" with status, activity feed, and a command box.
  A cartridge leaves the grid when its session actually **ends** — going quiet doesn't
  remove it. See [Agent lifecycle](FEATURES.md#cartridges-connected-agents).
- **Mobile app (iOS)** — the same cartridges on your phone: read transcripts, answer
  approvals, launch workflows, send prompts. LAN-only. See [mobile/README.md](mobile/README.md).
- **Permission gating** — `PreToolUse` hooks pause risky tool calls until you
  approve them on the dashboard, **or from your phone**, or run an agent in
  **trust mode** to auto-approve.
- **Task queue** — queue work for agents, pin it to a project/cartridge, dispatch
  it straight into a terminal, and track it to completion. See [docs/TASKS.md](docs/TASKS.md).
- **Goals & cost** — group projects under goals, set a budget, and watch real USD
  spend roll up from agent sessions. See [docs/GOALS.md](docs/GOALS.md).
- **MCP servers & tools** — install/configure MCP servers and one-click hook setup
  for Claude Code, Gemini, Codex, Amazon Q, and Cursor from the Settings panel.
- **Canvas workflows** — author multi-step parallel/sequential agent workflows.
  See [WORKFLOWS.md](WORKFLOWS.md).

## Quick start

Requires **Node.js 18+** and **npm**.

**One-command install** (from `neoncore-full.zip` or a clone) — checks Node, installs,
builds, and starts:

```bash
./install-neoncore.sh                                    # Mac / Linux
powershell -ExecutionPolicy Bypass -File .\install-neoncore.ps1   # Windows
```

Or do it by hand:

```bash
git clone git@github.com:GRIDLIGHT-INC/neoncore.git
cd neoncore
npm install
npm run build      # builds the dashboard into server/public/
npm start          # serves dashboard + API on http://localhost:4040
```

Open **http://localhost:4040**. The server also listens on `0.0.0.0`, so other machines
on your LAN can reach it too.

> **Give agent machines and your phone the server's `.local` hostname, not its LAN IP.**
> Run `hostname` on the server — `http://Studio.local:4040` works anywhere on the LAN.
> The IP is a DHCP lease, and agent installers bake the URL into `~/.claude/settings.json`
> permanently, so when the lease changes that machine silently stops reporting, with no
> error on either side.

> **Distributing to a team?** Build the packages with `./scripts/package.sh` (creates
> `neoncore-full.zip` plus per-OS agent zips in `dist/`). Full guide: **[INSTALL.md](INSTALL.md)**.

Dev mode (hot-reload dashboard on `:4041`, API on `:4040`):

```bash
npm run dev
```

## Connect an agent

A machine needs two things to appear on the dashboard: **Claude Code hooks** (report
activity + gate permissions) and a **command channel** (so the dashboard can send
prompts back). You have two ways to get the command channel:

| | Hooks | Command channel | Best for |
|---|---|---|---|
| **VS Code extension** | `agent/install.sh` | `neoncore-extension` (marketplace/VSIX) | working in VS Code |
| **Terminal relay** ("Gridlight terminal") | auto-installed by the relay | `agent/relay` PTY wrapper | bare terminal / headless |

Fastest path — grab the agent package for your OS (`neoncore-agent-mac.zip` /
`neoncore-agent-linux.zip` / `neoncore-agent-windows.zip`) and run the bootstrap. It auto-finds the server,
installs hooks into a stable home (`~/.neoncore/agent`), builds the relay, and
launches a session in the repo you point it at:

```bash
# Mac / Linux
cd ~/code/my-project && ~/Downloads/neoncore-agent/bootstrap.sh
```
```powershell
# Windows
powershell -ExecutionPolicy Bypass -File "$HOME\Downloads\neoncore-agent\bootstrap.ps1" -RepoPath "C:\code\my-project"
```

Or wire it up by hand in a repo:

```bash
# point at your server (omit for localhost:4040)
NEONCORE_URL=http://<server>.local:4040 python3 agent/install.py
node agent/relay/launch.js          # launches Claude Code, bridged to the dashboard
```

Full instructions (packages, VS Code extension, remote machines, trust mode,
troubleshooting): see **[INSTALL.md](INSTALL.md)**, **[SETUP.md](SETUP.md)**, and
**[agent/relay/README.md](agent/relay/README.md)**.

## Layout

```
install-neoncore.sh/.ps1   Full server installer (Mac/Linux · Windows)
scripts/package.sh         Builds the distributable zips into dist/
server/        Express + better-sqlite3 API and Socket.io (port 4040)
dashboard/     React + Tailwind dashboard (Vite, built into server/public/)
agent/
  hooks/       Claude Code hook scripts (activity, permissions, messages, session lifecycle)
  relay/       Standalone PTY relay — the "Gridlight terminal" CLI
  install.py   Cross-platform hook installer  (install.sh = bash legacy)
  bootstrap.sh/.ps1   One-shot agent setup (hooks + relay + launch)
extension/     VS Code extension (optional command channel)
mobile/        iOS app (Expo) — cartridges, transcripts, approvals, workflows
docs/          TASKS.md, GOALS.md, design notes
```

## Docs

- [FEATURES.md](FEATURES.md) — complete map of what NeonCore does
- [INSTALL.md](INSTALL.md) — install & distribute (full server + per-OS agent packages)
- [SETUP.md](SETUP.md) — connect machines (hooks, extension, relay, trust mode)
- [mobile/README.md](mobile/README.md) — the iOS app (TestFlight, builds, OTA updates)
- [docs/TASKS.md](docs/TASKS.md) — the agent task queue
- [docs/GOALS.md](docs/GOALS.md) — goals, projects, and cost tracking
- [WORKFLOWS.md](WORKFLOWS.md) — canvas workflow reference
- [agent/relay/README.md](agent/relay/README.md) — the terminal relay
