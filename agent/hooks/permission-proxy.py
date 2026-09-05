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
from urllib.request import Request, urlopen

from _fleet import auth_headers

ORCHESTRATOR_URL = os.environ.get("NEONCORE_URL", "http://localhost:4040")
POLL_TIMEOUT = 120  # seconds per poll attempt
MAX_POLL_RETRIES = 5  # retry up to 5 times (total ~10 minutes for plan reviews)


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

    # Long-poll for decision (with retries so plan reviews aren't rushed)
    poll_url = f"{ORCHESTRATOR_URL}/api/permissions/poll/{request_id}?timeout={POLL_TIMEOUT * 1000}"

    for _retry in range(MAX_POLL_RETRIES):
        poll_result = get_json(poll_url, timeout=POLL_TIMEOUT + 5)

        if not poll_result:
            continue  # timeout or error — retry

        decision = poll_result.get("decision", "")
        response_str = poll_result.get("response", "")

        if decision == "allowed":
            output: dict = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "Approved via NeonCore dashboard",
                }
            }
            # For AskUserQuestion, inject answers into updatedInput
            if tool_name == "AskUserQuestion" and response_str:
                try:
                    resp = json.loads(response_str) if isinstance(response_str, str) else response_str
                    answers = normalize_ask_user_answers(resp.get("answers", {}), tool_input)

                    # Backward-compat: support single-answer payloads from older UI versions
                    if not answers and isinstance(resp.get("result"), str):
                        entries = extract_question_entries(tool_input)
                        if entries:
                            answers = {entries[0]["text"]: resp.get("result", "").strip()}

                    if answers:
                        updated = dict(tool_input)
                        updated["answers"] = answers
                        output["hookSpecificOutput"]["updatedInput"] = updated
                except Exception:
                    pass
            print(json.dumps(output))
            sys.exit(0)

        elif decision == "denied":
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "Denied via NeonCore dashboard",
                }
            }
            # For ExitPlanMode, include rejection feedback in the reason
            if tool_name == "ExitPlanMode" and response_str:
                try:
                    resp = json.loads(response_str) if isinstance(response_str, str) else response_str
                    feedback = resp.get("feedback", "")
                    if feedback:
                        output["hookSpecificOutput"]["permissionDecisionReason"] = f"Plan rejected via NeonCore dashboard: {feedback}"
                except Exception:
                    pass
            print(json.dumps(output))
            sys.exit(0)

        # else: timeout — continue retry loop

    # All retries exhausted — fall back to normal Claude Code permission behavior
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
