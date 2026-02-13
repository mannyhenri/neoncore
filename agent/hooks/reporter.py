#!/usr/bin/env python3
"""NeonCore Activity Reporter Hook (cross-platform).

Fires on PostToolUse, SubagentStop, and UserPromptSubmit.
Reports completed tool actions to the orchestrator server.
Also captures intermediate assistant text from the transcript (deduped).
Runs non-blocking (always exits 0) so it never interferes with Claude Code.
"""

import sys
import json
import os
import hashlib
import platform
import tempfile
from urllib.request import Request, urlopen
from urllib.error import URLError

ORCHESTRATOR_URL = os.environ.get("NEONCORE_URL", "http://localhost:4040")


def post_json(url: str, body: str, retries: int = 3) -> bool:
    """POST JSON with retry."""
    for _ in range(retries):
        try:
            req = Request(url, data=body.encode(), headers={"Content-Type": "application/json"}, method="POST")
            urlopen(req, timeout=5)
            return True
        except Exception:
            import time
            time.sleep(1)
    return False


def get_machine_name() -> str:
    return platform.node()


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = d.get("session_id", "")
    cwd = d.get("cwd", "")
    tool_name = d.get("tool_name", "")
    tool_input = d.get("tool_input", {})
    tool_result = d.get("tool_result", {})
    hook_event = d.get("hook_event_name", "")
    transcript_path = d.get("transcript_path", "")
    machine = get_machine_name()
    repo_name = os.path.basename(cwd) if cwd else ""

    # Truncate tool_result for large outputs
    result_str = json.dumps(tool_result) if isinstance(tool_result, dict) else str(tool_result)
    if len(result_str) > 8000:
        tool_result = {"result": result_str[:8000] + "...truncated"}

    # Build activity body
    activity = {
        "sessionId": session_id,
        "machine": machine,
        "repoPath": cwd,
        "eventType": hook_event,
        "toolName": tool_name,
        "toolInput": tool_input,
        "toolResult": tool_result,
    }

    # For UserPromptSubmit, override eventType so dashboard shows it as user prompt
    if hook_event == "UserPromptSubmit":
        user_text = d.get("prompt", "")
        activity["eventType"] = "user_prompt"
        activity["toolName"] = ""
        activity["toolInput"] = user_text[:4000] if user_text else ""

    # Build register body
    register = {
        "sessionId": session_id,
        "machine": machine,
        "repoPath": cwd,
        "repoName": repo_name,
    }

    # Register agent
    post_json(f"{ORCHESTRATOR_URL}/api/agents/register", json.dumps(register))

    # Skip tools already logged by permission-proxy PreToolUse hook with richer data
    # (e.g., ExitPlanMode includes plan content, AskUserQuestion includes question details)
    if tool_name in ("AskUserQuestion", "EnterPlanMode", "ExitPlanMode"):
        return

    # Log activity
    post_json(f"{ORCHESTRATOR_URL}/api/activity", json.dumps(activity))

    # Try to extract last assistant text from transcript (deduped)
    if hook_event == "PostToolUse" and transcript_path and os.path.exists(transcript_path):
        try:
            assistant_msg = extract_assistant_message(transcript_path, session_id, machine, cwd)
            if assistant_msg:
                post_json(f"{ORCHESTRATOR_URL}/api/agents/message", json.dumps(assistant_msg))
        except Exception:
            pass


def extract_text(content) -> str:
    if isinstance(content, str) and content.strip():
        return content[:4000]
    elif isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text", ""))
        combined = "\n".join(texts).strip()
        if combined:
            return combined[:4000]
    return ""


def extract_assistant_message(transcript_path: str, session_id: str, machine: str, cwd: str):
    with open(transcript_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    for line in reversed(lines):
        try:
            entry = json.loads(line.strip())
            msg = entry.get("message", {})
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            text = extract_text(msg.get("content", []))
            if text:
                # Dedup using hash file in temp directory
                msg_hash = hashlib.md5(text.encode()).hexdigest()[:12]
                hash_file = os.path.join(tempfile.gettempdir(), f"neoncore-lastmsg-{session_id}")
                last_hash = ""
                try:
                    with open(hash_file, "r") as hf:
                        last_hash = hf.read().strip()
                except FileNotFoundError:
                    pass
                if msg_hash != last_hash:
                    with open(hash_file, "w") as hf:
                        hf.write(msg_hash)
                    return {
                        "sessionId": session_id,
                        "machine": machine,
                        "repoPath": cwd,
                        "message": text,
                    }
                return None
        except (json.JSONDecodeError, KeyError):
            continue
    return None


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
