#!/usr/bin/env python3
"""NeonCore Notification Hook (cross-platform).

Fires on Notification events from Claude Code.
Sends the notification text to the orchestrator as activity.
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


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = d.get("session_id", "")
    cwd = d.get("cwd", "")
    machine = get_machine_name()

    # Extract notification text
    notification = d.get("notification", d.get("message", ""))
    if isinstance(notification, dict):
        notification = notification.get("text", notification.get("message", str(notification)))

    body = json.dumps({
        "sessionId": session_id,
        "machine": machine,
        "repoPath": cwd,
        "eventType": "notification",
        "toolName": "",
        "toolInput": str(notification)[:2000] if notification else "",
    })
    post_json(f"{ORCHESTRATOR_URL}/api/activity", body)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
