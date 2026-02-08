# Setting Up NeonCore on Another Computer

This guide walks through connecting a new machine (or remote computer) to your NeonCore orchestrator.

## Prerequisites

- **Node.js** (v18+) and **npm** installed on both machines
- **Claude Code** installed on the remote machine
- **VS Code** with the Claude Code extension on the remote machine
- **Network access** from the remote machine to the orchestrator server (same LAN or VPN)

## Architecture Overview

```
[Remote Machine]                       [Server Machine]
  VS Code + Claude Code  ──HTTP/WS──▶  NeonCore Server (:4040)
  NeonCore Extension                    Dashboard UI
  Claude Code Hooks
```

The remote machine needs two things installed:
1. **Claude Code hooks** — report activity and handle permissions
2. **VS Code extension** — enables command relay from the dashboard

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

### Option A: Clone the repo and run the installer

```bash
git clone <your-neoncore-repo-url>
cd neoncore

# Install with the orchestrator's network URL
NEONCORE_URL=http://<server-ip>:4040 ./agent/install.sh
```

### Option B: Copy just the agent folder

If you don't want the full repo on the remote machine, copy the `agent/` folder:

```bash
scp -r agent/ user@remote-machine:~/neoncore-agent/

# On the remote machine:
NEONCORE_URL=http://<server-ip>:4040 ~/neoncore-agent/install.sh
```

### Verify hooks installed

Check that hooks were added to Claude Code's settings:

```bash
cat ~/.claude/settings.json
```

You should see entries for `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SubagentStop`, and `UserPromptSubmit`.

### Restart Claude Code

After installing hooks, restart any running Claude Code sessions so they pick up the new hook configuration.

---

## Step 3: Install the VS Code Extension (on the remote machine)

The extension enables the dashboard to send prompts/commands to the Claude Code terminal in VS Code.

### Build and install the VSIX

On the machine with the repo:

```bash
cd neoncore/extension
npm install
npm run compile

# Package as VSIX (requires vsce)
npx @vscode/vsce package --no-dependencies
```

This creates `neoncore-extension-0.1.5.vsix`. Copy it to the remote machine and install:

```bash
code --install-extension neoncore-extension-0.1.5.vsix
```

### Configure the extension

In VS Code on the remote machine, open Settings and search for "NeonCore":

- **Orchestrator URL**: Set to `http://<server-ip>:4040`
- **Auto Connect**: Leave enabled (default: true)

Or edit VS Code's `settings.json` directly:

```json
{
  "neoncore.orchestratorUrl": "http://<server-ip>:4040",
  "neoncore.autoConnect": true
}
```

### Verify connection

Look for the **NeonCore** status bar item in the bottom-right of VS Code:
- `$(plug) NeonCore` = connected
- `$(debug-disconnect) NeonCore` = disconnected (click to connect)

You can also check the NeonCore output channel: **View → Output → NeonCore**

---

## Step 4: Verify on the Dashboard

Open the dashboard at `http://<server-ip>:4040` in your browser.

1. **Agent appears** — The remote machine's agent should show up with the repo name
2. **Activity flows** — Start using Claude Code; tool calls and messages should appear in the activity feed
3. **Commands work** — Type a prompt in the agent's command input on the dashboard; it should arrive in the Claude Code terminal in VS Code

---

## Troubleshooting

### Agent doesn't appear on dashboard
- Check that hooks are installed: `cat ~/.claude/settings.json`
- Check the orchestrator URL in the hooks matches the server's network address
- Make sure the server is reachable: `curl http://<server-ip>:4040/api/health`
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

### Activity missing from feed
- Ensure hooks are installed for all events (run `install.sh` again to update)
- Check server logs for incoming hook requests
- The orchestrator URL must be correct and reachable

---

## Updating

When NeonCore is updated, re-run these on each remote machine:

```bash
# Re-install hooks (picks up new hook events)
NEONCORE_URL=http://<server-ip>:4040 ./agent/install.sh

# Re-build and re-install the extension
cd extension && npm run compile
npx @vscode/vsce package --no-dependencies
code --install-extension neoncore-extension-*.vsix
```
