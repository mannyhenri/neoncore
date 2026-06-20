#!/usr/bin/env bash
# NeonCore Agent Hook Installer
# Installs Claude Code hooks that connect to the NeonCore orchestrator.
#
# Usage:
#   ./install.sh                          # Install with defaults (localhost:4040)
#   NEONCORE_URL=http://192.168.1.50:4040 ./install.sh  # Custom orchestrator URL

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/hooks"
SETTINGS_FILE="$HOME/.claude/settings.json"
ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"

# Per-machine trust opt-in. Run with NEONCORE_TRUST=1 to have agents from this
# machine start in trust mode (auto-approve) instead of the default 'manual'.
# When set, hook commands carry "NEONCORE_TRUST=1" so the register call flags new agents.
case "$(printf '%s' "${NEONCORE_TRUST:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) TRUST_ENV="NEONCORE_TRUST=1 " ;;
  *)             TRUST_ENV="" ;;
esac

echo "NeonCore Agent Hook Installer"
echo "=============================="
echo ""
echo "Orchestrator URL: $ORCHESTRATOR_URL"
echo "Trust mode:       ${TRUST_ENV:+enabled (new agents auto-approve)}${TRUST_ENV:-disabled (manual approval)}"
echo "Settings file:    $SETTINGS_FILE"
echo "Hooks directory:  $HOOKS_DIR"
echo ""

# Make hook scripts executable
chmod +x "$HOOKS_DIR/reporter.sh"
chmod +x "$HOOKS_DIR/permission-proxy.sh"
chmod +x "$HOOKS_DIR/message-reader.sh"
chmod +x "$HOOKS_DIR/notification.sh"

# Ensure .claude directory exists
mkdir -p "$HOME/.claude"

# Create or update settings.json with hooks
if [ -f "$SETTINGS_FILE" ]; then
  echo "Existing settings.json found. Merging hooks..."

  /usr/bin/env python3 << PYEOF
import json, sys

settings_file = "$SETTINGS_FILE"
hooks_dir = "$HOOKS_DIR"
orchestrator_url = "$ORCHESTRATOR_URL"
trust_env = "$TRUST_ENV"  # "NEONCORE_TRUST=1 " when opted in, else empty

with open(settings_file, 'r') as f:
    settings = json.load(f)

# Build hook commands with env var for orchestrator URL (+ optional trust flag)
env_prefix = f"NEONCORE_URL={orchestrator_url} {trust_env}"
reporter_cmd = f"{env_prefix}{hooks_dir}/reporter.sh"
permission_cmd = f"{env_prefix}{hooks_dir}/permission-proxy.sh"
message_cmd = f"{env_prefix}{hooks_dir}/message-reader.sh"
notification_cmd = f"{env_prefix}{hooks_dir}/notification.sh"

# Helper to clean and add a neoncore hook entry
def is_neoncore(h):
    s = str(h).lower()
    return 'neoncore' in s or 'reporter.sh' in s or 'permission-proxy.sh' in s or 'message-reader.sh' in s or 'notification.sh' in s

hooks = settings.get('hooks', {})

# PostToolUse → reporter (tool activity + intermediate assistant messages)
post_hooks = [h for h in hooks.get('PostToolUse', []) if not is_neoncore(h)]
post_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": reporter_cmd}]
})
hooks['PostToolUse'] = post_hooks

# PreToolUse → permission proxy (permissions, AskUser, PlanMode)
pre_hooks = [h for h in hooks.get('PreToolUse', []) if not is_neoncore(h)]
pre_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": permission_cmd}]
})
hooks['PreToolUse'] = pre_hooks

# Stop → reporter (final assistant turn + token usage, via transcript parse)
stop_hooks = [h for h in hooks.get('Stop', []) if not is_neoncore(h)]
stop_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": reporter_cmd}]
})
hooks['Stop'] = stop_hooks

# Notification → notification handler
notif_hooks = [h for h in hooks.get('Notification', []) if not is_neoncore(h)]
notif_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": notification_cmd}]
})
hooks['Notification'] = notif_hooks

# SubagentStop → reporter (reuse same script — logs generically by hook_event_name)
subagent_hooks = [h for h in hooks.get('SubagentStop', []) if not is_neoncore(h)]
subagent_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": reporter_cmd}]
})
hooks['SubagentStop'] = subagent_hooks

# UserPromptSubmit → reporter (captures user prompt immediately)
prompt_hooks = [h for h in hooks.get('UserPromptSubmit', []) if not is_neoncore(h)]
prompt_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": reporter_cmd}]
})
hooks['UserPromptSubmit'] = prompt_hooks

settings['hooks'] = hooks

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)

print("Hooks merged successfully.")
PYEOF

else
  echo "Creating new settings.json..."

  cat > "$SETTINGS_FILE" << EOF
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL ${TRUST_ENV}$HOOKS_DIR/reporter.sh"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL ${TRUST_ENV}$HOOKS_DIR/permission-proxy.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL ${TRUST_ENV}$HOOKS_DIR/reporter.sh"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL ${TRUST_ENV}$HOOKS_DIR/notification.sh"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL ${TRUST_ENV}$HOOKS_DIR/reporter.sh"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL ${TRUST_ENV}$HOOKS_DIR/reporter.sh"
          }
        ]
      }
    ]
  }
}
EOF

  echo "Settings file created."
fi

# Register the NeonCore MCP coordination server for Claude Code (project-scoped .mcp.json)
REPO_ROOT="$(cd "$HOOKS_DIR/../.." && pwd)"
MCP_SERVER_JS="$REPO_ROOT/server/dist/mcp-server.js"
/usr/bin/env python3 - "$REPO_ROOT" "$MCP_SERVER_JS" "$ORCHESTRATOR_URL" <<'PYEOF'
import json, os, sys
repo_root, mcp_server_js, url = sys.argv[1], sys.argv[2], sys.argv[3]
entry = {"command": "node", "args": [mcp_server_js],
         "env": {"NEONCORE_URL": url, "NEONCORE_AGENT_TYPE": "claude"}}
path = os.path.join(repo_root, ".mcp.json")
try:
    cfg = json.load(open(path)) if os.path.exists(path) else {}
except Exception:
    cfg = {}
servers = cfg.get("mcpServers", {})
servers["neoncore"] = entry
cfg["mcpServers"] = servers
json.dump(cfg, open(path, "w"), indent=2)
print(f"NeonCore MCP server registered (project scope): {path}")
if not os.path.exists(mcp_server_js):
    print(f"  NOTE: {mcp_server_js} not found yet — run 'npm run build' in server/.")
print("For GLOBAL registration run:  claude mcp add-json neoncore '" +
      json.dumps(entry, separators=(",", ":")) + "' --scope user")
PYEOF

echo ""
echo "Installation complete!"
echo ""
echo "Hooks installed:"
echo "  - PreToolUse      → permission-proxy.sh (permissions, AskUser, PlanMode)"
echo "  - PostToolUse     → reporter.sh (tool activity + intermediate messages)"
echo "  - Stop            → reporter.sh (final turn + token usage)"
echo "  - Notification    → notification.sh (Claude notifications)"
echo "  - SubagentStop    → reporter.sh (subagent completion)"
echo "  - UserPromptSubmit → reporter.sh (user prompts)"
echo ""
echo "To verify, check: $SETTINGS_FILE"
echo "To uninstall, remove the hook entries from $SETTINGS_FILE"
echo ""
echo "Make sure the orchestrator server is running at $ORCHESTRATOR_URL"
