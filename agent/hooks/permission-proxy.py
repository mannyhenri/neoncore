#!/usr/bin/env python3
"""NeonCore Permission Proxy Hook (cross-platform).

Fires on PreToolUse - intercepts permission requests and queries the orchestrator.

Flow:
  1. POST tool info to orchestrator
  2. If trust mode ON → orchestrator returns immediate allow
  3. If trust mode OFF → long-poll orchestrator until user decides on dashboard
  4. Return permission decision JSON to Claude Code
  5. On error/timeout → exit 0 (fall back to normal Claude Code behavior)
"""

import sys
import json
import os
import platform
import subprocess
import time
from urllib.request import Request, urlopen

from _fleet import auth_headers

ORCHESTRATOR_URL = os.environ.get("NEONCORE_URL", "http://localhost:4040")
POLL_TIMEOUT = 120  # seconds per long-poll window
# Claude Code kills this hook at the timeout install.py registers for it (3600s). The wait ends
# well before that so the give-up path still runs: with the old 120s x 5 retries the hook was
# killed at Claude Code's 600s default, the terminal menu took over, and an answer given from
# the dashboard after that was silently lost.
WAIT_SECONDS = int(os.environ.get("NEONCORE_PERMISSION_WAIT", "3300"))
ERROR_BACKOFF = 5     # seconds between polls when the server is unreachable
MAX_POLL_ERRORS = 12  # ~1 minute of consecutive failures: nobody can answer from the app

# Tools whose terminal dialog a bare `allow` does NOT dismiss. Claude Code's hooks reference:
# "`allow` skips the permission prompt, except ... for `AskUserQuestion` and `ExitPlanMode`,
# which need `updatedInput` paired with it." Approving one of these in NeonCore without
# updatedInput left the dialog up, so the human approved twice and the app's choices were lost.
INTERACTIVE_TOOLS = ("AskUserQuestion", "ExitPlanMode")


def post_json(url: str, body: str, timeout: int = 5) -> dict | None:
    """POST JSON and return parsed response."""
    try:
        req = Request(url, data=body.encode(), headers={"Content-Type": "application/json", **auth_headers()}, method="POST")
        resp = urlopen(req, timeout=timeout)
        return json.loads(resp.read())
    except Exception:
        return None


def get_json(url: str, timeout: int = 60) -> dict | None:
    """GET and return parsed response."""
    try:
        req = Request(url)
        resp = urlopen(req, timeout=timeout)
        return json.loads(resp.read())
    except Exception:
        return None


def get_machine_name() -> str:
    return platform.node()


def read_latest_plan(max_chars: int = 8000) -> str:
    """Read the most recently modified .md file from ~/.claude/plans/."""
    plans_dir = os.path.expanduser("~/.claude/plans")
    if not os.path.isdir(plans_dir):
        return ""

    md_files = []
    for f in os.listdir(plans_dir):
        if f.endswith(".md"):
            full_path = os.path.join(plans_dir, f)
            md_files.append((os.path.getmtime(full_path), full_path))

    if not md_files:
        return ""

    md_files.sort(reverse=True)
    latest_path = md_files[0][1]

    try:
        with open(latest_path, "r", encoding="utf-8") as fh:
            content = fh.read(max_chars)
            if len(content) == max_chars:
                content += "\n\n... (truncated)"
            return content
    except Exception:
        return ""


def extract_question_entries(tool_input: dict) -> list[dict]:
    """Extract AskUserQuestion entries with stable text + id + index."""
    entries: list[dict] = []
    raw_questions = tool_input.get("questions")

    if isinstance(raw_questions, list):
        for idx, raw in enumerate(raw_questions):
            if not isinstance(raw, dict):
                continue
            question_text = str(raw.get("question", "")).strip()
            if not question_text:
                question_text = str(raw.get("prompt", "")).strip()
            if not question_text:
                continue
            entries.append({
                "index": idx,
                "id": str(raw.get("id", "")).strip(),
                "text": question_text,
            })
    else:
        question_text = str(tool_input.get("question", "")).strip()
        if not question_text:
            question_text = str(tool_input.get("prompt", "")).strip()
        if question_text:
            entries.append({
                "index": 0,
                "id": str(tool_input.get("id", "")).strip(),
                "text": question_text,
            })

    return entries


def stringify_answer_value(value: object) -> str:
    """Coerce dashboard answer payloads into AskUserQuestion string values."""
    if isinstance(value, list):
        items = [str(v).strip() for v in value if str(v).strip()]
        return ", ".join(items)
    if value is None:
        return ""
    return str(value).strip()


def normalize_ask_user_answers(answers: object, tool_input: dict) -> dict[str, str]:
    """Map response answers to AskUserQuestion's expected key: exact question text."""
    if not isinstance(answers, dict):
        return {}

    entries = extract_question_entries(tool_input)
    normalized: dict[str, str] = {}

    for raw_key, raw_value in answers.items():
        value = stringify_answer_value(raw_value)
        if not value:
            continue

        key = str(raw_key).strip()
        question_text = ""

        if key.isdigit():
            idx = int(key)
            for entry in entries:
                if entry["index"] == idx:
                    question_text = entry["text"]
                    break
        else:
            for entry in entries:
                if entry["id"] and entry["id"] == key:
                    question_text = entry["text"]
                    break
            if not question_text:
                for entry in entries:
                    if entry["text"] == key:
                        question_text = entry["text"]
                        break

        if not question_text:
            if len(entries) == 1:
                question_text = entries[0]["text"]
            elif key:
                question_text = key

        if question_text:
            normalized[question_text] = value

    return normalized


def wait_for_decision(request_id: str, wait_seconds: int | None = None, get=None, post=None,
                      clock=time.monotonic, sleep=time.sleep) -> dict | None:
    """Long-poll until the dashboard decides. Returns the allowed/denied poll result, or None.

    None means fall back to the terminal: the server closed the question (expired, or answered
    in the terminal), it stayed unreachable, or the deadline passed. Only in the last two cases
    is the server told we gave up — so the app drops the question instead of offering an
    answer that would go nowhere.
    """
    get = get or get_json
    post = post or post_json
    deadline = clock() + (WAIT_SECONDS if wait_seconds is None else wait_seconds)
    errors = 0
    while True:
        remaining = deadline - clock()
        if remaining < 1:
            break
        window = int(min(POLL_TIMEOUT, remaining))
        result = get(f"{ORCHESTRATOR_URL}/api/permissions/poll/{request_id}?timeout={window * 1000}",
                     timeout=window + 5)
        if not result:
            errors += 1
            if errors >= MAX_POLL_ERRORS:
                break
            sleep(min(ERROR_BACKOFF, max(0, deadline - clock())))
            continue
        errors = 0
        decision = result.get("decision", "")
        if decision in ("allowed", "denied"):
            return result
        if decision != "timeout":
            return None  # closed server-side; nothing left to wait for
    post(f"{ORCHESTRATOR_URL}/api/permissions/{request_id}/abandon", "{}")
    return None


def answers_from_response(resp: object, tool_input: dict) -> dict[str, str]:
    """AskUserQuestion answers from whichever shape the deciding UI sent.

    `answers` is the question cards (dashboard + mobile); `response` is the approvals inbox's
    free-text box; `result` is an older UI. The free-text forms carry one answer, which goes
    to the first question.
    """
    if not isinstance(resp, dict):
        return {}
    answers = normalize_ask_user_answers(resp.get("answers", {}), tool_input)
    if answers:
        return answers
    for key in ("response", "result"):
        text = resp.get(key)
        if isinstance(text, str) and text.strip():
            entries = extract_question_entries(tool_input)
            if entries:
                return {entries[0]["text"]: text.strip()}
    return {}


def decision_output(tool_name: str, tool_input: dict, decision: str, response_str: object) -> dict | None:
    """The PreToolUse JSON for a dashboard decision, or None for timeout/unknown (keep polling).

    Shared by permission-proxy.sh (`--decide`), so the two hooks cannot drift apart again.
    """
    try:
        resp = json.loads(response_str) if isinstance(response_str, str) and response_str else response_str
    except Exception:
        resp = None

    if decision == "allowed":
        hso: dict = {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "Approved via NeonCore dashboard",
        }
        if tool_name == "ExitPlanMode":
            # The plan unchanged — updatedInput replaces the whole input, and its presence is
            # what tells Claude Code the approval already happened.
            hso["updatedInput"] = dict(tool_input)
        elif tool_name == "AskUserQuestion":
            answers = answers_from_response(resp, tool_input)
            if answers:
                hso["updatedInput"] = {**tool_input, "answers": answers}
            # No usable answer (an empty free-text submit): a bare allow leaves the terminal
            # dialog up, which is the honest fallback — the question is still unanswered.
        return {"hookSpecificOutput": hso}

    if decision == "denied":
        reason = "Denied via NeonCore dashboard"
        if tool_name == "ExitPlanMode" and isinstance(resp, dict) and resp.get("feedback"):
            reason = f"Plan rejected via NeonCore dashboard: {resp['feedback']}"
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}

    return None


def decide_cli() -> None:
    """`permission-proxy.py --decide`: poll JSON on stdin → hook JSON on stdout (for the .sh)."""
    try:
        poll = json.load(sys.stdin)
        tool_input: dict = {}
        path = os.environ.get("NC_TOOL_INPUT_FILE", "")
        if path and os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                tool_input = json.loads(fh.read().strip() or "{}")
        out = decision_output(os.environ.get("NC_TOOL_NAME", ""), tool_input,
                              poll.get("decision", ""), poll.get("response", ""))
        if out:
            print(json.dumps(out))
    except Exception:
        pass


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = d.get("session_id", "")
    tool_name = d.get("tool_name", "")
    tool_input = d.get("tool_input", {})
    cwd = d.get("cwd", "")
    machine = get_machine_name()

    # Resolve cwd to git repo root so agent name stays consistent
    try:
        git_root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd, stderr=subprocess.DEVNULL
        ).decode().strip()
        cwd = git_root
        repo_name = os.path.basename(git_root)
    except Exception:
        repo_name = os.path.basename(cwd) if cwd else ""

    # Build description
    if tool_name == "Bash":
        desc = "Bash: " + tool_input.get("command", "")[:120]
    elif tool_name in ("Edit", "Write", "Read"):
        fp = tool_input.get("file_path", "")
        desc = f"{tool_name}: {os.path.basename(fp)}" if fp else tool_name
    elif tool_name in ("Glob", "Grep"):
        desc = f"{tool_name}: {tool_input.get('pattern', '')[:80]}"
    elif tool_name == "Task":
        desc = f"Task: {tool_input.get('description', '')[:80]}"
    else:
        desc = tool_name

    # Register agent — always mark as 'working' since a PreToolUse hook firing
    # means Claude is actively using tools.  AskUserQuestion overrides to 'waiting'.
    register_data: dict = {
        "sessionId": session_id,
        "machine": machine,
        "repoPath": cwd,
        "repoName": repo_name,
        "status": "working",
    }
    if tool_name == "AskUserQuestion":
        register_data["status"] = "waiting"
        register_data["pendingQuestion"] = json.dumps(tool_input)[:4000]
    # Per-machine opt-in: NEONCORE_TRUST=1 means new agents from this machine start in trust mode
    if os.environ.get("NEONCORE_TRUST", "").strip().lower() in ("1", "true", "yes", "on"):
        register_data["trustMode"] = True
    register_body = json.dumps(register_data)
    register_resp = post_json(f"{ORCHESTRATOR_URL}/api/agents/register", register_body)
    resolved_agent_id = register_resp.get("id", "") if register_resp else ""

    # Log AskUserQuestion / EnterPlanMode / ExitPlanMode as activity immediately
    if tool_name in ("AskUserQuestion", "EnterPlanMode", "ExitPlanMode"):
        event_type = "ask_user" if tool_name == "AskUserQuestion" else "plan_mode"

        # For ExitPlanMode, read the plan content from disk
        tool_result = {}
        if tool_name == "ExitPlanMode":
            plan_content = read_latest_plan()
            if plan_content:
                tool_result = {"planContent": plan_content}

        activity_body = json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "eventType": event_type,
            "toolName": tool_name,
            "toolInput": tool_input,
            "toolResult": tool_result,
        })
        post_json(f"{ORCHESTRATOR_URL}/api/activity", activity_body)

    # Request permission from orchestrator
    perm_data: dict = {
        "sessionId": session_id,
        "toolName": tool_name,
        "toolInput": tool_input,
        "description": desc,
    }
    if resolved_agent_id:
        perm_data["agentId"] = resolved_agent_id
    permission_body = json.dumps(perm_data)
    response = post_json(f"{ORCHESTRATOR_URL}/api/permissions/request", permission_body)

    if not response:
        # Orchestrator unreachable - fall back to normal behavior
        sys.exit(0)

    # Check if trust mode gave immediate approval
    # ExitPlanMode always goes through the permission flow — plans should be human-reviewed
    trust_mode = response.get("trustMode", False)
    if trust_mode and tool_name != "ExitPlanMode" and tool_name != "AskUserQuestion":
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Auto-approved by NeonCore trust mode",
            }
        }))
        sys.exit(0)

    # Extract permission request ID
    request_id = response.get("id", "")
    if not request_id:
        sys.exit(0)

    poll_result = wait_for_decision(request_id)
    if poll_result:
        output = decision_output(tool_name, tool_input,
                                 poll_result.get("decision", ""), poll_result.get("response", ""))
        if output:
            print(json.dumps(output))
            sys.exit(0)

    # No decision — fall back to Claude Code's own prompt in the terminal
    sys.exit(0)


if __name__ == "__main__":
    if "--decide" in sys.argv[1:]:
        decide_cli()
        sys.exit(0)
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
