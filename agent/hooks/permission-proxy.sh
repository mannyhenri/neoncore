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
POLL_TIMEOUT=120  # seconds per poll attempt
MAX_POLL_RETRIES=5  # retry up to 5 times (total ~10 minutes for plan reviews)

# Read hook payload from stdin
INPUT=$(cat)

# Use python3 to parse all fields AND build the JSON payloads safely
# This avoids shell quoting issues with embedded quotes in tool inputs
PARSED=$(echo "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os, subprocess

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

machine = os.uname().nodename

# Resolve cwd to git repo root so agent name stays consistent
try:
    git_root = subprocess.check_output(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=cwd, stderr=subprocess.DEVNULL
    ).decode().strip()
    cwd = git_root
    repo_name = os.path.basename(git_root)
except Exception:
    repo_name = os.path.basename(cwd) if cwd else ''

# Output as JSON lines: register_body, permission_body, session_id, activity_body
register_data = {
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name
}
if tool_name == 'AskUserQuestion':
    register_data['status'] = 'waiting'
    register_data['pendingQuestion'] = json.dumps(tool_input)[:4000]
else:
    # Explicitly mark working so the next tool after AskUserQuestion clears 'waiting'
    register_data['status'] = 'working'
register_body = json.dumps(register_data)
permission_body = json.dumps({
    'sessionId': session_id,
    'toolName': tool_name,
    'toolInput': tool_input,
    'description': desc
})

# Activity body for tools that need immediate dashboard visibility
# (AskUserQuestion, EnterPlanMode) — logged before trust-mode early return
activity_body = ''
if tool_name in ('AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'):
    event_type = 'ask_user' if tool_name == 'AskUserQuestion' else 'plan_mode'

    # For ExitPlanMode, read the plan content from disk
    tool_result = {}
    if tool_name == 'ExitPlanMode':
        plans_dir = os.path.expanduser('~/.claude/plans')
        if os.path.isdir(plans_dir):
            md_files = []
            for f in os.listdir(plans_dir):
                if f.endswith('.md'):
                    full_path = os.path.join(plans_dir, f)
                    md_files.append((os.path.getmtime(full_path), full_path))
            if md_files:
                md_files.sort(reverse=True)
                try:
                    with open(md_files[0][1], 'r', encoding='utf-8') as fh:
                        content = fh.read(8000)
                        if len(content) == 8000:
                            content += '\n\n... (truncated)'
                        tool_result = {'planContent': content}
                except Exception:
                    pass

    activity_body = json.dumps({
        'sessionId': session_id,
        'machine': machine,
        'repoPath': cwd,
        'eventType': event_type,
        'toolName': tool_name,
        'toolInput': tool_input,
        'toolResult': tool_result
    })

# Print five lines: register JSON, permission JSON, session_id, activity_body, tool_input JSON
print(register_body)
print(permission_body)
print(session_id)
print(activity_body)
print(json.dumps(tool_input))
" 2>/dev/null)

if [ -z "$PARSED" ]; then
  exit 0
fi

REGISTER_BODY=$(echo "$PARSED" | sed -n '1p')
PERMISSION_BODY=$(echo "$PARSED" | sed -n '2p')
SESSION_ID=$(echo "$PARSED" | sed -n '3p')
ACTIVITY_BODY=$(echo "$PARSED" | sed -n '4p')
TOOL_INPUT_JSON=$(echo "$PARSED" | sed -n '5p')

# Register agent (fire-and-forget)
curl -sf -X POST "$ORCHESTRATOR_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY" >/dev/null 2>&1

# Log AskUserQuestion / EnterPlanMode / ExitPlanMode as activity immediately
# (before trust-mode early return, so dashboard always sees these events)
if [ -n "$ACTIVITY_BODY" ]; then
  curl -sf -X POST "$ORCHESTRATOR_URL/api/activity" \
    -H "Content-Type: application/json" \
    -d "$ACTIVITY_BODY" >/dev/null 2>&1 &
fi

# Request permission from orchestrator
RESPONSE=$(curl -sf -X POST "$ORCHESTRATOR_URL/api/permissions/request" \
  -H "Content-Type: application/json" \
  -d "$PERMISSION_BODY" 2>/dev/null)

if [ $? -ne 0 ]; then
  # Orchestrator unreachable - fall back to normal behavior
  exit 0
fi

# Check if trust mode gave immediate approval
# ExitPlanMode always goes through the permission flow — plans should be human-reviewed
TRUST_MODE=$(echo "$RESPONSE" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('trustMode', False))" 2>/dev/null)
TOOL_NAME=$(echo "$PARSED" | /usr/bin/env python3 -c "
import sys, json
line = sys.stdin.readline()  # skip line 1 (register body)
line = sys.stdin.readline()  # line 2 (permission body)
d = json.loads(line)
print(d.get('toolName', ''))
" 2>/dev/null)
if [ "$TRUST_MODE" = "True" ] && [ "$TOOL_NAME" != "ExitPlanMode" ] && [ "$TOOL_NAME" != "AskUserQuestion" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved by NeonCore trust mode"}}'
  exit 0
fi

# Extract permission request ID
REQUEST_ID=$(echo "$RESPONSE" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  exit 0
fi

# Long-poll for decision (with retries so plan reviews aren't rushed)
# Pass tool data via env vars so Python can safely use it (avoids shell quoting issues)
export NC_TOOL_NAME="$TOOL_NAME"
export NC_TOOL_INPUT="$TOOL_INPUT_JSON"

RETRY=0
while [ $RETRY -lt $MAX_POLL_RETRIES ]; do
  POLL_RESULT=$(curl -sf --max-time $POLL_TIMEOUT \
    "$ORCHESTRATOR_URL/api/permissions/poll/$REQUEST_ID?timeout=$((POLL_TIMEOUT * 1000))" 2>/dev/null)

  if [ -z "$POLL_RESULT" ]; then
    RETRY=$((RETRY + 1))
    continue
  fi

  # Parse decision + response and construct appropriate hook output
  HOOK_OUTPUT=$(echo "$POLL_RESULT" | /usr/bin/env python3 -c "
import sys, json, os

poll = json.load(sys.stdin)
decision = poll.get('decision', '')
response_str = poll.get('response', '')
tool_name = os.environ.get('NC_TOOL_NAME', '')
tool_input_raw = os.environ.get('NC_TOOL_INPUT', '{}')

if decision == 'allowed':
    output = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'permissionDecisionReason': 'Approved via NeonCore dashboard'
        }
    }
    # For AskUserQuestion, inject answers into updatedInput
    if tool_name == 'AskUserQuestion' and response_str:
        try:
            resp = json.loads(response_str) if isinstance(response_str, str) else response_str
            answers = resp.get('answers', {})
            if answers:
                try:
                    original_input = json.loads(tool_input_raw)
                except Exception:
                    original_input = {}
                original_input['answers'] = answers
                output['hookSpecificOutput']['updatedInput'] = original_input
        except Exception:
            pass
    print(json.dumps(output))

elif decision == 'denied':
    output = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': 'Denied via NeonCore dashboard'
        }
    }
    # For ExitPlanMode, include rejection feedback in the reason
    if tool_name == 'ExitPlanMode' and response_str:
        try:
            resp = json.loads(response_str) if isinstance(response_str, str) else response_str
            feedback = resp.get('feedback', '')
            if feedback:
                output['hookSpecificOutput']['permissionDecisionReason'] = 'Plan rejected via NeonCore dashboard: ' + feedback
        except Exception:
            pass
    print(json.dumps(output))

else:
    # timeout or unknown — print nothing, outer loop retries
    pass
" 2>/dev/null)

  if [ -n "$HOOK_OUTPUT" ]; then
    echo "$HOOK_OUTPUT"
    exit 0
  fi

  RETRY=$((RETRY + 1))
done

# All retries exhausted — fall back to normal Claude Code permission behavior
exit 0
