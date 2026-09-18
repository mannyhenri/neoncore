#!/usr/bin/env bash
# NeonCore Permission Proxy Hook — OpenAI Codex CLI variant
# Fires on PreToolUse — intercepts tool calls and queries the orchestrator.
#
# SETUP:
# 1. Enable hooks feature flag in ~/.codex/config.toml:
#      [features]
#      hooks = true
#
# 2. Add to ~/.codex/hooks.json or {project}/.codex/hooks.json:
#      {
#        "hooks": {
#          "PreToolUse": [
#            {
#              "matcher": ".*",
#              "hooks": [{ "type": "command", "command": "/path/to/neoncore/agent/hooks/codex-permission-proxy.sh" }]
#            }
#          ]
#        }
#      }
#
# Codex CLI payload (very similar to Claude Code):
#   {
#     "session_id": "uuid",
#     "transcript_path": "/path/to/transcript",
#     "cwd": "/current/dir",
#     "hook_event_name": "PreToolUse",
#     "model": "codex-1",
#     "turn_id": "uuid",
#     "tool_name": "Bash",
#     "tool_use_id": "uuid",
#     "tool_input": { "command": "ls -la" }
#   }
#
# Block response (stdout JSON):
#   { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..." } }
# Allow response:
#   { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" } }
#   OR exit 0 with no output

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"
POLL_TIMEOUT=120
MAX_POLL_RETRIES=5

INPUT=$(cat)
# Async questions must execute immediately; PostToolUse publishes their form.
# Blocking native questions are published here, before the native UI can wait.
QUESTION_KIND=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_name", "").split(".")[-1])' 2>/dev/null)
if [ "$QUESTION_KIND" = "request_user_input_async" ]; then
  exit 0
fi
export NEONCORE_CODEX_HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
FLEET_TOKEN=$(PYTHONPATH="$NEONCORE_CODEX_HOOK_DIR" python3 -c 'from _fleet import fleet_token; print(fleet_token() or "")')
AUTH_ARGS=()
if [ -n "$FLEET_TOKEN" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $FLEET_TOKEN")
fi

PARSED=$(printf '%s' "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os, subprocess

d = json.load(sys.stdin)
session_id = d.get('session_id', '')
tool_name  = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
cwd        = d.get('cwd', '')
machine    = os.uname().nodename

# Build description (Codex primarily hooks Bash)
if tool_name == 'Bash':
    cmd = str(tool_input.get('command', ''))
    desc = 'Bash: ' + cmd[:120]
elif tool_name in ('Edit', 'Write', 'Read'):
    fp = tool_input.get('file_path', '')
    desc = tool_name + ': ' + (fp.split('/')[-1] if fp else tool_name)
else:
    desc = tool_name

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

register_body = json.dumps({
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name,
    'agentType': 'codex',
    'status': 'working',
})
permission_body = json.dumps({
    'sessionId': session_id,
    'toolName': tool_name,
    'toolInput': tool_input,
    'description': desc,
    'agentType': 'codex',
})

if tool_name.split('.')[-1] == 'request_user_input':
    sys.path.insert(0, os.environ['NEONCORE_CODEX_HOOK_DIR'])
    import importlib.util
    spec = importlib.util.spec_from_file_location('codex_reporter', os.path.join(os.environ['NEONCORE_CODEX_HOOK_DIR'], 'codex-reporter.py'))
    reporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reporter)
    question = reporter.question_request(d)
    if question:
        permission_body = json.dumps({**json.loads(permission_body), **question})

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
TOOL_NAME=$(printf '%s\n' "$PARSED" | sed -n '4p' | /usr/bin/env python3 -c "import sys,json; print(json.load(sys.stdin))" 2>/dev/null)

# Register agent (fire-and-forget)
curl -sf "${AUTH_ARGS[@]}" -X POST "$ORCHESTRATOR_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY" >/dev/null 2>&1

# Request permission from orchestrator
RESPONSE=$(curl -sf "${AUTH_ARGS[@]}" -X POST "$ORCHESTRATOR_URL/api/permissions/request" \
  -H "Content-Type: application/json" \
  -d "$PERMISSION_BODY" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  exit 0
fi

# Trust mode → immediate allow (same JSON response format as Claude Code)
TRUST_MODE=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('trustMode', False))
" 2>/dev/null)

if [ "$TRUST_MODE" = "True" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved by NeonCore trust mode"}}'
  exit 0
fi

# Extract permission request ID
REQUEST_ID=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "
import sys,json; d=json.load(sys.stdin); print(d.get('id',''))
" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  exit 0
fi

# Long-poll for decision
RETRY=0
while [ $RETRY -lt $MAX_POLL_RETRIES ]; do
  POLL_RESULT=$(curl -sf "${AUTH_ARGS[@]}" --max-time $POLL_TIMEOUT \
    "$ORCHESTRATOR_URL/api/permissions/poll/$REQUEST_ID?timeout=$((POLL_TIMEOUT * 1000))" 2>/dev/null)

  if [ -z "$POLL_RESULT" ]; then
    RETRY=$((RETRY + 1))
    continue
  fi

  HOOK_OUTPUT=$(printf '%s' "$POLL_RESULT" | NEONCORE_QUESTION_KIND="$QUESTION_KIND" /usr/bin/env python3 -c "
import sys, json, os
poll = json.load(sys.stdin)
decision = poll.get('decision', '')
response_str = poll.get('response', '')

if decision in ('allowed', 'denied') and os.environ.get('NEONCORE_QUESTION_KIND') == 'request_user_input':
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
        'permissionDecisionReason': 'The user answered via NeonCore. Use these answers and continue; do not ask again. Decision: ' + decision + '. Response: ' + str(response_str)
    }}))
elif decision == 'allowed':
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'permissionDecisionReason': 'Approved via NeonCore dashboard'
        }
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
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': reason
        }
    }))
" 2>/dev/null)

  if [ -n "$HOOK_OUTPUT" ]; then
    printf '%s\n' "$HOOK_OUTPUT"
    exit 0
  fi

  RETRY=$((RETRY + 1))
done

exit 0
