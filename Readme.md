# NeonCore

A retro-themed **orchestrator for AI coding agents**. Run, watch, and coordinate
many Claude Code (and other CLI) agents across machines and repos from a single
dashboard — with permission gating, a shared task queue, goal/cost tracking, MCP
server management, and canvas workflows.

Run one server, or one on every computer you work from and see them all in one grid.

```
  ┌──────────────────────────────┐        ┌─────────────────────────────┐
  │  Your machines / repos       │        │   NeonCore server (:4040)   │
  │  Claude Code + hooks         │◀──────▶│   • dashboard UI            │
  │  + VS Code ext  OR  relay    │ WS/HTTP│   • task queue + goals      │
  │  ("Gridlight terminal")      │        │   • permissions + activity  │
  └──────────────────────────────┘        └─────────────────────────────┘

  …and with more than one computer, every server is a peer:

        ┌──────────┐   gossip 15s   ┌──────────┐
        │ desktop  │◀──────────────▶│  studio  │     separate databases,
        │ own DB   │                │  own DB  │     separate queues
        └────┬─────┘                └────┬─────┘
             └─────────────┬─────────────┘
                  ┌────────┴────────┐          no hub, no primary —
                  │  web  /  iOS    │          clients merge at read time
                  │  MERGED GRID    │
                  └─────────────────┘
```

## What it does

- **Cartridge grid** — every connected agent (a Claude, Codex, or Gridlight session in a
  repo) shows up as a live "cartridge" with status, activity feed, its **tool** shown next
  to the project name, and a command box. A cartridge leaves the grid when its session
  actually **ends** — going quiet doesn't remove it. See [Agent lifecycle](FEATURES.md#cartridges-connected-agents).
- **Multi-tool** — Claude, Codex, and Gridlight run side by side (even in the same repo).
  **Confer** puts two of them on one job to collaborate; **workflows** can route each step
  to a specific tool. See [FEATURES.md](FEATURES.md).
- **Mobile app (iOS)** — the same cartridges on your phone: read transcripts (long-press a
  message to copy it), answer approvals, launch workflows, send prompts, start a Confer.
  LAN-only. See [mobile/README.md](mobile/README.md).
- **Permission gating** — `PreToolUse` hooks pause risky tool calls until you
  approve them on the dashboard, **or from your phone**, or run an agent in
  **trust mode** to auto-approve.
- **Task queue** — queue work for agents, pin it to a project/cartridge, dispatch
  it straight into a terminal, and track it to completion. See [docs/TASKS.md](docs/TASKS.md).
- **Goals & cost** — group projects under goals, set a budget, and watch real USD
  spend roll up from agent sessions. See [docs/GOALS.md](docs/GOALS.md).
- **MCP servers & tools** — install/configure MCP servers and one-click hook setup
  for Claude Code, Codex, Amazon Q, and Cursor from the Settings panel. Relay-launched
  agents auto-get the NeonCore coordination MCP (register/report/tasks/confer tools).
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

On first launch the server prints a **fleet token** in its startup banner. You need it
only if you add a second computer — copy it somewhere now, since it is redacted from the
settings API afterwards.

### Add another computer

One command on the new machine, using the token from the first:

```bash
./install-neoncore.sh --start --fleet-token <TOKEN> --peer http://first-machine.local:4040
```

Both machines' cartridges then appear in one grid, from either machine's dashboard and
from the phone. See **[FLEET.md](FLEET.md)**.

### `<SERVER>` — the address agent machines and your phone connect to

Everywhere the docs say `http://<SERVER>:4040`, substitute **either** your server's
hostname **or** its IP — whichever works on your network:

| `<SERVER>` | Get it | Notes |
|---|---|---|
| **Hostname** — `studio.local`, `desktop-abc` | run `hostname` on the server | **Preferred.** Survives DHCP changes. `.local` (mDNS) is automatic on macOS; usually fine on Windows/Linux. |
| **IP** — `192.168.4.24` | `ipconfig getifaddr en0` (Mac) · `ipconfig` (Windows) · `hostname -I` (Linux) | Use if mDNS is blocked on your network. **Set a DHCP reservation** on your router, or it will change. |

Whichever you pick, confirm it answers *from the other machine* before installing anything:

```bash
curl http://<SERVER>:4040/api/health     # → {"status":"ok"}
```

> **Why this matters:** the agent installer **bakes this URL as a literal string** into
> `~/.claude/settings.json` and never re-reads it. If the address later changes, every hook
> POST from that machine silently goes nowhere — the cartridge just stops appearing, with no
> error on either side. A hostname (or a reserved IP) avoids this entirely.

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
NEONCORE_URL=http://<SERVER>:4040 python3 agent/install.py
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
