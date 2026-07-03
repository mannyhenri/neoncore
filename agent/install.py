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


def install_mcp_server(orchestrator_url: str) -> None:
    """Register the NeonCore MCP server (coordination tools) for Claude Code.

    Idempotently merges a `neoncore` entry into a project-scoped `.mcp.json` at
    the repo root (Claude Code reads this when an agent works in this repo). Also
    prints the equivalent `claude mcp add-json` command for user-scope (global)
    registration across all repos.
    """
    mcp_server_js = os.path.join(repo_root(), "server", "dist", "mcp-server.js")
    entry = {
        "command": "node",
        "args": [mcp_server_js],
        "env": {
            "NEONCORE_URL": orchestrator_url,
            "NEONCORE_AGENT_TYPE": "claude",
        },
    }

    mcp_json_path = os.path.join(repo_root(), ".mcp.json")
    try:
        if os.path.exists(mcp_json_path):
            with open(mcp_json_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        else:
            cfg = {}
    except Exception:
        cfg = {}
    servers = cfg.get("mcpServers", {})
    servers["neoncore"] = entry  # overwrite our own entry; leave others untouched
    cfg["mcpServers"] = servers
    atomic_write_json(mcp_json_path, cfg)

    if not os.path.exists(mcp_server_js):
        print(f"  NOTE: {mcp_server_js} not found yet — run 'npm run build' in server/ so the MCP server can launch.")

    print()
    print("NeonCore MCP server registered (project scope) in:")
    print(f"  {mcp_json_path}")
    print("Tools: neoncore_register, neoncore_report, neoncore_request_permission,")
    print("       neoncore_report_step_done, neoncore_my_queue, neoncore_claim_task,")
    print("       neoncore_report_task_done, neoncore_list_agents")
    print("For GLOBAL (all repos) registration, run:")
    compact = json.dumps(entry, separators=(",", ":"))
    print(f"  claude mcp add-json neoncore '{compact}' --scope user")


def build_hook_command(hooks_dir: str, script_name: str, orchestrator_url: str) -> str:
    """Build the hook command string (cross-platform)."""
    script_path = os.path.join(hooks_dir, script_name)

    # When opted in, carry NEONCORE_TRUST=1 so new agents from this machine auto-approve
    trust_prefix = "NEONCORE_TRUST=1 " if trust_enabled() else ""
    # Claude Code uses bash (incl. Git Bash on Windows), so Unix env var syntax works everywhere
    interpreter = "python" if platform.system() == "Windows" else "python3"
    return f'NEONCORE_URL={orchestrator_url} {trust_prefix}{interpreter} "{script_path}"'


def is_neoncore_hook(hook) -> bool:
    """Check if a hook entry is a NeonCore hook."""
    s = str(hook).lower()
    return any(keyword in s for keyword in [
        "neoncore", "reporter.sh", "permission-proxy.sh", "message-reader.sh",
        "notification.sh", "reporter.py", "permission-proxy.py",
        "message-reader.py", "notification.py",
    ])


def main():
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
    required_hooks = ["reporter.py", "permission-proxy.py", "message-reader.py", "notification.py"]
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
        for sh_hook in ["reporter.sh", "permission-proxy.sh", "message-reader.sh", "notification.sh"]:
            path = os.path.join(hooks_dir, sh_hook)
            if os.path.exists(path):
                os.chmod(path, 0o755)

    # Build hook commands
    reporter_cmd = build_hook_command(hooks_dir, "reporter.py", orchestrator_url)
    permission_cmd = build_hook_command(hooks_dir, "permission-proxy.py", orchestrator_url)
    message_cmd = build_hook_command(hooks_dir, "message-reader.py", orchestrator_url)
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

    # UserPromptSubmit → reporter
    hooks["UserPromptSubmit"] = [h for h in hooks.get("UserPromptSubmit", []) if not is_neoncore_hook(h)]
    hooks["UserPromptSubmit"].append(make_hook_entry(reporter_cmd))

    settings["hooks"] = hooks

    # Back up the current settings.json, then write the new one atomically so a
    # future power loss can't leave it truncated (which is what lost the hooks).
    backup_file(settings_file)
    atomic_write_json(settings_file, settings)

    # Register the NeonCore MCP coordination server for Claude Code
    install_mcp_server(orchestrator_url)

    print()
    print("Installation complete!")
    print()
    print("Hooks installed:")
    print("  - PreToolUse       → permission-proxy.py (permissions, AskUser, PlanMode)")
    print("  - PostToolUse      → reporter.py (tool activity + transcript events)")
    print("  - Stop             → reporter.py (final turn + token usage)")
    print("  - Notification     → notification.py (Claude notifications)")
    print("  - SubagentStop     → reporter.py (subagent completion)")
    print("  - UserPromptSubmit → reporter.py (user prompts)")
    print()
    print(f"To verify, check: {settings_file}")
    print("To uninstall, remove the hook entries from settings.json")
    print()
    print(f"Make sure the orchestrator server is running at {orchestrator_url}")


if __name__ == "__main__":
    main()
