# Installing & Distributing NeonCore

NeonCore has two roles. Install the one you need:

| Role | What it is | Install with |
|---|---|---|
| **Server host** | Runs the orchestrator + dashboard (port 4040). One per network. | `neoncore-full.zip` → `install-neoncore.sh` / `.ps1` |
| **Agent machine** | A Mac/Windows box whose Claude Code sessions show up as cartridges. Many per network. | `neoncore-agent-mac.zip` / `neoncore-agent-windows.zip` → `bootstrap.sh` / `.ps1` |

The three distributable packages are built into `dist/` by [`scripts/package.sh`](scripts/package.sh) (see [Building the packages](#building-the-packages)). Share them directly or attach them to a GitHub Release.

---

## 1. Server host — install the full orchestrator

The machine that everyone else connects to. **One per LAN.**

**Prerequisites:** [Node.js 18+](https://nodejs.org) (ships with npm).

### Mac / Linux

```bash
# from neoncore-full.zip:
unzip neoncore-full.zip && cd neoncore
./install-neoncore.sh

# ...or from a clone:
git clone git@github.com:GRIDLIGHT-INC/neoncore.git && cd neoncore
./install-neoncore.sh
```

### Windows

```powershell
# from neoncore-full.zip: right-click -> Extract All, then:
cd neoncore
powershell -ExecutionPolicy Bypass -File .\install-neoncore.ps1
```

The installer checks Node, runs `npm install`, `npm run build`, and offers to start the server. When it starts it prints two URLs:

- **Local:** `http://localhost:4040` — open this in your browser for the dashboard.
- **Network:** `http://<lan-ip>:4040` — this is the URL agent machines connect to. Note it down.

Flags: `--start` (start without prompting), `--no-start` (build only), `--dev` (hot-reload dev mode). On Windows use `-Start` / `-NoStart` / `-Dev`.

> **Firewall:** allow inbound TCP **4040** on the host so other machines can reach it. macOS: System Settings → Network → Firewall. Windows: Windows Defender Firewall → inbound rule.

---

## 2. Agent machine — connect to the server

Any Mac or Windows box you want to drive from the dashboard.

**Prerequisites:** [Node.js 18+](https://nodejs.org), [Claude Code](https://www.anthropic.com/claude-code) (`npm install -g @anthropic-ai/claude-code`), and Python 3 (built into macOS; on Windows install from [python.org](https://python.org) and check "Add to PATH").

The bootstrap **copies the agent files to a stable home** (`~/.neoncore/agent`) and installs from there, so it's safe to run from Downloads and delete the download after.

### Mac / Linux

```bash
unzip neoncore-agent-mac.zip
cd ~/code/my-project                 # the repo you want the agent to work in
~/Downloads/neoncore-agent/bootstrap.sh
```

If macOS blocks it ("unidentified developer"), run `bash ~/Downloads/neoncore-agent/bootstrap.sh` instead.

### Windows

```powershell
# extract neoncore-agent-windows.zip, then:
powershell -ExecutionPolicy Bypass -File "$HOME\Downloads\neoncore-agent\bootstrap.ps1" -RepoPath "C:\code\my-project"
```

Either script: auto-finds the server, installs the Claude Code hooks, builds the relay, and launches a live Claude Code session that appears as a cartridge in the dashboard.

**Useful flags** (same on both, PowerShell uses `-Flag`, bash uses `--flag`):

| Flag | Effect |
|---|---|
| `--server-ip <ip>` / `-ServerIp` | Skip discovery, use this server. |
| `--repo-path <dir>` / `-RepoPath` | Which repo the session runs in. |
| `--trust` / `-Trust` | Auto-approve this agent's permissions (no manual dashboard approval). |
| `--skip-relay` / `-SkipRelay` | Install hooks only; don't launch a session. |

### Relaunch a session later

The agent home is permanent, so you don't re-run the whole bootstrap — just start a relay in any repo:

```bash
# Mac/Linux
NEONCORE_URL=http://<server-ip>:4040 node ~/.neoncore/agent/relay/index.js
```
```powershell
# Windows
$env:NEONCORE_URL="http://<server-ip>:4040"; node "$HOME\.neoncore\agent\relay\index.js"
```

---

## Verify

Open `http://<server-ip>:4040`. The agent machine appears as a cartridge with its repo name; tool activity flows into its feed; a prompt typed into its command box is typed into the live session.

---

## Updating

- **Server host:** pull/replace the repo and re-run `install-neoncore.sh` / `.ps1`.
- **Agent machine:** re-run `bootstrap.sh` / `.ps1` from a fresh agent zip — it refreshes `~/.neoncore/agent` and re-installs the hooks cleanly.

---

## Troubleshooting

**Hooks error with `No such file or directory`.** The agent home was moved/deleted. Re-run the bootstrap (it reinstalls to `~/.neoncore/agent`). This is exactly why the bootstrap relocates out of Downloads — never point hooks at a throwaway folder.

**macOS "Operation not permitted" on file reads/edits.** That's macOS TCC. Grant **Full Disk Access** to your terminal app (System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm), then `Cmd-Q` and reopen it. Keeping repos under `~/code` (not `~/Desktop`/`~/Documents`/`~/Downloads`) avoids TCC entirely.

**Windows "running scripts is disabled on this system."** PowerShell's execution policy is blocking the `npm`/`.ps1` shim. Either `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` (persistent, no admin), or call the `.cmd` directly: `npm.cmd install -g @anthropic-ai/claude-code`.

**Windows relay dies with `File not found:`.** Claude Code isn't on PATH. `npm install -g @anthropic-ai/claude-code`, reopen PowerShell, re-run the bootstrap.

**Agent doesn't appear.** Confirm the server is reachable from the agent machine: `curl http://<server-ip>:4040/api/health` (Mac) or `Invoke-RestMethod http://<server-ip>:4040/api/health` (Windows). Check the firewall and that both are on the same subnet.

**Bash/Edit hang ~10 min then run.** That's manual permission mode — approve on the dashboard, or install with `--trust` / `-Trust` (or flip the agent to Trust mode in the dashboard).

---

## Building the packages

From a checkout on Mac/Linux:

```bash
./scripts/package.sh
```

Produces into `dist/` (gitignored — these are build artifacts):

- `neoncore-agent-mac.zip`
- `neoncore-agent-windows.zip`
- `neoncore-full.zip`

The full package is assembled from git-tracked files (current working-tree content) plus the installer/bootstrap scripts, so local data, the SQLite DB, secrets, and build output never leak in. Upload the zips to a GitHub Release to distribute.

---

See also: [SETUP.md](SETUP.md) (detailed connection options incl. the VS Code extension), [agent/relay/README.md](agent/relay/README.md) (the relay internals), [docs/TASKS.md](docs/TASKS.md), [docs/GOALS.md](docs/GOALS.md).
