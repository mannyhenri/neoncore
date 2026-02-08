# NeonCore Agent Setup — External Computers

Connect any Mac or Linux machine on your local network to the NeonCore orchestrator.

## Prerequisites

- The NeonCore server must be running on your main machine
- Both machines must be on the same local network
- Claude Code must be installed on the external machine
- Python 3 and curl must be available (pre-installed on macOS)

## Step 1: Find the server IP

On the machine running the NeonCore server, find its LAN IP:

```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'
```

The server runs on port **4040** by default.

## Step 2: Copy the agent folder

Copy the `agent/` folder from the NeonCore repo to the external machine. You can use AirDrop, scp, USB, or any method:

```bash
# From the server machine via scp:
scp -r /path/to/neoncore/agent user@external-machine:~/neoncore-agent
```

The folder contains:
```
agent/
├── install.sh                # Hook installer
├── SETUP.md                  # This file
└── hooks/
    ├── reporter.sh           # Reports tool usage to orchestrator
    ├── permission-proxy.sh   # Intercepts permissions for dashboard approval
    └── message-reader.sh     # Captures Claude's responses
```

## Step 3: Install hooks

On the external machine, run:

```bash
NEONCORE_URL=http://<server-ip>:4040 bash ~/neoncore-agent/install.sh
```

Replace `<server-ip>` with the IP from Step 1 (e.g., `192.168.4.192`).

This merges NeonCore hooks into `~/.claude/settings.json` without overwriting your existing settings.

## Step 4: Verify connectivity

From the external machine, test that it can reach the server:

```bash
curl http://<server-ip>:4040/api/agents
```

You should see a JSON array of agents. If it times out, check:

- **macOS Firewall**: On the server machine, go to System Settings → Network → Firewall. Either disable it or add an exception for Node.js / port 4040.
- **Network**: Ensure both machines are on the same Wi-Fi / subnet.
- **Server running**: Make sure the NeonCore server is started (`npm start` in the neoncore directory).

## Step 5: Install the VS Code extension (optional)

The extension enables sending commands from the dashboard to Claude Code. Without it, monitoring and permission control still work.

```bash
code --install-extension /path/to/neoncore-extension-0.1.0.vsix
```

Then configure the server URL in VS Code settings:
- Open VS Code Settings (Cmd+,)
- Search for "neoncore"
- Set **Server URL** to `http://<server-ip>:4040`

## Uninstalling

To remove hooks, edit `~/.claude/settings.json` and delete the hook entries that reference `neoncore` or `reporter.sh` / `permission-proxy.sh` / `message-reader.sh`.

## Troubleshooting

**Hooks not reporting**: Run a hook manually to check for errors:
```bash
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{}}' | NEONCORE_URL=http://<server-ip>:4040 bash ~/neoncore-agent/hooks/reporter.sh
```

**Permission prompts not appearing on dashboard**: The permission-proxy hook may fail silently. Test it:
```bash
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hello"}}' | NEONCORE_URL=http://<server-ip>:4040 bash ~/neoncore-agent/hooks/permission-proxy.sh
```
If the server is unreachable, it falls back to normal Claude Code permission behavior.
