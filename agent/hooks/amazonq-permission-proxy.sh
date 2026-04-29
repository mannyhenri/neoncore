#!/usr/bin/env bash

# Python interpreter shim (prefer python3, fall back to python, then py launcher).
PYTHON="${PYTHON:-$(command -v python3 || command -v python || command -v py || true)}"
[ -z "$PYTHON" ] && { echo "Error: python 3.x required (install python or set PYTHON)" >&2; exit 1; }

# NeonCore Permission Proxy Hook — Amazon Q Developer CLI variant
# Fires on preToolUse — intercepts tool calls and queries the orchestrator.
#
# Setup: Add this hook to your agent config at
#   {project}/.amazonq/cli-agents/my-agent.json  OR  ~/.aws/amazonq/cli-agents/my-agent.json
#
#   {
#     "name": "my-agent",
#     "hooks": {
#       "preToolUse": [
#         { "matcher": "*", "command": "/path/to/neoncore/agent/hooks/amazonq-permission-proxy.sh", "timeout_ms": 125000 }
#       ]
#     }
#   }
#
# Amazon Q CLI blocking protocol:
#   - Exit 0  → allow (stdout captured as context injected into the model)
#   - Exit 2  → BLOCK the tool call (stderr is shown to the LLM as the reason)
#   - Other non-zero → warning only, execution proceeds
#
# Amazon Q CLI preToolUse payload (stdin):
#   {
#     "hook_event_name": "preToolUse",
#     "cwd": "/current/dir",
#     "tool_name": "execute_bash",          # or "fs_read", "fs_write", "@mcp-server/tool"
#     "tool_input": { ... }
#   }
#
# No session_id is provided — NeonCore uses machine + repo path for agent identity.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"
POLL_TIMEOUT=120
MAX_POLL_RETRIES=5

INPUT=$(cat)

PARSED=$(printf '%s' "$INPUT" | "$PYTHON" -c "
import sys, json, os, subprocess

d = json.load(sys.stdin)
tool_name  = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
cwd        = d.get('cwd', '')
machine    = __import__('platform').node()

# Build description
if tool_name == 'execute_bash':
    cmd = str(tool_input.get('command', ''))
    desc = 'Shell: ' + cmd[:120]
elif tool_name in ('fs_read',):
    ops = tool_input.get('operations', [{}])
    path = ops[0].get('path', '') if ops else ''
    desc = 'Read: ' + path.split('/')[-1]
elif tool_name in ('fs_write',):
    ops = tool_input.get('operations', [{}])
    path = ops[0].get('path', '') if ops else ''
    desc = 'Write: ' + path.split('/')[-1]
elif tool_name.startswith('@'):
    desc = 'MCP: ' + tool_name
else:
    desc = tool_name

# Resolve git root for stable agent identity
try:
    git_root = subprocess.check_output(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=cwd, stderr=subprocess.DEVNULL
    ).decode().strip()
    cwd = git_root
    repo_name = os.path.basename(git_root)
except Exception:
    repo_name = os.path.basename(cwd) if cwd else ''

# Generate a pseudo-session-id from machine+repo (Q CLI doesn't provide one)
import hashlib
pseudo_session = 'amazonq-' + hashlib.md5((machine + cwd).encode()).hexdigest()[:12]

register_body = json.dumps({
    'sessionId': pseudo_session,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name,
    'agentType': 'amazonq',
    'status': 'working',
})
permission_body = json.dumps({
    'sessionId': pseudo_session,
    'toolName': tool_name,
    'toolInput': tool_input,
    'description': desc,
    'agentType': 'amazonq',
})

print(register_body)
print(permission_body)
print(pseudo_session)
print(json.dumps(tool_name))
" 2>/dev/null)

if [ -z "$PARSED" ]; then
  exit 0
fi

REGISTER_BODY=$(printf '%s\n' "$PARSED" | sed -n '1p')
PERMISSION_BODY=$(printf '%s\n' "$PARSED" | sed -n '2p')
SESSION_ID=$(printf '%s\n' "$PARSED" | sed -n '3p')
TOOL_NAME=$(printf '%s\n' "$PARSED" | sed -n '4p' | "$PYTHON" -c "import sys,json; print(json.load(sys.stdin))" 2>/dev/null)

# Register agent (fire-and-forget)
curl -sf -X POST "$ORCHESTRATOR_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY" >/dev/null 2>&1 &

# Request permission from orchestrator
RESPONSE=$(curl -sf -X POST "$ORCHESTRATOR_URL/api/permissions/request" \
  -H "Content-Type: application/json" \
  -d "$PERMISSION_BODY" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  exit 0
fi

# Trust mode → immediate allow
TRUST_MODE=$(printf '%s' "$RESPONSE" | "$PYTHON" -c "
import sys,json; d=json.load(sys.stdin); print(d.get('trustMode', False))
" 2>/dev/null)

if [ "$TRUST_MODE" = "True" ]; then
  # Exit 0 with no output = allow
  exit 0
fi

# Extract permission request ID
REQUEST_ID=$(printf '%s' "$RESPONSE" | "$PYTHON" -c "
import sys,json; d=json.load(sys.stdin); print(d.get('id',''))
" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
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

  DECISION=$(printf '%s' "$POLL_RESULT" | "$PYTHON" -c "
import sys, json
poll = json.load(sys.stdin)
print(poll.get('decision', ''))
" 2>/dev/null)

  if [ "$DECISION" = "allowed" ]; then
    # Exit 0 = allow
    exit 0
  elif [ "$DECISION" = "denied" ]; then
    # Exit 2 = block; reason goes to stderr (LLM sees it)
    REASON=$(printf '%s' "$POLL_RESULT" | "$PYTHON" -c "
import sys, json
poll = json.load(sys.stdin)
response_str = poll.get('response', '')
reason = 'Denied via NeonCore dashboard'
if response_str:
    try:
        resp = json.loads(response_str) if isinstance(response_str, str) else response_str
        feedback = resp.get('feedback', '')
        if feedback:
            reason = 'Denied via NeonCore: ' + feedback
    except Exception:
        pass
print(reason)
" 2>/dev/null)
    echo "$REASON" >&2
    exit 2
  fi

  RETRY=$((RETRY + 1))
done

# Timeout — allow by default
exit 0
