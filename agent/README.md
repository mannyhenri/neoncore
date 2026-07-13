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
1. Finds the NeonCore server (pass `--server-url` / `-ServerUrl`, or it scans your LAN).
2. Copies the agent files to a stable home (`~/.neoncore/agent`) and installs the Claude Code hooks there.
3. Builds the relay and launches a Claude Code session that appears in the dashboard.

### Point it at the server's hostname, not its IP

```bash
./bootstrap.sh --server-url http://YOUR-SERVER.local:4040
```

> **Use `--server-url` with the server's `.local` (mDNS) hostname — not `--server-ip`.**
> The installer **bakes the URL as a literal string** into `~/.claude/settings.json` and never
> re-reads it. A LAN IP is a DHCP lease, so the day it changes, every hook POST on this
> machine silently goes nowhere: the cartridge just stops appearing, with no error anywhere.
> The `.local` name follows the machine. Check it answers first:
> `curl http://YOUR-SERVER.local:4040/api/health`

Useful flags: `--trust` / `-Trust` (auto-approve permissions), `--repo-path` / `-RepoPath`,
`--skip-relay` / `-SkipRelay`.

## Relaunch a session later

The agent home is permanent, so just start a relay in any repo:

```bash
# Mac/Linux
NEONCORE_URL=http://YOUR-SERVER.local:4040 node ~/.neoncore/agent/relay/index.js
```
```powershell
# Windows
$env:NEONCORE_URL="http://YOUR-SERVER.local:4040"; node "$HOME\.neoncore\agent\relay\index.js"
```

## Troubleshooting

- **Windows: "running scripts is disabled"** — `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` for installs.
- **Windows: relay dies with `File not found:`** — Claude Code isn't on PATH. Install it, reopen PowerShell, re-run.
- **macOS: "Operation not permitted"** — grant your terminal **Full Disk Access** (System Settings → Privacy & Security), then `Cmd-Q` and reopen. Or keep repos under `~/code` (not Desktop/Documents/Downloads).
- **Agent doesn't appear** — first check the server is reachable *from this machine*: `curl http://YOUR-SERVER.local:4040/api/health`. If that works but the cartridge still never shows, the hooks are pointed somewhere else: `grep -o 'NEONCORE_URL=[^ ]*' ~/.claude/settings.json`. A stale IP baked in at install time is the most common cause — re-run the bootstrap with `--server-url`.
- **Cartridge never goes offline** — this machine predates the `SessionEnd` hook. Re-run the bootstrap, then restart Claude Code (hooks load at session start).

More detail: **[SETUP.md](SETUP.md)** in this folder.
