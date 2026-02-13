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
from urllib.request import Request, urlopen
from urllib.error import URLError

ORCHESTRATOR_URL = os.environ.get("NEONCORE_URL", "http://localhost:4040")
POLL_TIMEOUT = 60  # seconds


def post_json(url: str, body: str, timeout: int = 5) -> dict | None:
    """POST JSON and return parsed response."""
    try:
        req = Request(url, data=body.encode(), headers={"Content-Type": "application/json"}, method="POST")
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

    # Register agent
    register_body = json.dumps({
        "sessionId": session_id,
        "machine": machine,
        "repoPath": cwd,
        "repoName": repo_name,
    })
    post_json(f"{ORCHESTRATOR_URL}/api/agents/register", register_body)

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
    permission_body = json.dumps({
        "sessionId": session_id,
        "toolName": tool_name,
        "toolInput": tool_input,
        "description": desc,
    })
    response = post_json(f"{ORCHESTRATOR_URL}/api/permissions/request", permission_body)

    if not response:
        # Orchestrator unreachable - fall back to normal behavior
        sys.exit(0)

    # Check if trust mode gave immediate approval
    # ExitPlanMode always goes through the permission flow — plans should be human-reviewed
    trust_mode = response.get("trustMode", False)
    if trust_mode and tool_name != "ExitPlanMode":
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

    # Long-poll for decision
    poll_url = f"{ORCHESTRATOR_URL}/api/permissions/poll/{request_id}?timeout={POLL_TIMEOUT * 1000}"
    poll_result = get_json(poll_url, timeout=POLL_TIMEOUT + 5)

    if poll_result:
        decision = poll_result.get("decision", "")
        if decision == "allowed":
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "Approved via NeonCore dashboard",
                }
            }))
            sys.exit(0)
        elif decision == "denied":
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "Denied via NeonCore dashboard",
                }
            }))
            sys.exit(0)

    # Timeout or error - fall back to normal behavior
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
