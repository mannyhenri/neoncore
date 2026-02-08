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

echo "NeonCore Agent Hook Installer"
echo "=============================="
echo ""
echo "Orchestrator URL: $ORCHESTRATOR_URL"
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

with open(settings_file, 'r') as f:
    settings = json.load(f)

# Build hook commands with env var for orchestrator URL
reporter_cmd = f"NEONCORE_URL={orchestrator_url} {hooks_dir}/reporter.sh"
permission_cmd = f"NEONCORE_URL={orchestrator_url} {hooks_dir}/permission-proxy.sh"
message_cmd = f"NEONCORE_URL={orchestrator_url} {hooks_dir}/message-reader.sh"
notification_cmd = f"NEONCORE_URL={orchestrator_url} {hooks_dir}/notification.sh"

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

# Stop → message reader (final assistant message)
stop_hooks = [h for h in hooks.get('Stop', []) if not is_neoncore(h)]
stop_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": message_cmd}]
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
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL $HOOKS_DIR/reporter.sh"
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
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL $HOOKS_DIR/permission-proxy.sh"
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
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL $HOOKS_DIR/message-reader.sh"
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
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL $HOOKS_DIR/notification.sh"
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
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL $HOOKS_DIR/reporter.sh"
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
            "command": "NEONCORE_URL=$ORCHESTRATOR_URL $HOOKS_DIR/reporter.sh"
          }
        ]
      }
    ]
  }
}
EOF

  echo "Settings file created."
fi

echo ""
echo "Installation complete!"
echo ""
echo "Hooks installed:"
echo "  - PreToolUse      → permission-proxy.sh (permissions, AskUser, PlanMode)"
echo "  - PostToolUse     → reporter.sh (tool activity + intermediate messages)"
echo "  - Stop            → message-reader.sh (final assistant message)"
echo "  - Notification    → notification.sh (Claude notifications)"
echo "  - SubagentStop    → reporter.sh (subagent completion)"
echo "  - UserPromptSubmit → reporter.sh (user prompts)"
echo ""
echo "To verify, check: $SETTINGS_FILE"
echo "To uninstall, remove the hook entries from $SETTINGS_FILE"
echo ""
echo "Make sure the orchestrator server is running at $ORCHESTRATOR_URL"
