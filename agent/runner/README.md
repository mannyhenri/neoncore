# NeonCore Machine Runner

A small always-on daemon you run **once per computer**. It lets you start a cartridge on
*that* machine from the web or mobile portal — e.g. keep this running on your Windows box and
launch a cartridge there from your phone.

## How it works

1. On start it **registers** the machine with the orchestrator (`POST /api/machines/register`)
   and holds a Socket.io connection.
2. The machine shows up in the portal's **Launch on machine** picker, along with its allowed
   repos.
3. When you launch from the portal, the server dispatches a `launch_cartridge` event to this
   runner, which **spawns the relay** in the chosen repo. A new cartridge appears and connects
   back exactly like a locally-launched one.

The runner only ever launches in a directory from its `repos` **allowlist** — never an
arbitrary path.

## Setup

```bash
cd agent/runner
npm install
cp runner.config.example.json runner.config.json   # then edit it
npm start
```

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

## Keeping it running

- **Windows:** run via Task Scheduler (at logon) or NSSM as a service.
- **macOS:** a `launchd` LaunchAgent.
- **Linux:** a `systemd` user service.

Logs for each launched cartridge are written to `agent/runner/logs/`.

## Notes

- Launch context typed into the portal is passed through as `NEONCORE_LAUNCH_CONTEXT` but is
  not yet auto-injected into the agent session — send it as a command after launch for now.
