#!/usr/bin/env bash

# Python interpreter shim (prefer python3, fall back to python, then py launcher).
PYTHON="${PYTHON:-$(command -v python3 || command -v python || command -v py || true)}"
[ -z "$PYTHON" ] && { echo "Error: python 3.x required (install python or set PYTHON)" >&2; exit 1; }

# NeonCore Notification Hook
# Fires on Notification events from Claude Code.
# Sends the notification text to the orchestrator as activity.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"

INPUT=$(cat)

# Retry a curl POST up to 3 times with 1s delay
post_with_retry() {
  local url="$1"
  local body="$2"
  for i in 1 2 3; do
    if curl -sf -X POST "$url" -H "Content-Type: application/json" -d "$body" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

BODY=$(echo "$INPUT" | "$PYTHON" -c "
import sys, json, os

d = json.load(sys.stdin)
session_id = d.get('session_id', '')
cwd = d.get('cwd', '')
machine = __import__('platform').node()

# Extract notification text
notification = d.get('notification', d.get('message', ''))
if isinstance(notification, dict):
    notification = notification.get('text', notification.get('message', str(notification)))

print(json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'eventType': 'notification',
    'toolName': '',
    'toolInput': str(notification)[:2000] if notification else ''
}))
")

if [ -n "$BODY" ]; then
  post_with_retry "$ORCHESTRATOR_URL/api/activity" "$BODY"
fi

exit 0
