#!/usr/bin/env bash
# NeonCore Agent Hook Uninstaller
# Removes NeonCore hook entries from Claude Code's settings.json.
# Other hooks in the file are left untouched.
#
# Usage: ./uninstall.sh

set -e

SETTINGS_FILE="$HOME/.claude/settings.json"

# Python interpreter shim (prefer python3, fall back to python, then py launcher).
PYTHON="${PYTHON:-$(command -v python3 || command -v python || command -v py || true)}"
[ -z "$PYTHON" ] && { echo "Error: python 3.x required (install python or set PYTHON)" >&2; exit 1; }

echo "NeonCore Agent Hook Uninstaller"
echo "==============================="
echo ""
echo "Settings file: $SETTINGS_FILE"
echo ""

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "No settings.json found — nothing to uninstall."
  exit 0
fi

# Convert path for native Windows Python (Git Bash /c/... is unintelligible to it).
if command -v cygpath >/dev/null 2>&1; then
  PY_SETTINGS_FILE=$(cygpath -m "$SETTINGS_FILE")
else
  PY_SETTINGS_FILE="$SETTINGS_FILE"
fi

"$PYTHON" << PYEOF
import json

settings_file = "$PY_SETTINGS_FILE"

with open(settings_file, "r", encoding="utf-8") as f:
    settings = json.load(f)

def is_neoncore(h):
    s = str(h).lower()
    return any(k in s for k in (
        "neoncore",
        "reporter.sh", "permission-proxy.sh", "message-reader.sh", "notification.sh",
        "reporter.py", "permission-proxy.py", "message-reader.py", "notification.py",
    ))

hooks = settings.get("hooks", {})
removed = 0
for event, entries in list(hooks.items()):
    kept = [h for h in entries if not is_neoncore(h)]
    removed += len(entries) - len(kept)
    if kept:
        hooks[event] = kept
    else:
        # Drop empty hook arrays so we don't leave noise behind.
        del hooks[event]

if hooks:
    settings["hooks"] = hooks
elif "hooks" in settings:
    del settings["hooks"]

with open(settings_file, "w", encoding="utf-8") as f:
    json.dump(settings, f, indent=2)

print(f"Removed {removed} NeonCore hook entr{'y' if removed == 1 else 'ies'}.")
PYEOF

echo ""
echo "Uninstall complete."
echo "To re-install, run: $(dirname "$0")/install.sh"
