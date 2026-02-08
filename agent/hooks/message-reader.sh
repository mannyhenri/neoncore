#!/usr/bin/env bash
# NeonCore Message Reader Hook
# Fires on Stop (when Claude finishes responding).
# Reads the last user prompt AND last assistant message from the transcript
# and sends both to the orchestrator.

ORCHESTRATOR_URL="${NEONCORE_URL:-http://localhost:4040}"

INPUT=$(cat)

# Retry a curl POST up to 3 times with 1s delay (handles server restarts)
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

# Use python3 to read the transcript and build both POST bodies at once
PAYLOADS=$(echo "$INPUT" | /usr/bin/env python3 -c "
import sys, json, os

d = json.load(sys.stdin)
session_id = d.get('session_id', '')
cwd = d.get('cwd', '')
transcript_path = d.get('transcript_path', '')

machine = os.uname().nodename
user_prompt = ''
assistant_message = ''

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

if transcript_path and os.path.exists(transcript_path):
    try:
        with open(transcript_path, 'r') as f:
            lines = f.readlines()

        # Read from end to find last assistant message, then last user message before it
        found_assistant = False
        for line in reversed(lines):
            try:
                entry = json.loads(line.strip())
                msg = entry.get('message', {})
                if not isinstance(msg, dict):
                    continue
                role = msg.get('role', '')
                text = extract_text(msg.get('content', []))
                if not text:
                    continue

                if role == 'assistant' and not found_assistant:
                    assistant_message = text
                    found_assistant = True
                elif role == 'user' and found_assistant and not user_prompt:
                    user_prompt = text
                    break
            except (json.JSONDecodeError, KeyError):
                continue
    except Exception:
        pass

# Output two JSON lines: first for user_prompt activity, second for assistant message
if user_prompt:
    print(json.dumps({
        'type': 'user_prompt',
        'body': {
            'sessionId': session_id,
            'machine': machine,
            'repoPath': cwd,
            'eventType': 'user_prompt',
            'toolName': '',
            'toolInput': user_prompt
        }
    }))
if assistant_message:
    print(json.dumps({
        'type': 'assistant_message',
        'body': {
            'sessionId': session_id,
            'machine': machine,
            'repoPath': cwd,
            'message': assistant_message
        }
    }))
" 2>/dev/null)

if [ -z "$PAYLOADS" ]; then
  exit 0
fi

# Process each payload line
echo "$PAYLOADS" | while IFS= read -r line; do
  TYPE=$(echo "$line" | /usr/bin/env python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null)
  BODY=$(echo "$line" | /usr/bin/env python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('body',{})))" 2>/dev/null)

  if [ "$TYPE" = "user_prompt" ] && [ -n "$BODY" ]; then
    post_with_retry "$ORCHESTRATOR_URL/api/activity" "$BODY" &
  elif [ "$TYPE" = "assistant_message" ] && [ -n "$BODY" ]; then
    post_with_retry "$ORCHESTRATOR_URL/api/agents/message" "$BODY" &
  fi
done

exit 0
