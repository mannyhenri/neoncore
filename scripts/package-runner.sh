#!/usr/bin/env bash
#
# Builds dist/neoncore-runner.zip — the single file you copy to each computer to install the
# machine runner. Contains the runner + relay source and the cross-platform setup scripts
# (no node_modules; setup installs deps on the target so native binaries match the platform).
#
# Usage:  ./scripts/package-runner.sh
# Output: dist/neoncore-runner.zip

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
STAGE="$OUT_DIR/neoncore-runner"
ZIP="$OUT_DIR/neoncore-runner.zip"

echo "[package-runner] Staging in $STAGE"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE/runner" "$STAGE/relay" "$STAGE/agent/hooks"

copy() { # src dst
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude node_modules --exclude logs --exclude '__pycache__' \
      --exclude '*.pyc' --exclude 'runner.config.json' "$1"/ "$2"/
  else
    cp -R "$1"/. "$2"/
    rm -rf "$2/node_modules" "$2/logs" "$2/__pycache__" "$2/runner.config.json"
  fi
}

copy "$ROOT/agent/runner" "$STAGE/runner"
copy "$ROOT/agent/relay"  "$STAGE/relay"
# Bundle the hooks installer so setup can install status/activity/approval hooks — the
# runner is then fully self-contained (no separate agent install needed).
cp "$ROOT/agent/install.py" "$STAGE/agent/install.py"
copy "$ROOT/agent/hooks" "$STAGE/agent/hooks"
chmod +x "$STAGE/runner/setup.sh" 2>/dev/null || true

cat > "$STAGE/README.txt" <<'EOF'
NeonCore Machine Runner — quick start
=====================================

Lets you launch cartridges on THIS computer from the NeonCore web/mobile portal.

Requires Node.js 18+ (used by the relay). Install from https://nodejs.org if needed.

── Use the server's NAME, not its IP ─────────────────────────
On a LAN, reach the server by its Bonjour/mDNS name instead of an IP that changes:
  http://<server-computer-name>.local:4040     e.g.  http://Mannys-Mac-Pro.local:4040
Works out of the box on macOS and Windows 10+; on Linux install avahi-daemon.

Requires Python 3 too (used once to install the status/approval hooks).

── macOS / Linux ─────────────────────────────────────────────
  cd runner
  ./setup.sh --server http://SERVER-NAME.local:4040 --token YOUR_TOKEN --scan ~/code

── Windows (PowerShell) ──────────────────────────────────────
  cd runner
  .\setup.ps1 -Server http://SERVER-NAME.local:4040 -Token YOUR_TOKEN -Scan C:\code

What it does: installs to ~/.neoncore/runner, installs hooks, sets up auto-start on login,
and starts it. The machine then appears in the portal's "+ Launch" menu.

── Choosing folders to expose ────────────────────────────────
  (neither flag)    opens an interactive FOLDER BROWSER — start at your home
                    folder, drill in by number, then s=scan / a=add / u=up / d=done
  --scan DIR        add every git repo directly under DIR      (-Scan on Windows)
  --repo DIR        add one folder (repeatable)                (-Repo on Windows)

── Change folders later ──────────────────────────────────────
  • From the portal: open "+ Launch", find the machine, click "Edit folders",
    then remove with x or add a path. (No config editing.)
  • Or edit "repos" in ~/.neoncore/runner/runner.config.json and restart.

Add --no-service (or -NoService) to just run it once in the foreground.
Remove it later with:  ./setup.sh --uninstall   (or  .\setup.ps1 -Uninstall )

── The pairing token (YOUR_TOKEN above) ──────────────────────
Stops random machines from registering. Set it ONCE on the server, then use the
SAME value on every machine.

  1. Generate one (any long random string):
       openssl rand -hex 24
       (or)  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

  2. Set it on the server (once, from anything that can reach the server):
       curl -X PUT http://SERVER-NAME.local:4040/api/settings \
         -H "Content-Type: application/json" \
         -d "{\"machine_pairing_token\":\"PASTE_THE_TOKEN\"}"

  3. Pass the same value as --token / -Token here. Must match exactly, or you get
     "401 Invalid pairing token" on register.

  Leave it empty only on a trusted LAN where the server isn't reachable elsewhere.
EOF

echo "[package-runner] Zipping → $ZIP"
( cd "$OUT_DIR" && zip -qr "neoncore-runner.zip" "neoncore-runner" )
rm -rf "$STAGE"

echo "[package-runner] Done: $ZIP"
ls -lh "$ZIP"
