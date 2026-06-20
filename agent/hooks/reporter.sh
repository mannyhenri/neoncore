#!/usr/bin/env bash
# NeonCore Activity Reporter Hook (shell wrapper).
# Fires on PostToolUse, Stop, SubagentStop, and UserPromptSubmit.
# Delegates to reporter.py so the transcript-parsing logic lives in one place.
# Requires python3 (already a hard dependency of the hooks). Always exits 0.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/env python3 "$DIR/reporter.py"
