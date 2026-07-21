#!/usr/bin/env python3
"""NeonCore Activity + Transcript Reporter — Google Gemini CLI variant.

Fires on AfterTool and AfterAgent. Reports activity AND ships transcript events
(tool calls + results, plus the user prompt and assistant response of each turn)
so the mobile/dashboard feed renders Gemini sessions the same way it renders
Claude and Codex — including long-press-to-copy on mobile.

Gemini hook payloads carry the data inline, so — like the Codex reporter and
unlike the Claude one — there is no line-indexed transcript to key on. seq
numbers come from a per-session counter guarded by a lockfile, so a final
AfterTool racing AfterAgent can't collide and silently drop an event.

Nice property of Gemini's hooks: AfterAgent carries BOTH `prompt` (what the user
asked) and `prompt_response` (the assistant's answer), so one event reconstructs
the whole turn's prose.

Known gaps (follow-ups): per-turn token usage isn't in the hook payload (cost
meters read 0 for Gemini); assistant prose emitted mid-turn between tool calls
isn't captured (only the turn-final prompt_response is).

Always exits 0 — never blocks Gemini.
"""

import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

ORCHESTRATOR_URL = os.environ.get("NEONCORE_URL", "http://localhost:4040")

BLOCK_CAP = 8000        # per text / tool_result block
TOOL_INPUT_CAP = 4000   # per tool_use input (serialized)


def post_json(url: str, body: str, retries: int = 3, timeout: int = 5) -> bool:
    data = body.encode()
    for _ in range(retries):
        try:
            req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
            urlopen(req, timeout=timeout)
            return True
        except Exception:
            time.sleep(1)
    return False


# ── seq allocation (lockfile-guarded, per session) ──────────────────────────

def _seq_file(session_id: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"neoncore-gemini-seq-{session_id}")


def reserve_seqs(session_id: str, count: int) -> int:
    """Reserve `count` consecutive seq numbers, return the first (1-based).

    Exclusive lockfile so concurrent hooks (a turn's last AfterTool landing at
    the same instant as AfterAgent) never hand out the same seq — a collision
    would make the server INSERT OR IGNORE the second event away. Proceeds
    best-effort if the lock can't be taken in ~2s rather than deadlock.
    """
    if count <= 0:
        return 0
    path = _seq_file(session_id)
    lock = path + ".lock"
    acquired = False
    for _ in range(40):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_RDWR)
            os.close(fd)
            acquired = True
            break
        except FileExistsError:
            time.sleep(0.05)
        except Exception:
            break
    try:
        try:
            with open(path, "r") as f:
                start = int(f.read().strip() or "0")
        except Exception:
            start = 0
        try:
            with open(path, "w") as f:
                f.write(str(start + count))
        except Exception:
            pass
        return start + 1
    finally:
        if acquired:
            try:
                os.remove(lock)
            except Exception:
                pass


# ── event building ──────────────────────────────────────────────────────────

def _tool_result_text(tool_response) -> str:
    """Pull a human-readable string out of Gemini's {llmContent, returnDisplay, error}."""
    if isinstance(tool_response, dict):
        for key in ("returnDisplay", "llmContent"):
            v = tool_response.get(key)
            if isinstance(v, str) and v.strip():
                return v[:BLOCK_CAP]
            if v not in (None, "", {}, []):
                return json.dumps(v)[:BLOCK_CAP]
        if tool_response.get("error"):
            return json.dumps(tool_response["error"])[:BLOCK_CAP]
        return json.dumps(tool_response)[:BLOCK_CAP]
    return (tool_response if isinstance(tool_response, str) else json.dumps(tool_response))[:BLOCK_CAP]


def build_events(hook_event: str, d: dict) -> list:
    """Turn one Gemini hook payload into transcript event dicts (no seq yet)."""
    if hook_event == "AfterAgent":
        events = []
        prompt = d.get("prompt") or ""
        if isinstance(prompt, str) and prompt.strip():
            events.append({"role": "user", "content": [{"type": "text", "text": prompt[:BLOCK_CAP]}]})
        resp = d.get("prompt_response") or ""
        if isinstance(resp, str) and resp.strip():
            events.append({"role": "assistant", "content": [{"type": "text", "text": resp[:BLOCK_CAP]}]})
        return events

    # Default: AfterTool — the call and its result as one assistant card.
    tool_name = d.get("tool_name", "")
    if not tool_name:
        return []
    tool_input = d.get("tool_input", {})
    inp_s = (tool_input if isinstance(tool_input, str) else json.dumps(tool_input))[:TOOL_INPUT_CAP]
    return [{
        "role": "assistant",
        "content": [
            {"type": "tool_use", "name": tool_name, "id": "", "input": inp_s},
            {"type": "tool_result", "tool_use_id": "", "content": _tool_result_text(d.get("tool_response", {}))},
        ],
    }]


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        return

    session_id = d.get("session_id", "") or d.get("sessionId", "")
    cwd = d.get("cwd", "")
    hook_event = d.get("hook_event_name", "AfterTool")
    machine = platform.node()

    repo_name = os.path.basename(cwd) if cwd else ""
    try:
        git_root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], cwd=cwd or None, stderr=subprocess.DEVNULL
        ).decode().strip()
        if git_root:
            cwd = git_root
            repo_name = os.path.basename(git_root)
    except Exception:
        pass

    if session_id:
        post_json(f"{ORCHESTRATOR_URL}/api/agents/register", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "repoName": repo_name,
            "agentType": "gemini",
        }))

    # Preserve the activity feed for tool actions.
    if hook_event == "AfterTool" and d.get("tool_name"):
        post_json(f"{ORCHESTRATOR_URL}/api/activity", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "eventType": hook_event,
            "toolName": d.get("tool_name", ""),
            "toolInput": d.get("tool_input", {}),
            "toolResult": d.get("tool_response", {}),
            "agentType": "gemini",
        }))

    raw_events = build_events(hook_event, d)
    if raw_events and session_id:
        start = reserve_seqs(session_id, len(raw_events))
        for i, ev in enumerate(raw_events):
            ev["seq"] = start + i
        post_json(f"{ORCHESTRATOR_URL}/api/agents/transcript", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "engine": "gemini",
            "triggeredBy": hook_event,
            "events": raw_events,
        }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
