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
PARSED=$(printf '%s' "$INPUT" | /usr/bin/env python3 -c "
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
# Per-machine opt-in: NEONCORE_TRUST=1 means new agents from this machine start in trust mode
if os.environ.get('NEONCORE_TRUST', '').strip().lower() in ('1', 'true', 'yes', 'on'):
    register_data['trustMode'] = True
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

REGISTER_BODY=$(printf '%s\n' "$PARSED" | sed -n '1p')
PERMISSION_BODY=$(printf '%s\n' "$PARSED" | sed -n '2p')
SESSION_ID=$(printf '%s\n' "$PARSED" | sed -n '3p')
ACTIVITY_BODY=$(printf '%s\n' "$PARSED" | sed -n '4p')
TOOL_INPUT_JSON=$(printf '%s\n' "$PARSED" | sed -n '5p')

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
TRUST_MODE=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('trustMode', False))" 2>/dev/null)
TOOL_NAME=$(printf '%s\n' "$PARSED" | /usr/bin/env python3 -c "
import sys, json
line = sys.stdin.readline()  # skip line 1 (register body)
line = sys.stdin.readline()  # line 2 (permission body)
d = json.loads(line)
print(d.get('toolName', ''))
" 2>/dev/null)
if [ "$TRUST_MODE" = "True" ] && [ "$TOOL_NAME" != "AskUserQuestion" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved by NeonCore trust mode"}}'
  exit 0
fi

# Extract permission request ID
REQUEST_ID=$(printf '%s' "$RESPONSE" | /usr/bin/env python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  exit 0
fi

# Long-poll for decision (with retries so plan reviews aren't rushed)
# Write tool input to temp file instead of env var (avoids bash $ expansion corrupting JSON)
export NC_TOOL_NAME="$TOOL_NAME"
NC_TOOL_INPUT_FILE=$(mktemp /tmp/neoncore-toolinput-XXXXXX)
printf '%s' "$TOOL_INPUT_JSON" > "$NC_TOOL_INPUT_FILE"
export NC_TOOL_INPUT_FILE

RETRY=0
while [ $RETRY -lt $MAX_POLL_RETRIES ]; do
  POLL_RESULT=$(curl -sf --max-time $POLL_TIMEOUT \
    "$ORCHESTRATOR_URL/api/permissions/poll/$REQUEST_ID?timeout=$((POLL_TIMEOUT * 1000))" 2>/dev/null)

  if [ -z "$POLL_RESULT" ]; then
    RETRY=$((RETRY + 1))
    continue
  fi

  # Parse decision + response and construct appropriate hook output
  HOOK_OUTPUT=$(printf '%s' "$POLL_RESULT" | /usr/bin/env python3 -c "
import sys, json, os, traceback, datetime

DEBUG_LOG = '/tmp/neoncore-hook-debug.log'
def debug(msg):
    try:
        with open(DEBUG_LOG, 'a') as f:
            f.write('[%s] %s\n' % (datetime.datetime.now().isoformat(), msg))
    except:
        pass

poll = json.load(sys.stdin)
decision = poll.get('decision', '')
response_str = poll.get('response', '')
tool_name = os.environ.get('NC_TOOL_NAME', '')

# Read tool input from temp file (avoids bash variable expansion issues)
tool_input_raw = '{}'
tool_input_file = os.environ.get('NC_TOOL_INPUT_FILE', '')
if tool_input_file and os.path.exists(tool_input_file):
    try:
        with open(tool_input_file, 'r') as f:
            tool_input_raw = f.read().strip() or '{}'
    except Exception as e:
        debug('Failed to read tool input file %s: %s' % (tool_input_file, e))

debug('Poll result: decision=%s tool=%s response_len=%d tool_input_len=%d' % (
    decision, tool_name, len(response_str), len(tool_input_raw)))

if decision == 'allowed':
    output = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'permissionDecisionReason': 'Approved via NeonCore dashboard'
        }
    }

    def extract_question_entries(tool_input):
        entries = []
        raw_questions = tool_input.get('questions')

        if isinstance(raw_questions, list):
            for idx, raw in enumerate(raw_questions):
                if not isinstance(raw, dict):
                    continue
                question_text = str(raw.get('question', '')).strip() or str(raw.get('prompt', '')).strip()
                if not question_text:
                    continue
                entries.append({
                    'index': idx,
                    'id': str(raw.get('id', '')).strip(),
                    'text': question_text,
                })
        else:
            question_text = str(tool_input.get('question', '')).strip() or str(tool_input.get('prompt', '')).strip()
            if question_text:
                entries.append({
                    'index': 0,
                    'id': str(tool_input.get('id', '')).strip(),
                    'text': question_text,
                })
        return entries

    def stringify_answer_value(value):
        if isinstance(value, list):
            items = [str(v).strip() for v in value if str(v).strip()]
            return ', '.join(items)
        if value is None:
            return ''
        return str(value).strip()

    def normalize_answers(answers, tool_input):
        if not isinstance(answers, dict):
            return {}
        entries = extract_question_entries(tool_input)
        normalized = {}

        for raw_key, raw_value in answers.items():
            value = stringify_answer_value(raw_value)
            if not value:
                continue

            key = str(raw_key).strip()
            question_text = ''

            if key.isdigit():
                idx = int(key)
                for entry in entries:
                    if entry['index'] == idx:
                        question_text = entry['text']
                        break
            else:
                for entry in entries:
                    if entry['id'] and entry['id'] == key:
                        question_text = entry['text']
                        break
                if not question_text:
                    for entry in entries:
                        if entry['text'] == key:
                            question_text = entry['text']
                            break

            if not question_text:
                if len(entries) == 1:
                    question_text = entries[0]['text']
                elif key:
                    question_text = key

            if question_text:
                normalized[question_text] = value

        return normalized

    # For AskUserQuestion, deny the tool and pass answers in the reason text.
    # updatedInput does NOT work for AskUserQuestion (interactive tool, not hookable).
    # Denying prevents the interactive prompt from showing; the model gets the answers
    # via permissionDecisionReason and can proceed without re-asking.
    if tool_name == 'AskUserQuestion' and response_str:
        try:
            resp = json.loads(response_str) if isinstance(response_str, str) else response_str
            debug('AskUserQuestion response parsed: keys=%s' % list(resp.keys()))

            try:
                original_input = json.loads(tool_input_raw)
                debug('Original tool input parsed OK: keys=%s' % list(original_input.keys()))
            except Exception as e:
                debug('Failed to parse tool_input_raw: %s (raw=%s)' % (e, tool_input_raw[:200]))
                original_input = {}

            answers = normalize_answers(resp.get('answers', {}), original_input)
            debug('Normalized answers: %s' % json.dumps(answers))

            # Backward-compat: support single-answer payloads from older UI versions
            if not answers and isinstance(resp.get('result'), str):
                entries = extract_question_entries(original_input)
                if entries:
                    answers = {entries[0]['text']: resp.get('result', '').strip()}
                    debug('Used backward-compat single answer: %s' % json.dumps(answers))

            if answers:
                answer_lines = []
                for question, answer in answers.items():
                    answer_lines.append('- %s: %s' % (question, answer))
                answers_text = '\n'.join(answer_lines)

                output = {
                    'hookSpecificOutput': {
                        'hookEventName': 'PreToolUse',
                        'permissionDecision': 'deny',
                        'permissionDecisionReason': (
                            'The user already answered these questions via an external dashboard (NeonCore). '
                            'Here are their answers:\n\n%s\n\n'
                            'Use these answers and continue your work. '
                            'Do NOT call AskUserQuestion again for the same questions — the user has already responded.'
                        ) % answers_text
                    }
                }
                debug('AskUserQuestion DENIED with %d answer(s) in reason text' % len(answers))
            else:
                debug('WARNING: No answers produced - allowing tool to proceed normally')
        except Exception as e:
            debug('EXCEPTION in AskUserQuestion answer injection: %s\n%s' % (e, traceback.format_exc()))

    debug('Hook output: %s' % json.dumps(output)[:500])
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
    debug('Poll returned unknown decision: %s' % decision)
    # timeout or unknown — print nothing, outer loop retries
    pass
" 2>/dev/null)

  if [ -n "$HOOK_OUTPUT" ]; then
    printf '%s\n' "$HOOK_OUTPUT"
    rm -f "$NC_TOOL_INPUT_FILE" 2>/dev/null
    exit 0
  fi

  RETRY=$((RETRY + 1))
done

# All retries exhausted — fall back to normal Claude Code permission behavior
rm -f "$NC_TOOL_INPUT_FILE" 2>/dev/null
exit 0
