#!/usr/bin/env python3
"""NeonCore Activity + Transcript Reporter — OpenAI Codex CLI variant.

Fires on PostToolUse, Stop, UserPromptSubmit and SessionEnd. Reports activity AND ships
transcript events (tool calls + results, assistant turn messages, user prompts)
so the mobile/dashboard feed renders Codex sessions the same way it renders
Claude — including long-press-to-copy on mobile.

Why this is structured differently from the Claude reporter (reporter.py):
Claude parses a local JSONL transcript and keys each event on its line index,
which makes ingestion idempotent for free. Codex hook payloads instead carry
the data inline (tool_name/tool_input/tool_response, last_assistant_message,
prompt), and there is no line-indexed transcript to key on. So we mint our own
monotonic `seq` from a per-session counter, guarded by a lockfile so a final
PostToolUse racing the Stop hook can never collide on a seq (a collision would
make the server's INSERT OR IGNORE silently drop an event).

Known gaps, deliberately left as follow-ups (see PR notes):
  - Per-turn token usage: Codex hooks don't carry usage, so cost meters read 0
    for Codex until we parse the rollout or read it off `codex exec --json`.
  - Assistant prose emitted *between* tool calls: only the final turn message
    arrives (via Stop's last_assistant_message); mid-turn narration is missed.

Always exits 0 — never blocks Codex.
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

# Size caps, mirroring reporter.py so Codex rows can't bloat the DB either.
BLOCK_CAP = 8000        # per text / tool_result block
TOOL_INPUT_CAP = 4000   # per tool_use input (serialized)


def post_json(url: str, body: str, retries: int = 3, timeout: int = 5) -> bool:
    """POST JSON with retry. Returns True on the first success."""
    data = body.encode()
    for _ in range(retries):
        try:
            req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
            urlopen(req, timeout=timeout)
            return True
        except Exception:
            time.sleep(1)
    return False


# ── seq allocation ──────────────────────────────────────────────────────────

def _seq_file(session_id: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"neoncore-codex-seq-{session_id}")


def reserve_seqs(session_id: str, count: int) -> int:
    """Reserve `count` consecutive seq numbers and return the first (1-based).

    Guarded by an exclusive lockfile: concurrent hooks (a turn's last
    PostToolUse landing at the same instant as Stop) must not hand out the same
    seq, or the server would INSERT OR IGNORE the second event away. If the lock
    can't be acquired within ~2s (stale lock from a crashed hook), we proceed
    best-effort rather than deadlock the agent.
    """
    if count <= 0:
        return 0

    path = _seq_file(session_id)
    lock = path + ".lock"
    acquired = False
    for _ in range(40):  # ~2s at 50ms/iteration
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

def build_events(hook_event: str, d: dict) -> list:
    """Turn one Codex hook payload into transcript event dicts (no seq yet).

    Blocks match the shape mobile's parseBlocks() already renders:
    text | tool_use | tool_result.
    """
    if hook_event == "UserPromptSubmit":
        prompt = d.get("prompt") or d.get("user_prompt") or ""
        if isinstance(prompt, str) and prompt.strip():
            return [{"role": "user", "content": [{"type": "text", "text": prompt[:BLOCK_CAP]}]}]
        return []

    if hook_event == "Stop":
        msg = d.get("last_assistant_message") or ""
        if isinstance(msg, str) and msg.strip():
            return [{"role": "assistant", "content": [{"type": "text", "text": msg[:BLOCK_CAP]}]}]
        return []

    # Default: PostToolUse — emit the call and its result as one assistant card.
    tool_name = d.get("tool_name", "")
    if not tool_name:
        return []
    tool_input = d.get("tool_input", {})
    tool_response = d.get("tool_response", d.get("tool_result", {}))
    tool_use_id = d.get("tool_use_id", "")

    inp_s = (tool_input if isinstance(tool_input, str) else json.dumps(tool_input))[:TOOL_INPUT_CAP]
    resp = tool_response if isinstance(tool_response, str) else json.dumps(tool_response)
    resp = (resp or "")[:BLOCK_CAP]

    return [{
        "role": "assistant",
        "content": [
            {"type": "tool_use", "name": tool_name, "id": tool_use_id, "input": inp_s},
            {"type": "tool_result", "tool_use_id": tool_use_id, "content": resp},
        ],
    }]


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        return

    session_id = d.get("session_id", "")
    cwd = d.get("cwd", "")
    hook_event = d.get("hook_event_name", "PostToolUse")
    model = d.get("model", "")
    machine = platform.node()

    # Resolve the git root so this session maps to the same agent the other
    # hooks register (they do the same rev-parse dance).
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

    # SessionEnd = the session is really gone (quit, Ctrl-C, /exit). Report the death and
    # STOP — this must return BEFORE the register below, which unconditionally marks the
    # agent alive and would otherwise resurrect the very session that just exited.
    #
    # Codex fires this itself (the CLI flushes the transcript tail first), which is the
    # only honest death signal available: `Stop` fires at the end of every turn, so it can
    # never mean "dead". Without this the server had to wait out a timeout, and a codex
    # cartridge closed hours ago sat in the grid looking live.
    if hook_event == "SessionEnd":
        post_json(f"{ORCHESTRATOR_URL}/api/agents/session-end", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            # Required: a repo often has both a claude and a codex cartridge, and without
            # this the server can resolve the wrong one and end the other engine's session.
            "agentType": "codex",
            "reason": d.get("reason", ""),
        }))
        return

    # Register first so /transcript can resolve the agent by (session, machine, repo).
    if session_id:
        post_json(f"{ORCHESTRATOR_URL}/api/agents/register", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "repoName": repo_name,
            "agentType": "codex",
        }))

    # Preserve the existing activity feed for tool actions.
    if hook_event == "PostToolUse" and d.get("tool_name"):
        post_json(f"{ORCHESTRATOR_URL}/api/activity", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "eventType": hook_event,
            "toolName": d.get("tool_name", ""),
            "toolInput": d.get("tool_input", {}),
            "toolResult": d.get("tool_response", d.get("tool_result", {})),
            "agentType": "codex",
        }))

    # Ship transcript events — this is what makes the message feed render.
    raw_events = build_events(hook_event, d)
    if raw_events and session_id:
        start = reserve_seqs(session_id, len(raw_events))
        for i, ev in enumerate(raw_events):
            ev["seq"] = start + i
            if model:
                ev["model"] = model
        post_json(f"{ORCHESTRATOR_URL}/api/agents/transcript", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "engine": "codex",
            "triggeredBy": hook_event,
            "events": raw_events,
        }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
