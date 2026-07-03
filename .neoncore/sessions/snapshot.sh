#!/usr/bin/env bash
# Worklog heartbeat. Invoked by the Claude Code `Stop` hook after every turn.
#
# Appends a compact one-line heartbeat to journal.md (branch + dirty-file count)
# and commits ONLY .neoncore/sessions/ — so the worklog is durably saved every
# turn without ever touching in-progress code. Designed to NEVER fail a turn:
# every step is guarded and the script always exits 0.
set -uo pipefail

# Resolve repo root from the script's own location (hook cwd may vary).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || exit 0
cd "$REPO" 2>/dev/null || exit 0

SESSIONS=".neoncore/sessions"
JOURNAL="$SESSIONS/journal.md"
[ -f "$JOURNAL" ] || exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || exit 0
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

# Count dirty tracked/untracked paths, excluding the worklog itself.
DIRTY_COUNT="$(git status --porcelain 2>/dev/null | grep -vc "$SESSIONS" || echo 0)"
if [ "$DIRTY_COUNT" -eq 0 ]; then STATE="clean"; else STATE="${DIRTY_COUNT} file(s) dirty"; fi

printf '\n### ⏱ %s — heartbeat\n- branch `%s` — working tree: %s\n' \
  "$TS" "$BRANCH" "$STATE" >> "$JOURNAL"

git add "$SESSIONS" >/dev/null 2>&1 || exit 0
if ! git diff --cached --quiet -- "$SESSIONS" 2>/dev/null; then
  git commit -q -m "chore(worklog): heartbeat $TS" -- "$SESSIONS" >/dev/null 2>&1 || true
fi
exit 0
