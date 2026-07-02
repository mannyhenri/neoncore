# NeonCore Agent — Quick Start

This package connects **this machine** to a NeonCore server. After setup, your Claude Code sessions
show up as live "cartridges" in the dashboard, and you can drive them from there.

## Prerequisites

- **Node.js 18+** — https://nodejs.org
- **Claude Code** — `npm install -g @anthropic-ai/claude-code`
- **Python 3** — built into macOS; on Windows install from https://python.org (check "Add to PATH")

## Run it

**Mac / Linux** — from inside the repo you want the agent to work in:

```bash
cd ~/code/my-project
/path/to/neoncore-agent/bootstrap.sh
```
(If macOS blocks it: `bash /path/to/neoncore-agent/bootstrap.sh`)

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -File "C:\path\to\neoncore-agent\bootstrap.ps1" -RepoPath "C:\code\my-project"
```

That's it. The bootstrap:
1. Auto-finds the NeonCore server (default `192.168.4.20:4040`; pass `--server-ip <ip>` / `-ServerIp <ip>` to override, or it scans your LAN).
2. Copies the agent files to a stable home (`~/.neoncore/agent`) and installs the Claude Code hooks there.
3. Builds the relay and launches a Claude Code session that appears in the dashboard.

Useful flags: `--trust` / `-Trust` (auto-approve permissions), `--repo-path` / `-RepoPath`,
`--skip-relay` / `-SkipRelay`.

## Relaunch a session later

The agent home is permanent, so just start a relay in any repo:

```bash
# Mac/Linux
NEONCORE_URL=http://192.168.4.20:4040 node ~/.neoncore/agent/relay/index.js
```
```powershell
# Windows
$env:NEONCORE_URL="http://192.168.4.20:4040"; node "$HOME\.neoncore\agent\relay\index.js"
```

## Troubleshooting

- **Windows: "running scripts is disabled"** — `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` for installs.
- **Windows: relay dies with `File not found:`** — Claude Code isn't on PATH. Install it, reopen PowerShell, re-run.
- **macOS: "Operation not permitted"** — grant your terminal **Full Disk Access** (System Settings → Privacy & Security), then `Cmd-Q` and reopen. Or keep repos under `~/code` (not Desktop/Documents/Downloads).
- **Agent doesn't appear** — check the server is reachable: `curl http://192.168.4.20:4040/api/health`.

More detail: **[SETUP.md](SETUP.md)** in this folder.
