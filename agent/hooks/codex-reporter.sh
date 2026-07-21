#!/usr/bin/env bash
# NeonCore Reporter Hook — OpenAI Codex CLI variant (shell wrapper).
# Fires on PostToolUse, Stop, and UserPromptSubmit. Delegates to codex-reporter.py
# so the activity + transcript logic lives in one place. Requires python3 (already
# a hard dependency of the hooks). Always exits 0.
#
# Wired by the dashboard "install hooks" flow into ~/.codex/hooks.json, with the
# codex_hooks feature flag enabled in ~/.codex/config.toml.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/env python3 "$DIR/codex-reporter.py"
