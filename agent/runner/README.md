# NeonCore Machine Runner

A small always-on daemon you run **once per computer**. It lets you start a cartridge on
*that* machine from the web or mobile portal — e.g. keep this running on your Windows box and
launch a cartridge there from your phone.

## How it works

1. On start it **registers** the machine with the orchestrator (`POST /api/machines/register`)
   and holds a Socket.io connection.
2. The machine shows up in the portal's **+ Launch** menu (web and mobile), listing its
   allowed folders.
3. When you launch from the portal, the runner **opens a real terminal on this machine** with
   **Claude (or Gridlight) running** in the chosen folder, ready to work — and it connects back
   as a cartridge you can also drive from the portal.

Opening a terminal (rather than a hidden background process) is deliberate: it starts a
**login shell**, so tools like `claude` are found on your `PATH` even when the runner itself is
started by launchd/systemd/Task Scheduler (which have a minimal environment), and you get a
visible session you can watch and type in — locally or on a remote machine.

The runner only ever launches in a directory from its `repos` **allowlist** — never an
arbitrary path.

## One runner per machine

"Once per computer" is enforced, not just advised. A machine's identity is the `machineId` in
`runner.config.json`, so a second process reading that file is a second daemon wearing the same
identity — and it answers every instruction too, which is how one **+ Launch** click ended up
opening two terminals. The usual way to get one is starting `node index.js` by hand next to the
installed service and forgetting about it; it survives closing the terminal.

A second start now exits instead, naming the pid already serving the machine (it holds
`.runner-<machineId>.lock` beside the config). Set `NEONCORE_RUNNER_ALLOW_MULTI=1` to override.
The server also addresses instructions to a single socket per machine and logs a warning when
more than one claims it, so a duplicate can never double a launch.

## Install (one command)

Requires Node.js 18+ (used by the relay) and Python 3 (used to install the status/approval
hooks). From the unzipped package:

**macOS / Linux**
```bash
cd runner
./setup.sh --server http://<server-name>.local:4040 --token YOUR_TOKEN --scan ~/code
```

**Windows (PowerShell)**
```powershell
cd runner
.\setup.ps1 -Server http://<server-name>.local:4040 -Token YOUR_TOKEN -Scan C:\code
```

This installs to `~/.neoncore/runner`, installs the hooks, registers an auto-start service
(launchd / systemd / Task Scheduler), and starts it. Remove later with `./setup.sh --uninstall`
(`-Uninstall` on Windows).

## Pairing token (the `--token`)

The token stops random machines from registering with your server. **Set it once on the
server, then give the same value to every machine.**

**1. Generate a token** — any long random string works:

```bash
openssl rand -hex 24
# no openssl? →  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

**2. Set it on the server** — run this once (from anywhere that can reach the server):

```bash
curl -X PUT http://<server-name>.local:4040/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"machine_pairing_token":"PASTE_THE_TOKEN"}'
```

**3. Use it on each machine** — pass the same value as `--token` (or `-Token`) to setup, e.g.
`--token PASTE_THE_TOKEN`. It's saved into `runner.config.json` and must match the server's
value exactly, or the machine gets a `401 Invalid pairing token` on register.

> You can leave the token empty **only** on a trusted LAN where the server isn't reachable from
> anywhere else. Anytime the server is reachable beyond your own machine, set a token.

## Choosing which folders to expose

The allowlist is the set of directories this machine will launch cartridges in. Pick it at
install time in any of three ways:

| How | Command |
|-----|---------|
| **Interactive browser** (recommended) — give neither `--repo` nor `--scan` | run `./setup.sh --server … --token …` |
| **Scan a folder** — add every git repo directly under it | `--scan ~/code`  ·  `-Scan C:\code` |
| **List repos explicitly** (repeatable) | `--repo ~/code/app --repo ~/code/api` |

With no `--repo`/`--scan`, setup opens a **folder browser** starting at your home directory.
Drill into a folder by number, go `u`p a level, then `s` to **scan** it (add every git repo
inside) or `a` to **add** that folder itself. Repeat, then `d` when done — no typing full paths.

### Change the folders later — two ways

1. **From the portal (no config editing):** open the **+ Launch** menu (web) or the **＋ Launch**
   button on the Cartridges tab (mobile), find the machine, tap **Edit folders**, then remove
   with ✕ or add a path. The runner validates each path against its own disk (a path that
   doesn't exist there is ignored), persists it, and re-registers.
2. **Edit the config:** change `repos` in `~/.neoncore/runner/runner.config.json` and restart
   the runner (or just re-run `setup.sh`).

### Config (`runner.config.json`)

| Field | Meaning |
|-------|---------|
| `serverUrl` | Orchestrator base URL. Prefer the server's mDNS name over an IP (which changes): `http://<server-name>.local:4040`, e.g. `http://Mannys-Mac-Pro.local:4040`. Must be reachable from this machine. |
| `token` | Pairing token. Must match the server's `machine_pairing_token` setting (leave `""` only if the server has none — dev/LAN only). |
| `machineId` | Leave `""`; a stable id is generated and saved back on first run. |
| `hostname` | Optional display name; defaults to the OS hostname. |
| `repos` | The allowlist of launchable directories: `[{ "path": "...", "name": "..." }]`. |

## Security

Remote launch is effectively remote code execution on this machine, so:

- The machine only participates while **you** run this daemon.
- It only launches inside the configured **allowlist**.
- Set a `machine_pairing_token` on the server and match it here so only your runner can
  register. Required if the orchestrator is reachable beyond your LAN.

## Managing exposed folders later

- **From the portal (no editing on the machine):** open **+ Launch**, click **Edit folders**
  on the machine, then remove with ✕, **Add** a path, or **Scan** a path (adds every git repo
  under it on that machine). Same controls on the mobile app.
- **On the machine:** re-run `setup.sh`/`setup.ps1`, or edit `repos` in
  `~/.neoncore/runner/runner.config.json` and restart.

## Keeping it running

`setup.sh`/`setup.ps1` install this automatically, but for reference the auto-start service is:

- **Windows:** a Scheduled Task at logon (runs hidden).
- **macOS:** a `launchd` LaunchAgent.
- **Linux:** a `systemd` user service.

The daemon's own output goes to `~/.neoncore/runner/logs/runner.out.log`. Each launched
cartridge runs in its **own terminal window**, so its session output is right there.

## Notes

- On macOS, the first launch may trigger a one-time "control Terminal" Automation permission
  prompt — approve it once.
- Launch context typed into the portal is passed through as `NEONCORE_LAUNCH_CONTEXT` but is
  not yet auto-injected into the agent session — send it as a command after launch for now.
