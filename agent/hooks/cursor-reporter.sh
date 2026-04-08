#!/usr/bin/env bash
# NeonCore Activity Reporter Hook — Cursor variant
# Fires on afterFileEdit and stop — reports activity to the orchestrator.
#
# Setup in {project}/.cursor/hooks.json or ~/.cursor/hooks.json:
#   {
#     "version": 1,
#     "hooks": {
#       "afterFileEdit": [
#         { "command": "/path/to/neoncore/agent/hooks/cursor-reporter.sh" }
#       ],
#       "stop": [
#         { "command": "/path/to/neoncore/agent/hooks/cursor-reporter.sh" }
#       ]
#     }
#   }
#
# afterFileEdit payload:
#   { "hook_event_name": "afterFileEdit", "conversation_id": "...", "generation_id": "...",
#     "file_path": "/project/src/main.ts", "edits": [{ "old_string": "...", "new_string": "..." }],
#     "workspace_roots": ["/project"] }
#
# stop payload:
#   { "hook_event_name": "stop", "conversation_id": "...", "generation_id": "...",
#     "status": "completed", "workspace_roots": ["/project"] }
#
# Always exits 0.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"

INPUT=$(cat)

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

PARSED=$(printf '%s' "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os, subprocess

d = json.load(sys.stdin)
hook_event      = d.get('hook_event_name', '')
conversation_id = d.get('conversation_id', '')
cwd             = (d.get('workspace_roots') or [''])[0]
machine         = os.uname().nodename

# Build tool info from event type
if hook_event == 'afterFileEdit':
    file_path  = d.get('file_path', '')
    edits      = d.get('edits', [])
    tool_name  = 'Edit'
    tool_input = {'file_path': file_path, 'edit_count': len(edits)}
    tool_result = {}
elif hook_event == 'stop':
    tool_name  = 'stop'
    tool_input = {'status': d.get('status', '')}
    tool_result = {}
else:
    tool_name  = hook_event
    tool_input = {}
    tool_result = {}

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

session_id = 'cursor-' + conversation_id if conversation_id else 'cursor-unknown'

register = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name,
    'agentType': 'cursor',
})

activity = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'eventType': hook_event,
    'toolName': tool_name,
    'toolInput': tool_input,
    'toolResult': tool_result,
    'agentType': 'cursor',
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
