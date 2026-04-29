#!/usr/bin/env bash
# NeonCore Activity Reporter Hook — Gemini CLI variant
# Fires on AfterTool — reports completed tool actions to the orchestrator.
#
# Setup in ~/.gemini/settings.json (written by NeonCore installer):
#   {
#     "hooks": {
#       "AfterTool": [{ "matcher": ".*", "hooks": [{ "name": "neoncore-reporter", "type": "command", "command": "/path/to/gemini-reporter.sh" }] }]
#     }
#   }
#
# Gemini CLI AfterTool payload:
#   { "session_id": "...", "hook_event_name": "AfterTool", "cwd": "...", "tool_name": "...", "tool_input": {...}, "tool_response": {...}, "timestamp": "..." }
#
# Always exits 0 — never blocks Gemini CLI.

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
import sys, json, os, subprocess

d = json.load(sys.stdin)

# Gemini CLI AfterTool sends fields at top level; result is under 'tool_response'
tool_name     = d.get('tool_name', '')
tool_input    = d.get('tool_input', {})
tool_response = d.get('tool_response', {})
session_id    = d.get('session_id', '') or d.get('sessionId', '')
cwd           = d.get('cwd', '')
hook_event    = d.get('hook_event_name', 'AfterTool')
machine       = os.uname().nodename

# Resolve cwd to git repo root
try:
    git_root = subprocess.check_output(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=cwd, stderr=subprocess.DEVNULL
    ).decode().strip()
    cwd = git_root
    repo_name = os.path.basename(git_root)
except Exception:
    repo_name = os.path.basename(cwd) if cwd else ''

# Truncate large tool responses
result_str = json.dumps(tool_response) if isinstance(tool_response, dict) else str(tool_response)
if len(result_str) > 8000:
    tool_response = {'result': result_str[:8000] + '...truncated'}

register = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name,
    'agentType': 'gemini',
})

activity = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'eventType': hook_event,
    'toolName': tool_name,
    'toolInput': tool_input,
    'toolResult': tool_response,
    'agentType': 'gemini',
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
