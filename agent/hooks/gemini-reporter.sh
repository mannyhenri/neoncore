#!/usr/bin/env bash
# NeonCore Reporter Hook — Gemini CLI variant (shell wrapper).
# Fires on AfterTool and AfterAgent. Delegates to gemini-reporter.py so the
# activity + transcript logic lives in one place. Requires python3 (already a
# hard dependency of the hooks). Always exits 0.
#
# Wired by the dashboard "install hooks" flow into ~/.gemini/settings.json.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/env python3 "$DIR/gemini-reporter.py"
