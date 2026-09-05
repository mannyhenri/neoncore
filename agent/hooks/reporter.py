#!/usr/bin/env python3
"""NeonCore Activity Reporter Hook (cross-platform).

Fires on PostToolUse, Stop, SubagentStop, and UserPromptSubmit.
Reports completed tool actions to the orchestrator server and ships rich,
incremental transcript events (assistant text + thinking + tool_use,
tool_result, and per-turn token usage) parsed from the session JSONL.

The parse runs here — on the agent's machine — because transcripts are local;
the server only stores and fans out. Tracks a per-session byte offset so each
firing ships only new transcript lines. Runs non-blocking (always exits 0).
"""

import sys
import json
import os
import platform
import subprocess
import tempfile
from urllib.request import Request, urlopen

from _fleet import auth_headers

ORCHESTRATOR_URL = os.environ.get("NEONCORE_URL", "http://localhost:4040")

# Which engine these hooks report for. Every payload carries it, because a repo can
# hold a Claude cartridge and a Codex cartridge at once and the server has to tell
# them apart — an untyped payload used to resolve to whichever row was created
# first, so Claude's tool events were recorded against the Codex cartridge.
# codex-reporter.py sends "codex" for the same reason.
AGENT_TYPE = "claude"

# Size caps to avoid DB bloat (mirrors the existing tool_result truncation).
BLOCK_CAP = 8000        # per text/thinking/tool_result block
TOOL_INPUT_CAP = 4000   # per tool_use input (serialized)
EVENT_TOTAL_CAP = 16000 # per transcript event, across all blocks


def post_json(url: str, body: str, retries: int = 3) -> bool:
    """POST JSON with retry."""
    for _ in range(retries):
        try:
            req = Request(url, data=body.encode(), headers={"Content-Type": "application/json", **auth_headers()}, method="POST")
            urlopen(req, timeout=5)
            return True
        except Exception:
            import time
            time.sleep(1)
    return False


def post_json_read(url: str, body: str, timeout: int = 4):
    """POST JSON and return the decoded response, or None.

    Single attempt, short timeout, no retry: this runs on the stop path of EVERY turn.
    A slow or unreachable server must cost the agent nothing and must never be able to
    hold up (or, worse, alter) the end of a turn.
    """
    try:
        req = Request(url, data=body.encode(), headers={"Content-Type": "application/json", **auth_headers()}, method="POST")
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:
        return None


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

    # Truncate tool_result for large outputs
    result_str = json.dumps(tool_result) if isinstance(tool_result, dict) else str(tool_result)
    if len(result_str) > 8000:
        tool_result = {"result": result_str[:8000] + "...truncated"}

    # Build activity body
    activity = {
        "sessionId": session_id,
        "machine": machine,
        "repoPath": cwd,
        "agentType": AGENT_TYPE,
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

    # SessionEnd = the session is really gone (quit, /clear, logout). Report the death
    # and stop — must return BEFORE the register below, which unconditionally marks the
    # agent 'working' and would otherwise resurrect the very session that just exited.
    #
    # This is the only honest death signal a hooks-only agent has: `Stop` fires at the
    # end of every assistant turn, so it can never mean "dead". Without it the server had
    # to guess by timeout, which is what made cartridges disappear while still in use.
    if hook_event == "SessionEnd":
        post_json(f"{ORCHESTRATOR_URL}/api/agents/session-end", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "agentType": AGENT_TYPE,
            "reason": d.get("reason", ""),
        }))
        sys.exit(0)

    # Build register body — always mark 'working' since a hook firing means activity
    register = {
        "sessionId": session_id,
        "machine": machine,
        "repoPath": cwd,
        "repoName": repo_name,
        "agentType": AGENT_TYPE,
        "status": "working",
    }
    # Per-machine opt-in: NEONCORE_TRUST=1 means new agents from this machine start in trust mode
    if os.environ.get("NEONCORE_TRUST", "").strip().lower() in ("1", "true", "yes", "on"):
        register["trustMode"] = True

    # Register agent
    post_json(f"{ORCHESTRATOR_URL}/api/agents/register", json.dumps(register))

    # Skip activity logging for tools already logged by permission-proxy PreToolUse hook
    # (e.g., ExitPlanMode includes plan content, AskUserQuestion includes question details)
    if tool_name not in ("AskUserQuestion", "EnterPlanMode", "ExitPlanMode"):
        post_json(f"{ORCHESTRATOR_URL}/api/activity", json.dumps(activity))

    # Notify server that ExitPlanMode has finished executing.
    # The extension uses this to time the auto-approve of Claude's follow-up plan prompt.
    if hook_event == "PostToolUse" and tool_name == "ExitPlanMode":
        post_json(f"{ORCHESTRATOR_URL}/api/agents/plan-executed", json.dumps({
            "sessionId": session_id,
            "machine": machine,
            "repoPath": cwd,
            "agentType": AGENT_TYPE,
        }))

    # Ship new transcript events (assistant text/thinking/tool_use, tool_result,
    # and token usage). This replaces the old last-message scrape and the
    # unreliable stdin-usage path — token usage now comes from the transcript.
    if transcript_path and os.path.exists(transcript_path):
        try:
            events, new_offset, new_seq = extract_new_transcript_events(transcript_path, session_id)
            if events:
                body = {
                    "sessionId": session_id,
                    "machine": machine,
                    "repoPath": cwd,
                    "engine": "claude",
                    "triggeredBy": hook_event,
                    "events": events,
                }
                if post_json(f"{ORCHESTRATOR_URL}/api/agents/transcript", json.dumps(body)):
                    save_transcript_state(session_id, new_offset, new_seq)
            else:
                # No emittable events, but advance past skipped lines so we don't rescan.
                save_transcript_state(session_id, new_offset, new_seq)
        except Exception:
            pass

    # Work-standard gate. `Stop` only — SubagentStop is a subagent handing work back to its
    # parent, which is not the end of the task and must never be blocked (blocking it would
    # also strand the parent, which is still mid-turn).
    if hook_event == "Stop":
        check_completion(session_id, transcript_path, d.get("stop_hook_active", False))


# ── Work-standard stop gate ─────────────────────────────────────────────────
#
# See docs/WORK-STANDARD.md. On Stop, ask the server whether this agent is allowed to
# finish. If it is mid-task under the standard and has not filed a NEONCORE-DONE report,
# the server answers 'block' and we hand the reason back to Claude Code, which resumes the
# session instead of ending the turn. This is what stops "I fixed a few of the sections"
# from looking like a completed task.
#
# Fails open at every step: no transcript, no server, bad JSON, missing fields — all end
# with the turn proceeding normally.

TAIL_BYTES = 512_000       # plenty for the last few messages of any transcript
LAST_MESSAGES = 6          # tolerate narration lines between tool calls before the report

# The Stop hook can fire before the final assistant message is durable on disk. Observed:
# the message was timestamped 18:06:42 and the refusal landed at 18:06:43, having read a
# transcript that did not yet contain it — so a correctly-filed report was rejected.
#
# When no report is found we therefore re-read a few times before believing it. Only the
# ABSENT case waits: a report found on the first read returns immediately, so the common
# path costs nothing. Total worst case is under a second, which is invisible next to the
# turn that just ended, and vastly cheaper than a false refusal that makes the agent redo
# work it already finished.
REREAD_ATTEMPTS = 4
REREAD_DELAY_S = 0.25


def last_assistant_text(transcript_path: str, limit: int = LAST_MESSAGES) -> str:
    """Concatenated text of the most recent assistant messages, newest last."""
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as f:
            f.seek(max(0, size - TAIL_BYTES))
            chunk = f.read()
    except Exception:
        return ""

    messages = []
    for raw in reversed(chunk.split(b"\n")):
        if len(messages) >= limit:
            break
        line = raw.strip()
        if not line:
            continue
        try:
            entry = json.loads(line.decode("utf-8", errors="replace"))
        except Exception:
            continue  # first line of the tail is usually a partial record
        msg = entry.get("message")
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = "\n".join(b.get("text", "") for b in content
                             if isinstance(b, dict) and b.get("type") == "text")
        else:
            text = ""
        if text.strip():
            messages.append(text)

    return "\n".join(reversed(messages))


def check_completion(session_id: str, transcript_path: str, stop_hook_active: bool) -> None:
    """Ask the server whether this stop is allowed; emit a block decision if not."""
    if not session_id or not transcript_path:
        return

    # Re-read only while the report is missing — see REREAD_ATTEMPTS. The marker check here
    # is deliberately cheap and permissive: the server does the real parsing and decides
    # whether the block is valid. All this loop has to establish is that we are not looking
    # at a transcript the final message has not reached yet.
    import time
    final_text = ""
    for attempt in range(REREAD_ATTEMPTS):
        final_text = last_assistant_text(transcript_path)
        if final_text and "NEONCORE-DONE" in final_text:
            break
        if attempt < REREAD_ATTEMPTS - 1:
            time.sleep(REREAD_DELAY_S)

    if not final_text:
        return

    decision = post_json_read(f"{ORCHESTRATOR_URL}/api/agents/completion-check", json.dumps({
        "sessionId": session_id,
        "agentType": AGENT_TYPE,
        "finalText": final_text[-20000:],
        "stopHookActive": bool(stop_hook_active),
    }))

    if not isinstance(decision, dict) or decision.get("decision") != "block":
        return

    reason = decision.get("reason") or "Task is not complete under the NeonCore work standard."
    # Claude Code reads this off stdout and feeds `reason` back into the session.
    print(json.dumps({"decision": "block", "reason": reason}))


# ── Transcript parsing ──────────────────────────────────────────────────────

def _state_file(session_id: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"neoncore-tstate-{session_id}")


def load_transcript_state(session_id: str):
    """Return (byte_offset, seq) of how far we've consumed this transcript."""
    try:
        with open(_state_file(session_id), "r") as f:
            s = json.load(f)
            return int(s.get("offset", 0)), int(s.get("seq", 0))
    except Exception:
        return 0, 0


def save_transcript_state(session_id: str, offset: int, seq: int):
    try:
        with open(_state_file(session_id), "w") as f:
            json.dump({"offset": offset, "seq": seq}, f)
    except Exception:
        pass


def extract_new_transcript_events(transcript_path: str, session_id: str):
    """Read only the bytes appended since last run; return (events, new_offset, new_seq).

    seq is the absolute transcript line index, making ingestion idempotent: a
    re-sent line carries the same (session_id, seq) and the server INSERT OR
    IGNOREs it. Only complete lines (up to the last newline) are consumed.
    """
    offset, seq = load_transcript_state(session_id)

    size = os.path.getsize(transcript_path)
    if size < offset:
        # File was truncated/rotated (session id reuse) — start over.
        offset, seq = 0, 0

    with open(transcript_path, "rb") as f:
        f.seek(offset)
        chunk = f.read()

    last_nl = chunk.rfind(b"\n")
    if last_nl == -1:
        # No complete line appended yet.
        return [], offset, seq

    complete = chunk[:last_nl]
    new_offset = offset + last_nl + 1

    events = []
    for raw in complete.split(b"\n"):
        seq += 1  # advance for every line (incl. skipped) so seq == line index
        line = raw.strip()
        if not line:
            continue
        try:
            entry = json.loads(line.decode("utf-8", errors="replace"))
        except Exception:
            continue
        ev = normalize_entry(entry, seq)
        if ev:
            events.append(ev)

    return events, new_offset, seq


def normalize_entry(entry: dict, seq: int):
    """Map one transcript JSONL entry to a transcript event, or None to skip."""
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return None
    role = msg.get("role")
    if role not in ("user", "assistant"):
        return None

    blocks = normalize_blocks(msg.get("content"))
    if not blocks:
        return None

    ev = {"seq": seq, "role": role, "content": blocks}

    model = msg.get("model")
    if model:
        ev["model"] = model

    usage = msg.get("usage")
    if isinstance(usage, dict):
        ev["usage"] = {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
        }

    return ev


def normalize_blocks(content):
    """Preserve text/thinking/tool_use/tool_result blocks, capped for size."""
    if isinstance(content, str):
        text = content.strip()
        return [{"type": "text", "text": text[:BLOCK_CAP]}] if text else []

    if not isinstance(content, list):
        return []

    blocks = []
    total = 0
    for b in content:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            text = (b.get("text") or "")[:BLOCK_CAP]
            if text.strip():
                blocks.append({"type": "text", "text": text})
                total += len(text)
        elif t == "thinking":
            text = (b.get("thinking") or "")[:BLOCK_CAP]
            if text.strip():
                blocks.append({"type": "thinking", "text": text})
                total += len(text)
        elif t == "tool_use":
            inp = b.get("input", {})
            inp_s = (inp if isinstance(inp, str) else json.dumps(inp))[:TOOL_INPUT_CAP]
            blocks.append({"type": "tool_use", "name": b.get("name", ""), "id": b.get("id", ""), "input": inp_s})
            total += len(inp_s)
        elif t == "tool_result":
            c = b.get("content")
            txt = c if isinstance(c, str) else json.dumps(c)
            txt = (txt or "")[:BLOCK_CAP]
            blocks.append({"type": "tool_result", "tool_use_id": b.get("tool_use_id", ""), "content": txt})
            total += len(txt)
        if total >= EVENT_TOTAL_CAP:
            break

    return blocks


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
