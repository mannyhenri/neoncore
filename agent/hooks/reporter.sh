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

# Extract fields from the JSON payload
SESSION_ID=$(echo "$INPUT" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
TOOL_NAME=$(echo "$INPUT" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('tool_input',{})))" 2>/dev/null)
CWD=$(echo "$INPUT" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)
HOOK_EVENT=$(echo "$INPUT" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hook_event_name',''))" 2>/dev/null)

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
post_with_retry "$ORCHESTRATOR_URL/api/activity" "{
  \"sessionId\": \"$SESSION_ID\",
  \"machine\": \"$MACHINE\",
  \"repoPath\": \"$CWD\",
  \"eventType\": \"$HOOK_EVENT\",
  \"toolName\": \"$TOOL_NAME\",
  \"toolInput\": $TOOL_INPUT
}" &

# Always exit 0 - never block Claude Code
exit 0
