#!/usr/bin/env bash
# NeonCore Permission Proxy Hook — Cursor variant
# Fires on beforeShellExecution and beforeMCPExecution.
#
# Setup: Add to {project}/.cursor/hooks.json or ~/.cursor/hooks.json:
#   {
#     "version": 1,
#     "hooks": {
#       "beforeShellExecution": [
#         { "command": "/path/to/neoncore/agent/hooks/cursor-permission-proxy.sh" }
#       ],
#       "beforeMCPExecution": [
#         { "command": "/path/to/neoncore/agent/hooks/cursor-permission-proxy.sh" }
#       ]
#     }
#   }
#
# Cursor blocking protocol (stdout JSON):
#   Allow:  { "continue": true,  "permission": "allow" }
#   Block:  { "continue": false, "permission": "deny",  "agentMessage": "reason" }
#   Ask:    { "continue": true,  "permission": "ask",   "userMessage": "reason" }
#
# beforeShellExecution payload:
#   { "hook_event_name": "beforeShellExecution", "conversation_id": "...", "generation_id": "...",
#     "command": "git status", "cwd": "/project", "workspace_roots": ["/project"] }
#
# beforeMCPExecution payload:
#   { "hook_event_name": "beforeMCPExecution", "conversation_id": "...", "generation_id": "...",
#     "server": "my-server", "tool_name": "query_db", "tool_input": "{\"sql\":\"...\"}",
#     "command": "npx my-mcp-server", "workspace_roots": ["/project"] }
#
# Note: Cursor does not provide a session_id — NeonCore uses conversation_id as the session.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"
POLL_TIMEOUT=120
MAX_POLL_RETRIES=5

INPUT=$(cat)

PARSED=$(printf '%s' "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os, subprocess

d = json.load(sys.stdin)
hook_event      = d.get('hook_event_name', '')
conversation_id = d.get('conversation_id', '')
cwd             = d.get('cwd', '') or (d.get('workspace_roots') or [''])[0]
machine         = os.uname().nodename

# Extract tool info depending on event type
if hook_event == 'beforeShellExecution':
    tool_name  = 'Shell'
    cmd        = d.get('command', '')
    tool_input = {'command': cmd}
    desc       = 'Shell: ' + cmd[:120]
elif hook_event == 'beforeMCPExecution':
    server     = d.get('server', '')
    mcp_tool   = d.get('tool_name', '')
    tool_name  = '@' + server + '/' + mcp_tool if server else mcp_tool
    # tool_input in Cursor is an escaped JSON string, not a dict
    raw_input  = d.get('tool_input', '{}')
    try:
        tool_input = json.loads(raw_input) if isinstance(raw_input, str) else raw_input
    except Exception:
        tool_input = {'raw': str(raw_input)}
    desc = 'MCP ' + server + ': ' + mcp_tool
else:
    tool_name  = hook_event
    tool_input = {}
    desc       = hook_event

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

# Use conversation_id as session for Cursor
session_id = 'cursor-' + conversation_id if conversation_id else 'cursor-unknown'

register_body = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name,
    'agentType': 'cursor',
    'status': 'working',
})
permission_body = json.dumps({
    'sessionId': session_id,
    'toolName': tool_name,
    'toolInput': tool_input,
    'description': desc,
    'agentType': 'cursor',
})

print(register_body)
print(permission_body)
print(session_id)
print(json.dumps(tool_name))
" 2>/dev/null)

if [ -z "$PARSED" ]; then
  # Cursor: exit 0 + allow JSON = proceed
  echo '{"continue":true,"permission":"allow"}'
  exit 0
fi

REGISTER_BODY=$(printf '%s\n' "$PARSED" | sed -n '1p')
PERMISSION_BODY=$(printf '%s\n' "$PARSED" | sed -n '2p')
SESSION_ID=$(printf '%s\n' "$PARSED" | sed -n '3p')

# Register agent (fire-and-forget)
curl -sf -X POST "$ORCHESTRATOR_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY" >/dev/null 2>&1 &

# Request permission from orchestrator
RESPONSE=$(curl -sf -X POST "$ORCHESTRATOR_URL/api/permissions/request" \
  -H "Content-Type: application/json" \
  -d "$PERMISSION_BODY" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo '{"continue":true,"permission":"allow"}'
  exit 0
fi

# Trust mode → immediate allow
TRUST_MODE=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('trustMode', False))
" 2>/dev/null)

if [ "$TRUST_MODE" = "True" ]; then
  echo '{"continue":true,"permission":"allow","agentMessage":"Auto-approved by NeonCore trust mode"}'
  exit 0
fi

# Extract permission request ID
REQUEST_ID=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('id',''))
" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  echo '{"continue":true,"permission":"allow"}'
  exit 0
fi

# Long-poll for decision
RETRY=0
while [ $RETRY -lt $MAX_POLL_RETRIES ]; do
  POLL_RESULT=$(curl -sf --max-time $POLL_TIMEOUT \
    "$ORCHESTRATOR_URL/api/permissions/poll/$REQUEST_ID?timeout=$((POLL_TIMEOUT * 1000))" 2>/dev/null)

  if [ -z "$POLL_RESULT" ]; then
    RETRY=$((RETRY + 1))
    continue
  fi

  HOOK_OUTPUT=$(printf '%s' "$POLL_RESULT" | /usr/bin/env python3 -c "
import sys, json
poll = json.load(sys.stdin)
decision = poll.get('decision', '')
response_str = poll.get('response', '')

if decision == 'allowed':
    print(json.dumps({
        'continue': True,
        'permission': 'allow',
        'agentMessage': 'Approved via NeonCore dashboard'
    }))
elif decision == 'denied':
    reason = 'Denied via NeonCore dashboard'
    if response_str:
        try:
            resp = json.loads(response_str) if isinstance(response_str, str) else response_str
            feedback = resp.get('feedback', '')
            if feedback:
                reason = 'Denied via NeonCore: ' + feedback
        except Exception:
            pass
    print(json.dumps({
        'continue': False,
        'permission': 'deny',
        'agentMessage': reason,
        'userMessage': reason
    }))
" 2>/dev/null)

  if [ -n "$HOOK_OUTPUT" ]; then
    printf '%s\n' "$HOOK_OUTPUT"
    exit 0
  fi

  RETRY=$((RETRY + 1))
done

# Timeout — allow
echo '{"continue":true,"permission":"allow"}'
exit 0
