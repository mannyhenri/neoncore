#!/usr/bin/env python3
"""NeonCore Agent Hook Installer (cross-platform).

Works on macOS, Linux, and Windows. Installs Claude Code hooks that
connect to the NeonCore orchestrator.

Usage:
    python install.py                                           # defaults (localhost:4040)
    NEONCORE_URL=http://192.168.1.50:4040 python install.py     # custom URL
    python install.py --url http://192.168.1.50:4040            # alternative
"""

import json
import os
import sys
import time
import argparse
import platform
import tempfile


def make_output_unicode_safe() -> None:
    """Force UTF-8 on our own stdout/stderr.

    When stdout is a pipe rather than a console (e.g. setup.ps1 runs us with
    `| Out-Null`), Python falls back to the locale encoding -- cp1252 on a
    typical Windows box -- which cannot encode the arrows in the summary below.
    Printing one then raises UnicodeEncodeError and exits non-zero *after* the
    hooks are already installed, making a successful install look like a failure.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass  # not a reconfigurable text stream; nothing to do


def get_settings_path() -> str:
    """Get Claude Code settings.json path for current OS."""
    if platform.system() == "Windows":
        return os.path.join(os.environ.get("USERPROFILE", ""), ".claude", "settings.json")
    return os.path.join(os.path.expanduser("~"), ".claude", "settings.json")


def get_hooks_dir() -> str:
    """Get absolute path to hooks directory."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks")


def trust_enabled() -> bool:
    """Per-machine trust opt-in via NEONCORE_TRUST env var."""
    return os.environ.get("NEONCORE_TRUST", "").strip().lower() in ("1", "true", "yes", "on")


def repo_root() -> str:
    """NeonCore repo root (parent of the agent/ dir holding this script)."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def backups_dir() -> str:
    """Directory for timestamped config backups (sits beside settings.json)."""
    d = os.path.join(os.path.dirname(get_settings_path()), "backups")
    os.makedirs(d, exist_ok=True)
    return d


def backup_file(path):
    """Copy an existing file into ~/.claude/backups/ before we overwrite it.

    Returns the backup path, or None if there was nothing to back up.
    """
    if not os.path.exists(path):
        return None
    dest = os.path.join(backups_dir(), f"{os.path.basename(path)}.backup.{int(time.time() * 1000)}")
    with open(path, "rb") as src, open(dest, "wb") as dst:
        dst.write(src.read())
    return dest


def atomic_write_json(path, data) -> None:
    """Write JSON to `path` atomically and durably.

    Writes to a temp file in the same directory, flushes + fsyncs it to disk,
    then atomically renames it over the target. A crash or power loss leaves
    either the old file or the fully written new file -- never an empty or
    truncated one. The bare `open(path, "w")` + json.dump pattern this replaces
    truncates first and never fsyncs, so an unclean shutdown could leave a
    zero-byte settings.json and silently wipe the installed hooks.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=f".{os.path.basename(path)}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # atomic on POSIX and Windows
        if platform.system() != "Windows":
            # fsync the directory so the rename itself survives a power loss
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def build_hook_command(hooks_dir: str, script_name: str, orchestrator_url: str) -> str:
    """Build the hook command string (cross-platform)."""
    script_path = os.path.join(hooks_dir, script_name)

    # When opted in, carry NEONCORE_TRUST=1 so new agents from this machine auto-approve
    trust_prefix = "NEONCORE_TRUST=1 " if trust_enabled() else ""
    # Claude Code uses bash (incl. Git Bash on Windows), so Unix env var syntax works everywhere
    interpreter = "python" if platform.system() == "Windows" else "python3"
    return f'NEONCORE_URL={orchestrator_url} {trust_prefix}{interpreter} "{script_path}"'


def is_neoncore_hook(hook) -> bool:
    """Check if a hook entry is a NeonCore hook.

    message-reader is intentionally still listed: the hook was removed (it posted to
    /api/agents/message, an endpoint that no longer exists — reporter.py's transcript
    pipeline replaced it), but machines installed before that still carry it in their
    settings.json. Matching it here is what strips the stale entry on reinstall.
    """
    s = str(hook).lower()
    return any(keyword in s for keyword in [
        "neoncore", "reporter.sh", "permission-proxy.sh", "message-reader.sh",
        "notification.sh", "reporter.py", "permission-proxy.py",
        "message-reader.py", "notification.py",
    ])


def main():
    make_output_unicode_safe()
    parser = argparse.ArgumentParser(description="Install NeonCore agent hooks for Claude Code")
    parser.add_argument("--url", default=None, help="NeonCore orchestrator URL (default: http://localhost:4040)")
    args = parser.parse_args()

    orchestrator_url = args.url or os.environ.get("NEONCORE_URL", "http://localhost:4040")
    settings_file = get_settings_path()
    hooks_dir = get_hooks_dir()

    print("NeonCore Agent Hook Installer")
    print("=" * 30)
    print()
    print(f"  Platform:       {platform.system()} {platform.machine()}")
    print(f"  Orchestrator:   {orchestrator_url}")
    print(f"  Trust mode:     {'enabled (new agents auto-approve)' if trust_enabled() else 'disabled (manual approval)'}")
    print(f"  Settings file:  {settings_file}")
    print(f"  Hooks directory: {hooks_dir}")
    print()

    # Verify hooks exist
    required_hooks = ["reporter.py", "permission-proxy.py", "notification.py"]
    for hook in required_hooks:
        path = os.path.join(hooks_dir, hook)
        if not os.path.exists(path):
            print(f"ERROR: Hook script not found: {path}")
            sys.exit(1)

    # Make scripts executable on Unix
    if platform.system() != "Windows":
        for hook in required_hooks:
            path = os.path.join(hooks_dir, hook)
            os.chmod(path, 0o755)
        # Also make the bash scripts executable if they exist
        for sh_hook in ["reporter.sh", "permission-proxy.sh", "notification.sh"]:
            path = os.path.join(hooks_dir, sh_hook)
            if os.path.exists(path):
                os.chmod(path, 0o755)

    # Build hook commands
    reporter_cmd = build_hook_command(hooks_dir, "reporter.py", orchestrator_url)
    permission_cmd = build_hook_command(hooks_dir, "permission-proxy.py", orchestrator_url)
    notification_cmd = build_hook_command(hooks_dir, "notification.py", orchestrator_url)

    # Ensure .claude directory exists
    os.makedirs(os.path.dirname(settings_file), exist_ok=True)

    # Load or create settings, tolerating a corrupt/empty file. An unclean
    # shutdown (e.g. power outage) can leave settings.json truncated to zero
    # bytes -- exactly what wipes the hooks. If it won't parse, back it up and
    # start fresh instead of crashing the reinstall.
    settings = {}
    if os.path.exists(settings_file):
        try:
            with open(settings_file, "r", encoding="utf-8") as f:
                settings = json.load(f)
            print("Existing settings.json found. Merging hooks...")
        except (ValueError, OSError) as e:
            saved = backup_file(settings_file)
            print(f"WARNING: settings.json was unreadable ({e}).")
            print(f"         Backed up to {saved} and recreating from scratch.")
            settings = {}
    else:
        print("Creating new settings.json...")

    hooks = settings.get("hooks", {})

    def make_hook_entry(command: str) -> dict:
        return {"matcher": "", "hooks": [{"type": "command", "command": command}]}

    # PostToolUse → reporter
    hooks["PostToolUse"] = [h for h in hooks.get("PostToolUse", []) if not is_neoncore_hook(h)]
    hooks["PostToolUse"].append(make_hook_entry(reporter_cmd))

    # PreToolUse → permission proxy
    hooks["PreToolUse"] = [h for h in hooks.get("PreToolUse", []) if not is_neoncore_hook(h)]
    hooks["PreToolUse"].append(make_hook_entry(permission_cmd))

    # Stop → reporter (final assistant turn + token usage, via transcript parse)
    hooks["Stop"] = [h for h in hooks.get("Stop", []) if not is_neoncore_hook(h)]
    hooks["Stop"].append(make_hook_entry(reporter_cmd))

    # Notification → notification handler
    hooks["Notification"] = [h for h in hooks.get("Notification", []) if not is_neoncore_hook(h)]
    hooks["Notification"].append(make_hook_entry(notification_cmd))

    # SubagentStop → reporter
    hooks["SubagentStop"] = [h for h in hooks.get("SubagentStop", []) if not is_neoncore_hook(h)]
    hooks["SubagentStop"].append(make_hook_entry(reporter_cmd))

    # SessionEnd → reporter (the session actually exited — mark the cartridge offline).
    # Distinct from Stop, which fires at the end of EVERY assistant turn. Without this,
    # the server can only guess at death by timeout, which is what used to make idle
    # cartridges disappear out of the grid while their session was still open.
    hooks["SessionEnd"] = [h for h in hooks.get("SessionEnd", []) if not is_neoncore_hook(h)]
    hooks["SessionEnd"].append(make_hook_entry(reporter_cmd))

    # UserPromptSubmit → reporter
    hooks["UserPromptSubmit"] = [h for h in hooks.get("UserPromptSubmit", []) if not is_neoncore_hook(h)]
    hooks["UserPromptSubmit"].append(make_hook_entry(reporter_cmd))

    settings["hooks"] = hooks

    # Back up the current settings.json, then write the new one atomically so a
    # future power loss can't leave it truncated (which is what lost the hooks).
    backup_file(settings_file)
    atomic_write_json(settings_file, settings)

    print()
    print("Installation complete!")
    print()
    print("Hooks installed:")
    print("  - PreToolUse       → permission-proxy.py (permissions, AskUser, PlanMode)")
    print("  - PostToolUse      → reporter.py (tool activity + transcript events)")
    print("  - Stop             → reporter.py (final turn + token usage)")
    print("  - Notification     → notification.py (Claude notifications)")
    print("  - SubagentStop     → reporter.py (subagent completion)")
    print("  - SessionEnd       → reporter.py (session exited → cartridge offline)")
    print("  - UserPromptSubmit → reporter.py (user prompts)")
    print()
    print(f"To verify, check: {settings_file}")
    print("To uninstall, remove the hook entries from settings.json")
    print()
    print(f"Make sure the orchestrator server is running at {orchestrator_url}")


if __name__ == "__main__":
    main()
