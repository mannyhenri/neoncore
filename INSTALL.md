# Installing & Distributing NeonCore

NeonCore has three roles. Install the one you need:

| Role | What it is | Install with |
|---|---|---|
| **Server host** | Runs the orchestrator + dashboard (port 4040). One per network. | `neoncore-full.zip` → `install-neoncore.sh` / `.ps1` |
| **Agent machine** | A Mac/Linux/Windows box whose Claude Code sessions show up as cartridges. Many per network. | `neoncore-agent-mac.zip` / `-linux.zip` / `-windows.zip` → `bootstrap.sh` / `.ps1` |
| **Phone** | iOS app — watch cartridges, read transcripts, answer approvals, launch workflows. | TestFlight → see [Phone (iOS)](#phone-ios) |

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
- **Network:** `http://<lan-ip>:4040` — reachable from other machines on the LAN.

### `<SERVER>` — the one value you need everywhere else

The rest of this guide writes the server address as `http://<SERVER>:4040`. Substitute
**either** the server's hostname **or** its IP — whichever works on your network:

| `<SERVER>` | How to get it | Notes |
|---|---|---|
| **Hostname** — `studio.local`, `desktop-abc` | run `hostname` on the server | **Preferred.** Survives DHCP changes. `.local` (mDNS) is automatic on macOS, and usually works on Windows 10+/Linux. |
| **IP** — `192.168.4.24` | `ipconfig getifaddr en0` (Mac) · `ipconfig` (Windows) · `hostname -I` (Linux) | Use if mDNS is blocked on your network. **Set a DHCP reservation** on your router, or the address will eventually change. |

Confirm it answers **from the machine you're installing on**, before you install anything:

```bash
curl http://<SERVER>:4040/api/health           # Mac / Linux
Invoke-RestMethod http://<SERVER>:4040/api/health   # Windows
```

You should get `{"status":"ok"}`. If the hostname doesn't resolve, fall back to the IP.

> **Why it matters which one you pick:** the agent installer **bakes this URL as a literal
> string** into `~/.claude/settings.json` and never re-reads it. If the address later changes
> — which a DHCP lease eventually will — every hook POST from that machine silently goes
> nowhere. The cartridge simply stops appearing, with no error on either side. A hostname, or
> a reserved IP, avoids this permanently.

Flags: `--start` (start without prompting), `--no-start` (build only), `--dev` (hot-reload dev mode). On Windows use `-Start` / `-NoStart` / `-Dev`.

> **Firewall:** allow inbound TCP **4040** on the host so other machines can reach it. macOS: System Settings → Network → Firewall. Windows: Windows Defender Firewall → inbound rule.

---

## 2. Agent machine — connect to the server

Any Mac or Windows box you want to drive from the dashboard.

**Prerequisites:** [Node.js 18+](https://nodejs.org), [Claude Code](https://www.anthropic.com/claude-code) (`npm install -g @anthropic-ai/claude-code`), and Python 3 (built into macOS; on Windows install from [python.org](https://python.org) and check "Add to PATH").

The bootstrap **copies the agent files to a stable home** (`~/.neoncore/agent`) and installs from there, so it's safe to run from Downloads and delete the download after.

### Mac / Linux

```bash
unzip neoncore-agent-mac.zip         # or neoncore-agent-linux.zip
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
| `--server-url <url>` / `-ServerUrl` | **Preferred.** Full server URL, e.g. `http://<SERVER>:4040`. Survives DHCP changes; see the warning above. |
| `--server-ip <ip>` / `-ServerIp` | Skip discovery, use this IP. Works, but rots when the lease changes. |
| `--repo-path <dir>` / `-RepoPath` | Which repo the session runs in. |
| `--trust` / `-Trust` | Auto-approve this agent's permissions (no manual dashboard approval). |
| `--skip-relay` / `-SkipRelay` | Install hooks only; don't launch a session. |

### Relaunch a session later

The agent home is permanent, so you don't re-run the whole bootstrap — just start a relay in any repo:

```bash
# Mac/Linux
NEONCORE_URL=http://<SERVER>:4040 node ~/.neoncore/agent/relay/index.js
```
```powershell
# Windows
$env:NEONCORE_URL="http://<SERVER>:4040"; node "$HOME\.neoncore\agent\relay\index.js"
```

---

## Verify

Open `http://<SERVER>:4040`. The agent machine appears as a cartridge with its repo name; tool activity flows into its feed; a prompt typed into its command box is typed into the live session.

---

## Phone (iOS)

The NeonCore mobile app mirrors the cartridge grid on your phone: read transcripts, answer
approvals, launch workflows, send prompts.

1. **Install from TestFlight.** You need to be added as an internal tester — being the App
   Store Connect account holder is *not* enough. In App Store Connect → TestFlight →
   Internal Testing, add the Apple ID **that is signed in to the TestFlight app on the
   phone** (often not your developer account email), then assign the build to that group.
2. **Put the phone on the same Wi-Fi as the server.** It's a LAN app — no cloud, no auth.
3. **Launch it and enter the server URL:** `http://<SERVER>:4040` (the `.local`
   hostname, for the DHCP reason above).
4. **Accept the one-time iOS "allow local network access" prompt.** If you decline it, the
   app cannot reach the server at all and simply looks broken, with no useful error. Recover
   under Settings → NeonCore → Local Network. (This prompt never appears in the simulator,
   so it's easy to forget it exists.)

Development, builds, and OTA updates: **[mobile/README.md](mobile/README.md)**.

---

## Updating

- **Server host:** pull/replace the repo and re-run `install-neoncore.sh` / `.ps1`.
- **Agent machine:** re-run `bootstrap.sh` / `.ps1` from a fresh agent zip — it refreshes `~/.neoncore/agent` and re-installs the hooks cleanly.

> **Machines installed before the `SessionEnd` hook must be re-bootstrapped.** `SessionEnd` is
> what reports that a session actually exited; without it, that machine's cartridges never go
> offline on their own and linger until the 24-hour zombie reaper. Check with:
>
> ```bash
> grep -c SessionEnd ~/.claude/settings.json    # 0 = needs a re-bootstrap
> ```
>
> Hooks are read at session start, so **restart Claude Code afterwards** — sessions already
> running keep the old config.

---

## Troubleshooting

**Hooks error with `No such file or directory`.** The agent home was moved/deleted. Re-run the bootstrap (it reinstalls to `~/.neoncore/agent`). This is exactly why the bootstrap relocates out of Downloads — never point hooks at a throwaway folder.

**macOS "Operation not permitted" on file reads/edits.** That's macOS TCC. Grant **Full Disk Access** to your terminal app (System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm), then `Cmd-Q` and reopen it. Keeping repos under `~/code` (not `~/Desktop`/`~/Documents`/`~/Downloads`) avoids TCC entirely.

**Windows "running scripts is disabled on this system."** PowerShell's execution policy is blocking the `npm`/`.ps1` shim. Either `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` (persistent, no admin), or call the `.cmd` directly: `npm.cmd install -g @anthropic-ai/claude-code`.

**Windows relay dies with `File not found:`.** Claude Code isn't on PATH. `npm install -g @anthropic-ai/claude-code`, reopen PowerShell, re-run the bootstrap.

**Agent doesn't appear.** First confirm the server is reachable *from the agent machine*: `curl http://<SERVER>:4040/api/health` (Mac) or `Invoke-RestMethod http://<SERVER>:4040/api/health` (Windows). Check the firewall and that both are on the same subnet.

If the server *is* reachable but the cartridge still never shows, the hooks are pointed somewhere else. The URL is baked into the settings file at install time and never re-read, so a server IP change orphans the machine silently:

```bash
grep -o 'NEONCORE_URL=[^ ]*' ~/.claude/settings.json    # is this still your server?
```

Re-run the bootstrap with `--server-url http://<SERVER>:4040` to repoint it.

**Cartridge never goes offline / lingers for a day.** That machine predates the `SessionEnd` hook (`grep -c SessionEnd ~/.claude/settings.json` → 0). Re-bootstrap it, then restart Claude Code.

**Bash/Edit hang ~10 min then run.** That's manual permission mode — approve on the dashboard, or install with `--trust` / `-Trust` (or flip the agent to Trust mode in the dashboard).

---

## Building the packages

From a checkout on Mac/Linux:

```bash
./scripts/package.sh
```

Produces into `dist/` (gitignored — these are build artifacts):

- `neoncore-agent-mac.zip`
- `neoncore-agent-linux.zip`
- `neoncore-agent-windows.zip`
- `neoncore-full.zip`

The full package is assembled from git-tracked files (current working-tree content) plus the installer/bootstrap scripts, so local data, the SQLite DB, secrets, and build output never leak in. Upload the zips to a GitHub Release to distribute.

---

See also: [SETUP.md](SETUP.md) (detailed connection options incl. the VS Code extension), [agent/relay/README.md](agent/relay/README.md) (the relay internals), [docs/TASKS.md](docs/TASKS.md), [docs/GOALS.md](docs/GOALS.md).
