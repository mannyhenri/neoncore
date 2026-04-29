#!/usr/bin/env bash
# NeonCore Message Reader Hook
# Fires on Stop (when Claude finishes responding).
# Reads the last assistant message from the transcript
# and sends it to the orchestrator.
#
# User prompts are now captured by the UserPromptSubmit hook (reporter.sh),
# so this script only handles the assistant's final message.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"

INPUT=$(cat)

# Retry a curl POST up to 3 times with 1s delay (handles server restarts)
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

# Extract the last assistant message from the transcript using python3.
# Errors go to stderr (visible in Claude Code hook logs) instead of being suppressed.
PAYLOAD=$(echo "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os

d = json.load(sys.stdin)
session_id = d.get('session_id', '')
cwd = d.get('cwd', '')
transcript_path = d.get('transcript_path', '')
machine = os.uname().nodename

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

if not transcript_path:
    sys.exit(0)

if not os.path.exists(transcript_path):
    print(f'[neoncore] transcript not found: {transcript_path}', file=sys.stderr)
    sys.exit(0)

assistant_message = ''
try:
    with open(transcript_path, 'r') as f:
        lines = f.readlines()

    # Read from end to find last assistant message with text content
    for line in reversed(lines):
        try:
            entry = json.loads(line.strip())
            msg = entry.get('message', {})
            if not isinstance(msg, dict):
                continue
            if msg.get('role') != 'assistant':
                continue
            text = extract_text(msg.get('content', []))
            if text:
                assistant_message = text
                break
        except (json.JSONDecodeError, KeyError):
            continue
except Exception as e:
    print(f'[neoncore] transcript read error: {e}', file=sys.stderr)

if assistant_message:
    print(json.dumps({
        'sessionId': session_id,
        'machine': machine,
        'repoPath': cwd,
        'message': assistant_message
    }))
")

# Send assistant message synchronously — do NOT background with &
# (backgrounded curls inside pipe subshells get killed before completing)
if [ -n "$PAYLOAD" ]; then
  post_with_retry "$ORCHESTRATOR_URL/api/agents/message" "$PAYLOAD"
fi

exit 0
