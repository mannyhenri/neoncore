#!/usr/bin/env bash
# Unsupervised sweep — DIAGNOSIS ONLY. Changes nothing.
#
# Prints every signal that means "something is stuck or needs a person", so the agent driving
# the 10-minute cron applies judgement to a consistent picture instead of re-deriving queries
# each run. Read-only on purpose: an automated fixer that also decides what to fix is a thing
# nobody can audit after the fact. The agent acts, and logs what it did.
#
# Usage: scripts/confer-sweep.sh
set -uo pipefail

DB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/server/neoncore.db"
URL="${NEONCORE_URL:-http://localhost:4040}"
q() { sqlite3 -header -column "$DB" "$1" 2>/dev/null; }

echo "=== SWEEP $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

echo "--- server ---"
printf '  api: HTTP %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/api/goals" || echo 000)"
echo

# 1. THE STALE-WAITING TRAP. isCartridgeBusy() counts 'waiting' as busy, so a cartridge that
#    ended a session in 'waiting' with no actual question holds its own lane shut forever.
#    This is the single most common cause of "nothing is running and nothing is wrong".
echo "--- [1] cartridges waiting on NOTHING (stale — safe to clear to idle) ---"
q "SELECT id, repo_name, substr(last_seen,12,8) AS last_seen
     FROM agents
    WHERE status='waiting' AND COALESCE(pending_question,'')='';"
echo

# 2. Cartridges genuinely blocked on a question. These need an ANSWER, not a status change.
echo "--- [2] cartridges asking a REAL question (answer these) ---"
q "SELECT id, repo_name, substr(pending_question,1,160) AS question
     FROM agents
    WHERE status='waiting' AND COALESCE(pending_question,'')!='';"
echo

echo "--- [3] paused or halted queue lanes (frozen work) ---"
q "SELECT substr(lane,1,46) AS lane, paused, COALESCE(halt_kind,'') AS halt,
          substr(COALESCE(halted_reason,''),1,60) AS reason
     FROM queue_lanes
    WHERE paused=1 OR COALESCE(halted_reason,'')!='';"
echo

echo "--- [4] confers not finished ---"
q "SELECT substr(id,1,8) AS id, status, current_milestone AS ms,
          substr(COALESCE(error,''),1,70) AS error, substr(task,1,60) AS task
     FROM confer_sessions
    WHERE status IN ('running','failed')
    ORDER BY created_at;"
echo

echo "--- [5] queue ---"
q "SELECT substr(id,1,8) AS id, kind, status, stall_ticks AS stall, substr(lane,1,40) AS lane
     FROM queue_items
    WHERE status IN ('queued','running')
    ORDER BY status DESC, position;"
echo

echo "--- [6] cartridges working (leave these alone) ---"
q "SELECT repo_name, substr(last_seen,12,8) AS last_seen,
          CAST((julianday('now') - julianday(last_seen)) * 1440 AS INT) AS mins_since_seen
     FROM agents WHERE status='working';"
echo

echo "--- [7] permissions awaiting approval (block the asking cartridge) ---"
q "SELECT id, substr(tool_name,1,20) AS tool, substr(description,1,70) AS what
     FROM permissions WHERE status='pending';"
echo

echo "=== END SWEEP ==="
