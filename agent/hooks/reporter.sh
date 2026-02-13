#!/usr/bin/env bash
# NeonCore Activity Reporter Hook
# Fires on PostToolUse, SubagentStop, and UserPromptSubmit.
# Reports completed tool actions to the orchestrator server.
# Also captures intermediate assistant text from the transcript (deduped).
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

# Parse all fields in a single python3 call to avoid repeated JSON parsing
PARSED=$(echo "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os, hashlib

d = json.load(sys.stdin)
session_id = d.get('session_id', '')
cwd = d.get('cwd', '')
tool_name = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
tool_result = d.get('tool_result', {})
hook_event = d.get('hook_event_name', '')
transcript_path = d.get('transcript_path', '')
machine = os.uname().nodename
repo_name = os.path.basename(cwd) if cwd else ''

# Truncate tool_result for large outputs
result_str = json.dumps(tool_result) if isinstance(tool_result, dict) else str(tool_result)
if len(result_str) > 8000:
    tool_result = {'result': result_str[:8000] + '...truncated'}

# Skip tools already logged by permission-proxy PreToolUse hook with richer data
# (e.g., ExitPlanMode includes plan content, AskUserQuestion includes question details)
if tool_name in ('AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'):
    print(json.dumps(register))
    print('')
    print('')
    sys.exit(0)

# Build activity body
activity = {
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'eventType': hook_event,
    'toolName': tool_name,
    'toolInput': tool_input,
    'toolResult': tool_result
}

# For UserPromptSubmit, override eventType so dashboard shows it as user prompt
if hook_event == 'UserPromptSubmit':
    # UserPromptSubmit puts the user's text in a top-level 'prompt' field (not tool_input)
    user_text = d.get('prompt', '')
    activity['eventType'] = 'user_prompt'
    activity['toolName'] = ''
    activity['toolInput'] = user_text[:4000] if user_text else ''

# Build register body
register = {
    'sessionId': session_id,
    'machine': machine,
    'repoPath': cwd,
    'repoName': repo_name
}

# Try to extract last assistant text from transcript for intermediate messages.
# Deduplicates using a hash file so same message isn't sent twice.
def extract_text(content):
    if isinstance(content, str) and content.strip():
        return content[:4000]
    elif isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'text':
                texts.append(block.get('text', ''))
        combined = '\n'.join(texts).strip()
        if combined:
            return combined[:4000]
    return ''

assistant_msg = None
if hook_event == 'PostToolUse' and transcript_path and os.path.exists(transcript_path):
    try:
        with open(transcript_path, 'r') as f:
            lines = f.readlines()
        for line in reversed(lines):
            try:
                entry = json.loads(line.strip())
                msg = entry.get('message', {})
                if not isinstance(msg, dict) or msg.get('role') != 'assistant':
                    continue
                text = extract_text(msg.get('content', []))
                if text:
                    # Check dedup hash
                    msg_hash = hashlib.md5(text.encode()).hexdigest()[:12]
                    hash_file = f'/tmp/neoncore-lastmsg-{session_id}'
                    last_hash = ''
                    try:
                        with open(hash_file, 'r') as hf:
                            last_hash = hf.read().strip()
                    except FileNotFoundError:
                        pass
                    if msg_hash != last_hash:
                        with open(hash_file, 'w') as hf:
                            hf.write(msg_hash)
                        assistant_msg = {
                            'sessionId': session_id,
                            'machine': machine,
                            'repoPath': cwd,
                            'message': text
                        }
                    break
            except (json.JSONDecodeError, KeyError):
                continue
    except Exception:
        pass

# Output: line 1 = register JSON, line 2 = activity JSON, line 3 = assistant message JSON (or empty)
print(json.dumps(register))
print(json.dumps(activity))
print(json.dumps(assistant_msg) if assistant_msg else '')
")

# Parse the three output lines
REGISTER_BODY=$(echo "$PARSED" | sed -n '1p')
ACTIVITY_BODY=$(echo "$PARSED" | sed -n '2p')
ASSISTANT_BODY=$(echo "$PARSED" | sed -n '3p')

# Register/update agent (fire-and-forget background)
if [ -n "$REGISTER_BODY" ]; then
  post_with_retry "$ORCHESTRATOR_URL/api/agents/register" "$REGISTER_BODY" &
fi

# Log the tool/event activity (synchronous — ensure it completes)
if [ -n "$ACTIVITY_BODY" ]; then
  post_with_retry "$ORCHESTRATOR_URL/api/activity" "$ACTIVITY_BODY"
fi

# Send intermediate assistant message if we found a new one (synchronous)
if [ -n "$ASSISTANT_BODY" ]; then
  post_with_retry "$ORCHESTRATOR_URL/api/agents/message" "$ASSISTANT_BODY"
fi

# Always exit 0 - never block Claude Code
exit 0
