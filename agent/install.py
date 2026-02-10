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
import argparse
import platform


def get_settings_path() -> str:
    """Get Claude Code settings.json path for current OS."""
    if platform.system() == "Windows":
        return os.path.join(os.environ.get("USERPROFILE", ""), ".claude", "settings.json")
    return os.path.join(os.path.expanduser("~"), ".claude", "settings.json")


def get_hooks_dir() -> str:
    """Get absolute path to hooks directory."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks")


def build_hook_command(hooks_dir: str, script_name: str, orchestrator_url: str) -> str:
    """Build the hook command string (cross-platform)."""
    script_path = os.path.join(hooks_dir, script_name)

    if platform.system() == "Windows":
        # On Windows, use python directly with the .py script
        # Environment variable syntax: set NEONCORE_URL=... && python ...
        return f'set "NEONCORE_URL={orchestrator_url}" && python "{script_path}"'
    else:
        # On Unix, use env var prefix
        return f'NEONCORE_URL={orchestrator_url} python3 "{script_path}"'


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

    # Load or create settings
    if os.path.exists(settings_file):
        print("Existing settings.json found. Merging hooks...")
        with open(settings_file, "r", encoding="utf-8") as f:
            settings = json.load(f)
    else:
        print("Creating new settings.json...")
        settings = {}

    hooks = settings.get("hooks", {})

    def make_hook_entry(command: str) -> dict:
        return {"matcher": "", "hooks": [{"type": "command", "command": command}]}

    # PostToolUse → reporter
    hooks["PostToolUse"] = [h for h in hooks.get("PostToolUse", []) if not is_neoncore_hook(h)]
    hooks["PostToolUse"].append(make_hook_entry(reporter_cmd))

    # PreToolUse → permission proxy
    hooks["PreToolUse"] = [h for h in hooks.get("PreToolUse", []) if not is_neoncore_hook(h)]
    hooks["PreToolUse"].append(make_hook_entry(permission_cmd))

    # Stop → message reader
    hooks["Stop"] = [h for h in hooks.get("Stop", []) if not is_neoncore_hook(h)]
    hooks["Stop"].append(make_hook_entry(message_cmd))

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

    with open(settings_file, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)

    print()
    print("Installation complete!")
    print()
    print("Hooks installed:")
    print("  - PreToolUse       → permission-proxy.py (permissions, AskUser, PlanMode)")
    print("  - PostToolUse      → reporter.py (tool activity + intermediate messages)")
    print("  - Stop             → message-reader.py (final assistant message)")
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
