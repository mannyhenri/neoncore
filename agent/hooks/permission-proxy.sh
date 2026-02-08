#!/usr/bin/env bash
# NeonCore Permission Proxy Hook
# Fires on PreToolUse - intercepts permission requests and queries the orchestrator.
#
# Flow:
#   1. POST tool info to orchestrator
#   2. If trust mode ON → orchestrator returns immediate allow
#   3. If trust mode OFF → long-poll orchestrator until user decides on dashboard
#   4. Return permission decision JSON to Claude Code
#   5. On error/timeout → exit 0 (fall back to normal Claude Code behavior)

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"
POLL_TIMEOUT=60  # seconds to wait for user decision

# Read hook payload from stdin
INPUT=$(cat)

# Use python3 to parse all fields AND build the JSON payloads safely
# This avoids shell quoting issues with embedded quotes in tool inputs
PARSED=$(echo "$INPUT" | /usr/bin/env python3 -c "
import sys, json

d = json.load(sys.stdin)
session_id = d.get('session_id', '')
tool_name = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
cwd = d.get('cwd', '')

# Build description
if tool_name == 'Bash':
    desc = 'Bash: ' + tool_input.get('command', '')[:120]
elif tool_name in ('Edit', 'Write', 'Read'):
    fp = tool_input.get('file_path', '')
    desc = tool_name + ': ' + fp.split('/')[-1] if fp else tool_name
elif tool_name in ('Glob', 'Grep'):
    desc = tool_name + ': ' + tool_input.get('pattern', '')[:80]
elif tool_name == 'Task':
    desc = 'Task: ' + tool_input.get('description', '')[:80]
else:
    desc = tool_name

import os
repo_name = os.path.basename(cwd) if cwd else ''
machine = os.uname().nodename

# Output as JSON lines: register_body, permission_body, session_id
register_body = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name
})
permission_body = json.dumps({
    'sessionId': session_id,
    'toolName': tool_name,
    'toolInput': tool_input,
    'description': desc
})

# Print three lines: register JSON, permission JSON, session_id
print(register_body)
print(permission_body)
print(session_id)
" 2>/dev/null)

if [ -z "$PARSED" ]; then
  exit 0
fi

REGISTER_BODY=$(echo "$PARSED" | sed -n '1p')
PERMISSION_BODY=$(echo "$PARSED" | sed -n '2p')
SESSION_ID=$(echo "$PARSED" | sed -n '3p')

# Register agent (fire-and-forget)
curl -sf -X POST "$ORCHESTRATOR_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY" >/dev/null 2>&1

# Request permission from orchestrator
RESPONSE=$(curl -sf -X POST "$ORCHESTRATOR_URL/api/permissions/request" \
  -H "Content-Type: application/json" \
  -d "$PERMISSION_BODY" 2>/dev/null)

if [ $? -ne 0 ]; then
  # Orchestrator unreachable - fall back to normal behavior
  exit 0
fi

# Check if trust mode gave immediate approval
TRUST_MODE=$(echo "$RESPONSE" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('trustMode', False))" 2>/dev/null)
if [ "$TRUST_MODE" = "True" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved by NeonCore trust mode"}}'
  exit 0
fi

# Extract permission request ID
REQUEST_ID=$(echo "$RESPONSE" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  exit 0
fi

# Long-poll for decision
DECISION=$(curl -sf --max-time $POLL_TIMEOUT \
  "$ORCHESTRATOR_URL/api/permissions/poll/$REQUEST_ID?timeout=$((POLL_TIMEOUT * 1000))" 2>/dev/null \
  | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('decision',''))" 2>/dev/null)

case "$DECISION" in
  allowed)
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved via NeonCore dashboard"}}'
    exit 0
    ;;
  denied)
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied via NeonCore dashboard"}}'
    exit 0
    ;;
  *)
    # Timeout or error - fall back to normal Claude Code permission behavior
    exit 0
    ;;
esac
