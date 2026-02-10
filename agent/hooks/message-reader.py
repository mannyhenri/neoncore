#!/usr/bin/env python3
"""NeonCore Message Reader Hook (cross-platform).

Fires on Stop (when Claude finishes responding).
Reads the last assistant message from the transcript and sends it to the orchestrator.
"""

import sys
import json
import os
import platform
from urllib.request import Request, urlopen

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


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = d.get("session_id", "")
    cwd = d.get("cwd", "")
    transcript_path = d.get("transcript_path", "")
    machine = get_machine_name()

    if not transcript_path or not os.path.exists(transcript_path):
        sys.exit(0)

    # Read from end of transcript to find last assistant message
    assistant_message = ""
    try:
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
                    assistant_message = text
                    break
            except (json.JSONDecodeError, KeyError):
                continue
    except Exception as e:
        print(f"[neoncore] transcript read error: {e}", file=sys.stderr)

    if assistant_message:
        payload = json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "message": assistant_message,
        })
        post_json(f"{ORCHESTRATOR_URL}/api/agents/message", payload)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
