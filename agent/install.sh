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

hooks = settings.get('hooks', {})

# Add PostToolUse hook (reporter)
post_hooks = hooks.get('PostToolUse', [])
# Remove existing neoncore hooks
post_hooks = [h for h in post_hooks if 'neoncore' not in str(h).lower() and 'reporter.sh' not in str(h)]
post_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": reporter_cmd}]
})
hooks['PostToolUse'] = post_hooks

# Add PreToolUse hook (permission proxy)
pre_hooks = hooks.get('PreToolUse', [])
pre_hooks = [h for h in pre_hooks if 'neoncore' not in str(h).lower() and 'permission-proxy.sh' not in str(h)]
pre_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": permission_cmd}]
})
hooks['PreToolUse'] = pre_hooks

# Add Stop hook (message reader - captures Claude's responses)
stop_hooks = hooks.get('Stop', [])
stop_hooks = [h for h in stop_hooks if 'neoncore' not in str(h).lower() and 'message-reader.sh' not in str(h)]
stop_hooks.append({
    "matcher": "",
    "hooks": [{"type": "command", "command": message_cmd}]
})
hooks['Stop'] = stop_hooks

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
    ]
  }
}
EOF

  echo "Settings file created."
fi

echo ""
echo "Installation complete!"
echo ""
echo "To verify, check: $SETTINGS_FILE"
echo "To uninstall, remove the hook entries from $SETTINGS_FILE"
echo ""
echo "Make sure the orchestrator server is running at $ORCHESTRATOR_URL"
