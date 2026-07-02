# NeonCore Agent Setup — External Computers

Connect any Mac, Linux, or Windows machine on your local network to the NeonCore orchestrator.

> **Prefer the packaged installer.** The one-command path — `neoncore-agent-*.zip` →
> `bootstrap.sh` / `bootstrap.ps1` — is documented in **[../INSTALL.md](../INSTALL.md)** and installs
> to a stable home (`~/.neoncore/agent`) so hooks don't break. This file documents the underlying
> manual `install.py` steps it runs.

## Prerequisites

- The NeonCore server must be running on your main machine
- Both machines must be on the same local network
- Claude Code must be installed on the external machine
- **Python 3** must be available (pre-installed on macOS; install from python.org on Windows)

## Step 1: Find the server IP

On the machine running the NeonCore server, find its LAN IP:

```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'

# Windows (PowerShell)
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike '*Loopback*' }).IPAddress
```

The server runs on port **4040** by default.

## Step 2: Copy the agent folder

Copy the `agent/` folder from the NeonCore repo to the external machine. You can use AirDrop, scp, USB, OneDrive, or any method:

```bash
# From the server machine via scp (Mac/Linux):
scp -r /path/to/neoncore/agent user@external-machine:~/neoncore-agent
```

The folder contains:
```
agent/
├── install.py                  # Cross-platform hook installer (recommended)
├── install.sh                  # Bash hook installer (Mac/Linux only)
├── SETUP.md                    # This file
└── hooks/
    ├── reporter.py             # Reports tool usage to orchestrator
    ├── permission-proxy.py     # Intercepts permissions for dashboard approval
    ├── message-reader.py       # Captures Claude's responses
    ├── notification.py         # Captures Claude notifications
    ├── reporter.sh             # (legacy bash version)
    ├── permission-proxy.sh     # (legacy bash version)
    ├── message-reader.sh       # (legacy bash version)
    └── notification.sh         # (legacy bash version)
```

## Step 3: Install hooks

### Mac / Linux
```bash
NEONCORE_URL=http://<server-ip>:4040 python3 ~/neoncore-agent/install.py
```

### Windows (PowerShell)
```powershell
$env:NEONCORE_URL = "http://<server-ip>:4040"
python ~/neoncore-agent/install.py
```

Or use the `--url` flag on any platform:
```
python install.py --url http://<server-ip>:4040
```

Replace `<server-ip>` with the IP from Step 1 (e.g., `192.168.4.192`).

This merges NeonCore hooks into `~/.claude/settings.json` without overwriting your existing settings.

## Step 4: Verify connectivity

From the external machine, test that it can reach the server:

```bash
# Mac / Linux
curl http://<server-ip>:4040/api/agents

# Windows (PowerShell)
Invoke-RestMethod http://<server-ip>:4040/api/agents
```

You should see a JSON array of agents. If it times out, check:

- **macOS Firewall**: On the server machine, go to System Settings → Network → Firewall. Either disable it or add an exception for Node.js / port 4040.
- **Windows Firewall**: On the server machine, allow inbound connections on port 4040 in Windows Defender Firewall.
- **Network**: Ensure both machines are on the same Wi-Fi / subnet.
- **Server running**: Make sure the NeonCore server is started (`npm start` in the neoncore directory).

## Step 5: Install the VS Code extension (optional)

The extension enables sending commands from the dashboard to Claude Code. Without it, monitoring and permission control still work.

```bash
code --install-extension /path/to/neoncore-extension-0.5.3.vsix
```

Then configure the server URL in VS Code settings:
- Open VS Code Settings (Cmd+, or Ctrl+,)
- Search for "neoncore"
- Set **Server URL** to `http://<server-ip>:4040`

## Uninstalling

To remove hooks, edit `~/.claude/settings.json` and delete the hook entries that reference `neoncore` or any of the hook scripts (`reporter.py`, `permission-proxy.py`, etc.).

Or re-run the installer — it replaces existing NeonCore hooks cleanly.

## Troubleshooting

**Hooks not reporting**: Run a hook manually to check for errors:
```bash
# Mac / Linux
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{}}' | NEONCORE_URL=http://<server-ip>:4040 python3 ~/neoncore-agent/hooks/reporter.py
```

```powershell
# Windows (PowerShell)
$env:NEONCORE_URL = "http://<server-ip>:4040"
'{"session_id":"test","cwd":"C:\\temp","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{}}' | python ~/neoncore-agent/hooks/reporter.py
```

**Permission prompts not appearing on dashboard**: Test the permission proxy:
```bash
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hello"}}' | NEONCORE_URL=http://<server-ip>:4040 python3 ~/neoncore-agent/hooks/permission-proxy.py
```

If the server is unreachable, it falls back to normal Claude Code permission behavior.
