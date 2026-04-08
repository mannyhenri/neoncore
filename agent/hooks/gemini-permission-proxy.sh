#!/usr/bin/env bash
# NeonCore Permission Proxy Hook — Gemini CLI variant
# Fires on BeforeTool — intercepts permission requests and queries the orchestrator.
#
# Setup in ~/.gemini/settings.json (written by NeonCore installer):
#   {
#     "hooks": {
#       "BeforeTool": [{ "matcher": ".*", "hooks": [{ "name": "neoncore-proxy", "type": "command", "command": "/path/to/gemini-permission-proxy.sh" }] }]
#     }
#   }
#
# Gemini CLI BeforeTool payload:
#   { "session_id": "...", "hook_event_name": "BeforeTool", "cwd": "...", "tool_name": "...", "tool_input": {...}, "timestamp": "..." }
#
# Response format:
#   Allow: { "decision": "allow" }           (or exit 0 with no output)
#   Deny:  { "decision": "deny", "reason": "..." }
#
# Flow:
#   1. Parse Gemini CLI hook payload
#   2. POST tool info + register agent to orchestrator
#   3. If trust mode ON → return immediate allow
#   4. If trust mode OFF → long-poll orchestrator until user decides on dashboard
#   5. Return decision JSON to Gemini CLI
#   6. On error/timeout → exit 0 (fall back to normal Gemini CLI behavior)

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"
POLL_TIMEOUT=120
MAX_POLL_RETRIES=5

INPUT=$(cat)

PARSED=$(printf '%s' "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os, subprocess

d = json.load(sys.stdin)

# Gemini CLI BeforeTool sends fields at top level
tool_name  = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
session_id = d.get('session_id', '') or d.get('sessionId', '')
cwd        = d.get('cwd', '')

# Build a human-readable description
if tool_name in ('read_file', 'write_file', 'edit_file', 'replace_in_file'):
    fp = tool_input.get('path', '') or tool_input.get('file_path', '')
    desc = tool_name + ': ' + (fp.split('/')[-1] if fp else '')
elif tool_name in ('run_shell_command', 'execute_bash'):
    cmd = str(tool_input.get('command', ''))
    desc = 'Shell: ' + (cmd[:120] if cmd else '')
elif tool_name in ('glob', 'grep', 'search_files'):
    desc = tool_name + ': ' + str(tool_input.get('pattern', '') or tool_input.get('query', ''))[:80]
else:
    desc = tool_name

machine = os.uname().nodename

# Resolve cwd to git repo root for stable agent identity
try:
    git_root = subprocess.check_output(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=cwd, stderr=subprocess.DEVNULL
    ).decode().strip()
    cwd = git_root
    repo_name = os.path.basename(git_root)
except Exception:
    repo_name = os.path.basename(cwd) if cwd else ''

register_body = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name,
    'agentType': 'gemini',
    'status': 'working',
})
permission_body = json.dumps({
    'sessionId': session_id,
    'toolName': tool_name,
    'toolInput': tool_input,
    'description': desc,
    'agentType': 'gemini',
})

print(register_body)
print(permission_body)
print(session_id)
print(json.dumps(tool_name))
print(json.dumps(tool_input))
" 2>/dev/null)

if [ -z "$PARSED" ]; then
  exit 0
fi

REGISTER_BODY=$(printf '%s\n' "$PARSED" | sed -n '1p')
PERMISSION_BODY=$(printf '%s\n' "$PARSED" | sed -n '2p')
SESSION_ID=$(printf '%s\n' "$PARSED" | sed -n '3p')
TOOL_NAME_JSON=$(printf '%s\n' "$PARSED" | sed -n '4p')
TOOL_INPUT_JSON=$(printf '%s\n' "$PARSED" | sed -n '5p')
TOOL_NAME=$(printf '%s' "$TOOL_NAME_JSON" | /usr/bin/env python3 -c "import sys,json; print(json.load(sys.stdin))" 2>/dev/null)

# Register agent (fire-and-forget)
curl -sf -X POST "$ORCHESTRATOR_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY" >/dev/null 2>&1 &

# Request permission from orchestrator
RESPONSE=$(curl -sf -X POST "$ORCHESTRATOR_URL/api/permissions/request" \
  -H "Content-Type: application/json" \
  -d "$PERMISSION_BODY" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Orchestrator unreachable — fall back to normal Gemini CLI behavior
  exit 0
fi

# Check if trust mode gives immediate approval
TRUST_MODE=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('trustMode', False))
" 2>/dev/null)

if [ "$TRUST_MODE" = "True" ]; then
  echo '{"decision":"allow"}'
  exit 0
fi

# Extract permission request ID
REQUEST_ID=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('id',''))
" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  exit 0
fi

# Write tool input to temp file to avoid shell expansion issues
export NC_TOOL_NAME="$TOOL_NAME"
NC_TOOL_INPUT_FILE=$(mktemp /tmp/neoncore-gemini-input-XXXXXX)
printf '%s' "$TOOL_INPUT_JSON" > "$NC_TOOL_INPUT_FILE"
export NC_TOOL_INPUT_FILE

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
import sys, json, os

poll = json.load(sys.stdin)
decision = poll.get('decision', '')
response_str = poll.get('response', '')

if decision == 'allowed':
    print(json.dumps({'decision': 'allow'}))
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
    print(json.dumps({'decision': 'deny', 'reason': reason}))
" 2>/dev/null)

  if [ -n "$HOOK_OUTPUT" ]; then
    printf '%s\n' "$HOOK_OUTPUT"
    rm -f "$NC_TOOL_INPUT_FILE" 2>/dev/null
    exit 0
  fi

  RETRY=$((RETRY + 1))
done

rm -f "$NC_TOOL_INPUT_FILE" 2>/dev/null
exit 0
