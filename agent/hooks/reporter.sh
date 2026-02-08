#!/usr/bin/env bash
# NeonCore Activity Reporter Hook
# Fires on PostToolUse - reports completed tool actions to the orchestrator server.
# Runs non-blocking (always exits 0) so it never interferes with Claude Code.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"

# Read hook payload from stdin
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

# Extract fields needed for agent registration
SESSION_ID=$(echo "$INPUT" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
CWD=$(echo "$INPUT" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)

# Derive repo name from cwd
REPO_NAME=$(basename "$CWD" 2>/dev/null)
MACHINE=$(hostname 2>/dev/null)

# Register/update agent (idempotent)
post_with_retry "$ORCHESTRATOR_URL/api/agents/register" "{
  \"sessionId\": \"$SESSION_ID\",
  \"machine\": \"$MACHINE\",
  \"repoPath\": \"$CWD\",
  \"repoName\": \"$REPO_NAME\"
}" &

# Log the activity
ACTIVITY_BODY=$(echo "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os
d = json.load(sys.stdin)
session_id = d.get('session_id', '')
tool_name = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
tool_result = d.get('tool_result', {})
cwd = d.get('cwd', '')
hook_event = d.get('hook_event_name', '')
machine = os.uname().nodename
# Truncate tool_result for large outputs
result_str = json.dumps(tool_result) if isinstance(tool_result, dict) else str(tool_result)
if len(result_str) > 8000:
    tool_result = {'result': result_str[:8000] + '...truncated'}
print(json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'eventType': hook_event,
    'toolName': tool_name,
    'toolInput': tool_input,
    'toolResult': tool_result
}))
" 2>/dev/null)
post_with_retry "$ORCHESTRATOR_URL/api/activity" "$ACTIVITY_BODY" &

# Always exit 0 - never block Claude Code
exit 0
