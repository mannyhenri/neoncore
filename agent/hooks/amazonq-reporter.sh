#!/usr/bin/env bash
# NeonCore Activity Reporter Hook — Amazon Q Developer CLI variant
# Fires on postToolUse — reports completed tool actions to the orchestrator.
#
# Setup: Add alongside amazonq-permission-proxy.sh in your agent config:
#   "postToolUse": [
#     { "matcher": "*", "command": "/path/to/neoncore/agent/hooks/amazonq-reporter.sh" }
#   ]
#
# Amazon Q CLI postToolUse payload:
#   {
#     "hook_event_name": "postToolUse",
#     "cwd": "/current/dir",
#     "tool_name": "execute_bash",
#     "tool_input": { ... },
#     "tool_response": { "success": true, "result": [...] }
#   }
#
# Always exits 0 — never blocks Amazon Q.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"

INPUT=$(cat)

post_with_retry() {
  local url="$1"
  local body="$2"
  for i in 1 2 3; do
    if curl -sf --max-time 2 -X POST "$url" -H "Content-Type: application/json" -d "$body" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

PARSED=$(printf '%s' "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os, subprocess, hashlib

d = json.load(sys.stdin)
tool_name     = d.get('tool_name', '')
tool_input    = d.get('tool_input', {})
tool_response = d.get('tool_response', {})
cwd           = d.get('cwd', '')
hook_event    = d.get('hook_event_name', 'postToolUse')
machine       = os.uname().nodename

# Resolve git root
try:
    git_root = subprocess.check_output(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=cwd, stderr=subprocess.DEVNULL
    ).decode().strip()
    cwd = git_root
    repo_name = os.path.basename(git_root)
except Exception:
    repo_name = os.path.basename(cwd) if cwd else ''

pseudo_session = 'amazonq-' + hashlib.md5((machine + cwd).encode()).hexdigest()[:12]

# Truncate large responses
result_str = json.dumps(tool_response) if isinstance(tool_response, dict) else str(tool_response)
if len(result_str) > 8000:
    tool_response = {'result': result_str[:8000] + '...truncated'}

register = json.dumps({
    'sessionId': pseudo_session,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name,
    'agentType': 'amazonq',
})

activity = json.dumps({
    'sessionId': pseudo_session,
    'machine': machine,
    'repoPath': cwd,
    'eventType': hook_event,
    'toolName': tool_name,
    'toolInput': tool_input,
    'toolResult': tool_response,
    'agentType': 'amazonq',
})

print(register)
print(activity)
" 2>/dev/null)

REGISTER_BODY=$(printf '%s\n' "$PARSED" | sed -n '1p')
ACTIVITY_BODY=$(printf '%s\n' "$PARSED" | sed -n '2p')

if [ -n "$REGISTER_BODY" ]; then
  post_with_retry "$ORCHESTRATOR_URL/api/agents/register" "$REGISTER_BODY" &
fi

if [ -n "$ACTIVITY_BODY" ]; then
  post_with_retry "$ORCHESTRATOR_URL/api/activity" "$ACTIVITY_BODY"
fi

exit 0
