# Setting Up NeonCore on Another Computer

This guide walks through connecting a new machine (or remote computer) to your NeonCore orchestrator.

> **Fastest path:** use the packaged agent installer in **[INSTALL.md](INSTALL.md)**
> (`neoncore-agent-*.zip` → `bootstrap.sh` / `bootstrap.ps1`) — it auto-finds the server, installs
> hooks into a stable home, builds the relay, and launches a session in one command. This document
> covers the **manual/advanced** flow and the **VS Code extension** in depth. Where they differ,
> INSTALL.md is canonical.

## Prerequisites

- **Node.js** (v18+) and **npm** on both machines
- **Claude Code** installed on the remote machine
- **Python 3** on the remote machine (for the hook installer `agent/install.py`)
- **Network access** from the remote machine to the orchestrator server (same LAN or VPN)
- *(Optional)* **VS Code** — only if you use the VS Code extension as the command channel instead
  of the terminal relay (the relay needs no editor)

## Architecture Overview

```
[Remote Machine]                          [Server Machine]
  Claude Code + Hooks      ──HTTP/WS──▶   NeonCore Server (:4040)
  + VS Code extension                      Dashboard UI
    OR terminal relay                      Task queue · Goals · Cost
```

The remote machine needs two things installed:
1. **Claude Code hooks** — report activity and handle permissions
2. **A command channel** — so the dashboard can send prompts/tasks back to the
   agent. Pick one:
   - **VS Code extension** (Step 3) — for working inside VS Code.
   - **Terminal relay** (Step 3, Option B) — a PTY wrapper for a bare terminal or
     headless machine. No editor required. See [agent/relay/README.md](agent/relay/README.md).

---

## Step 1: Start the Server (on the host machine)

If not already running:

```bash
cd neoncore
npm install
npm run build
npm start
```

Note the **Network URL** printed at startup (e.g., `http://192.168.1.50:4040`).
This is the URL remote machines will use.

---

## Step 2: Install Claude Code Hooks (on the remote machine)

The hooks connect Claude Code to the orchestrator. They report tool activity, handle permissions, and capture messages.

The current, cross-platform installer is **`agent/install.py`** (Python 3). The bash
`agent/install.sh` is legacy — it still works on Mac/Linux but `install.py` is what the packages,
`bootstrap.*`, and `npm run install:hooks` use.

### Option A: Clone the repo and run the installer

```bash
git clone git@github.com:GRIDLIGHT-INC/neoncore.git
cd neoncore

# Install with the orchestrator's network URL (Mac/Linux/Windows)
NEONCORE_URL=http://<server>.local:4040 python3 agent/install.py
```

> **Unattended machines:** by default a newly-discovered agent starts in **manual**
> mode, so every Bash/Edit waits for you to click *Approve* on the dashboard (if you
> don't, the hook long-polls ~10 min then falls back). For a remote machine you want
> to run hands-off, add `NEONCORE_TRUST=1` so its agents start in **trust** mode
> (auto-approve). You can still flip any agent back to manual from the dashboard.
>
> ```bash
> NEONCORE_URL=http://<server>.local:4040 NEONCORE_TRUST=1 python3 agent/install.py
> ```

### Option B: Copy just the agent folder

If you don't want the full repo on the remote machine, copy the `agent/` folder:

```bash
scp -r agent/ user@remote-machine:~/neoncore-agent/

# On the remote machine:
NEONCORE_URL=http://<server>.local:4040 python3 ~/neoncore-agent/install.py
```

### Verify hooks installed

Check that hooks were added to Claude Code's settings:

```bash
cat ~/.claude/settings.json
```

You should see entries for `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SubagentStop`, `UserPromptSubmit`, and `SessionEnd`.

> **`SessionEnd` is the one to check on an existing machine.** It was added later, and it is
> what tells the server a session actually exited. Without it the cartridge never goes
> offline on its own — it lingers until the 24-hour zombie reaper. If it's missing, re-run
> the installer (below); hooks are read at session start, so restart Claude Code afterwards.

### Restart Claude Code

After installing hooks, restart any running Claude Code sessions so they pick up the new hook configuration.

---

## Step 3: Install a command channel (on the remote machine)

The dashboard needs a way to send prompts/commands (and dispatched tasks) back to
the agent. Use **Option A** if you work in VS Code, or **Option B** for a bare
terminal / headless machine.

### Option A — VS Code Extension

The extension enables the dashboard to send prompts/commands to the Claude Code terminal in VS Code.

### Build and install the VSIX

On the machine with the repo:

```bash
# from the repo root:
npm run extension:package
```

This runs the extension's build + `vsce package` and creates a versioned VSIX in `extension/`
(e.g. `neoncore-extension-0.5.3.vsix` — the version tracks `extension/package.json`). Copy it to
the remote machine and install:

```bash
code --install-extension neoncore-extension-0.5.3.vsix
```

### Configure the extension

In VS Code on the remote machine, open Settings and search for "NeonCore":

- **Orchestrator URL**: Set to `http://<server>.local:4040`
- **Auto Connect**: Leave enabled (default: true)

Or edit VS Code's `settings.json` directly:

```json
{
  "neoncore.orchestratorUrl": "http://<server>.local:4040",
  "neoncore.autoConnect": true
}
```

### Verify connection

Look for the **NeonCore** status bar item in the bottom-right of VS Code:
- `$(plug) NeonCore` = connected
- `$(debug-disconnect) NeonCore` = disconnected (click to connect)

You can also check the NeonCore output channel: **View → Output → NeonCore**

### Option B — Terminal relay (headless / no editor)

Instead of the VS Code extension, you can launch Claude Code inside the **NeonCore
relay** — a PTY wrapper (the "Gridlight terminal") that owns the session and types
dispatched commands and tasks straight into it. One relay = one agent = one
terminal, so delivery is perfectly addressed.

```bash
# In the repo you want to work in:
NEONCORE_URL=http://<server>.local:4040 node /path/to/neoncore/agent/relay/launch.js
```

On first run it installs the relay's deps and (best-effort) the hooks, then
launches `claude` bridged to the dashboard. Everything after a literal `--` is
forwarded to Claude Code (e.g. `… launch.js -- --resume`). Full details and env
vars: [agent/relay/README.md](agent/relay/README.md).

---

## Step 4: Verify on the Dashboard

Open the dashboard at `http://<server>.local:4040` in your browser.

1. **Agent appears** — The remote machine's agent should show up with the repo name
2. **Activity flows** — Start using Claude Code; tool calls and messages should appear in the activity feed
3. **Commands work** — Type a prompt in the agent's command input on the dashboard; it should arrive in the Claude Code terminal in VS Code

---

## Troubleshooting

### Agent doesn't appear on dashboard
- Check that hooks are installed: `cat ~/.claude/settings.json`
- Check the orchestrator URL in the hooks matches the server's network address
- Make sure the server is reachable: `curl http://<server>.local:4040/api/health`
- Restart Claude Code after installing hooks

### Extension shows "Disconnected"
- Click the NeonCore status bar item to reconnect
- Check the extension's orchestrator URL setting
- Verify network connectivity to the server
- Check VS Code's NeonCore output channel for error details

### Commands sent from dashboard don't arrive
- Ensure the VS Code extension is connected (status bar shows connected)
- Check the NeonCore output channel in VS Code for delivery logs
- The agent must have been registered by BOTH the hooks AND the extension for command relay to work

### Bash commands hang ~10 minutes, then run (or time out)
This is **manual mode**, not a broken hook. Each tool call creates a *pending*
permission that waits for a human to approve it on the dashboard; with no approval the
hook long-polls (5 × 120s) and then falls back. Two fixes:
- **Approve on the dashboard** — open the agent and click *Approve* on each request, or
- **Switch the agent to Trust mode** on the dashboard (auto-approves everything for that
  agent, and immediately clears anything currently queued).

To make a remote machine trust-by-default at install time, re-run the installer with
`NEONCORE_TRUST=1` (see Step 2).

### Activity missing from feed
- Ensure hooks are installed for all events (run `install.sh` again to update)
- Check server logs for incoming hook requests
- The orchestrator URL must be correct and reachable

---

## Updating

When NeonCore is updated, re-run these on each remote machine:

```bash
# Re-install hooks (picks up new hook events)
NEONCORE_URL=http://<server>.local:4040 python3 agent/install.py

# Re-build and re-install the extension
npm run extension:package
code --install-extension extension/neoncore-extension-*.vsix
```

> Simpler: re-run the packaged `bootstrap.sh` / `bootstrap.ps1` from a fresh agent zip — it
> refreshes `~/.neoncore/agent` and reinstalls hooks cleanly (see [INSTALL.md](INSTALL.md)).

> Relay users don't need to rebuild anything — the relay picks up new hooks on its
> next launch (and re-runs the hook installer if they're missing).

---

## What's next

Once a machine is connected, explore the core features:

- **[Task queue](docs/TASKS.md)** — queue work for agents, pin it to a project,
  dispatch it into a terminal, and track it to completion.
- **[Goals & cost](docs/GOALS.md)** — group projects under goals, set a budget,
  and watch real USD spend roll up from agent sessions.
- **[Workflows](WORKFLOWS.md)** — author multi-step canvas workflows.
