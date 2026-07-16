#!/usr/bin/env bash
#
# One-command NeonCore RUNNER setup for a Mac or Linux machine.
#
# Installs the machine runner so you can launch cartridges on THIS computer from the
# web/mobile portal. Copies the runner + relay to ~/.neoncore/runner, installs deps,
# writes the config, registers an auto-start service (launchd on macOS, systemd on Linux),
# and starts it.
#
# Usage (from the unzipped folder):
#   ./setup.sh --server http://192.168.4.20:4040 --token SECRET --repo ~/code/app --repo ~/code/api
#
# Flags:
#   --server URL     orchestrator URL (e.g. http://Mannys-Mac-Pro.local:4040) [required]
#   --token TOK      pairing token (must match the server's setting)     [required if server has one]
#   --repo DIR       a directory this machine may launch in (repeatable)
#   --scan DIR       add every git repo directly under DIR (repeatable)
#   --name NAME      display name for this machine (default: hostname)
#   --no-service     install + run in the foreground; skip auto-start
#   --uninstall      stop + remove the auto-start service and exit
#
# If you give neither --repo nor --scan, you'll be prompted for the folders to expose.

set -euo pipefail

info()  { printf '\033[36m[runner-setup]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[runner-setup]\033[0m %s\n' "$*"; }
die()   { printf '\033[31m[runner-setup] %s\033[0m\n' "$*" >&2; exit 1; }

SERVER=""
TOKEN=""
NAME=""
NO_SERVICE=""
UNINSTALL=""
REPOS=()
SCANS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token)  TOKEN="$2";  shift 2 ;;
    --repo)   REPOS+=("$2"); shift 2 ;;
    --scan)   SCANS+=("$2"); shift 2 ;;
    --name)   NAME="$2";   shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    *) die "Unknown flag: $1" ;;
  esac
done

# Expand a directory into '<name>|<path>' lines for each git repo directly under it.
add_repo() { # absolute-path
  local p="${1%/}"
  [[ -d "$p" ]] || { warn "Skipping (not a directory): $p"; return; }
  REPOS+=("$p")
}
expand_scans() {
  local base sub
  for base in "${SCANS[@]}"; do
    base="${base/#\~/$HOME}"
    [[ -d "$base" ]] || { warn "Scan skipped (no such dir): $base"; continue; }
    for sub in "$base"/*/; do
      [[ -d "${sub}.git" ]] && REPOS+=("${sub%/}")
    done
  done
}

INSTALL_DIR="$HOME/.neoncore/runner"
SERVICE_LABEL="ai.gridlight.neoncore.runner"
PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/neoncore-runner.service"
OS="$(uname -s)"

# ── Uninstall ──────────────────────────────────────────────
if [[ -n "$UNINSTALL" ]]; then
  if [[ "$OS" == "Darwin" ]]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  else
    systemctl --user disable --now neoncore-runner 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  info "Runner service removed. Config kept at $INSTALL_DIR/runner.config.json"
  exit 0
fi

command -v node >/dev/null 2>&1 || die "Node.js is required (used by the relay). Install Node 18+ then re-run."
command -v npm  >/dev/null 2>&1 || die "npm is required. Install Node.js (which includes npm) then re-run."

[[ -n "$SERVER" ]] || die "Missing --server URL (e.g. --server http://Mannys-Mac-Pro.local:4040)"

# Resolve the repo allowlist: --scan dirs, then an interactive prompt if still empty.
expand_scans
if [[ ${#REPOS[@]} -eq 0 ]]; then
  if [[ -t 0 ]]; then
    echo
    info "Which folders should this machine give NeonCore access to?"
    echo "  Enter directories to expose, comma-separated. You can give:"
    echo "    • individual repos:   ~/code/app, ~/code/api"
    echo "    • a parent to scan:    scan:~/code    (adds every git repo under it)"
    printf "  Folders: "
    read -r ANSWER
    IFS=',' read -ra PARTS <<< "$ANSWER"
    for part in "${PARTS[@]}"; do
      part="$(echo "$part" | sed 's/^ *//;s/ *$//')"
      [[ -z "$part" ]] && continue
      if [[ "$part" == scan:* ]]; then
        SCANS=("${part#scan:}"); expand_scans
      else
        add_repo "${part/#\~/$HOME}"
      fi
    done
  fi
fi
[[ ${#REPOS[@]} -gt 0 ]] || die "No folders selected. Pass --repo DIR / --scan DIR, or answer the prompt."

# De-duplicate.
REPOS=($(printf '%s\n' "${REPOS[@]}" | awk '!seen[$0]++'))
info "Exposing ${#REPOS[@]} folder(s):"
for r in "${REPOS[@]}"; do echo "    • $r"; done

SERVER="${SERVER%/}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Copy runner + relay to a stable home ───────────────────
info "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
copy() { # src dst
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude node_modules --exclude logs --exclude 'runner.config.json' "$1"/ "$2"/
  else
    cp -R "$1"/. "$2"/
  fi
}
copy "$SOURCE_DIR" "$INSTALL_DIR"
# The relay + hooks live beside the runner in the package; keep that layout in the install
# home (~/.neoncore/{runner,relay,agent}).
if [[ -d "$SOURCE_DIR/../relay" ]]; then
  mkdir -p "$INSTALL_DIR/../relay"
  copy "$SOURCE_DIR/../relay" "$INSTALL_DIR/../relay"
fi
HOOKS_SRC=""
if [[ -f "$SOURCE_DIR/../agent/install.py" ]]; then HOOKS_SRC="$SOURCE_DIR/../agent"; fi   # runner zip layout
if [[ -z "$HOOKS_SRC" && -f "$SOURCE_DIR/../../install.py" ]]; then HOOKS_SRC="$SOURCE_DIR/../.."; fi  # in-repo (agent/runner → agent)
if [[ -n "$HOOKS_SRC" ]]; then
  mkdir -p "$INSTALL_DIR/../agent/hooks"
  cp "$HOOKS_SRC/install.py" "$INSTALL_DIR/../agent/install.py"
  copy "$HOOKS_SRC/hooks" "$INSTALL_DIR/../agent/hooks"
fi

# ── Install deps ───────────────────────────────────────────
info "Installing runner dependencies…"
( cd "$INSTALL_DIR" && npm install --silent )
if [[ -d "$INSTALL_DIR/../relay" ]]; then
  info "Installing relay dependencies…"
  ( cd "$INSTALL_DIR/../relay" && npm install --silent )
fi

# ── Install Claude Code hooks (status / activity / approvals) ──
# Global, one-time. Without this, remotely-launched cartridges appear but report no status
# and can't surface approvals. Best-effort — needs python3.
HOOKS_PY="$INSTALL_DIR/../agent/install.py"
if [[ -f "$HOOKS_PY" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    info "Installing NeonCore hooks (status/activity/approvals)…"
    python3 "$HOOKS_PY" --url "$SERVER" >/dev/null 2>&1 && info "Hooks installed." \
      || warn "Hook installer reported an error — cartridges will still launch, but without live status/approvals."
  else
    warn "python3 not found — skipping hooks. Cartridges launch but won't report status/approvals. Install Python 3 and re-run."
  fi
fi

# ── Write config (preserves an existing machineId) ─────────
MACHINE_ID=""
if [[ -f "$INSTALL_DIR/runner.config.json" ]]; then
  MACHINE_ID="$(node -e 'try{process.stdout.write((require(process.argv[1]).machineId)||"")}catch(e){}' "$INSTALL_DIR/runner.config.json" 2>/dev/null || true)"
fi

# Build repos JSON from the --repo list.
REPOS_JSON="$(node -e '
  const path = require("path");
  const repos = process.argv.slice(1).map(p => ({ path: p, name: path.basename(p.replace(/[\\/]+$/,"")) || p }));
  process.stdout.write(JSON.stringify(repos));
' "${REPOS[@]}")"

node -e '
  const fs = require("fs");
  const [out, server, token, name, machineId, reposJson] = process.argv.slice(1);
  const cfg = {
    serverUrl: server,
    token: token || "",
    machineId: machineId || "",
    hostname: name || "",
    repos: JSON.parse(reposJson),
  };
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
' "$INSTALL_DIR/runner.config.json" "$SERVER" "$TOKEN" "$NAME" "$MACHINE_ID" "$REPOS_JSON"
info "Wrote $INSTALL_DIR/runner.config.json ($(echo "${#REPOS[@]}") repo(s))"

# ── Foreground mode ────────────────────────────────────────
if [[ -n "$NO_SERVICE" ]]; then
  info "Starting runner in the foreground (Ctrl+C to stop)…"
  exec node "$INSTALL_DIR/index.js"
fi

NODE_BIN="$(command -v node)"

# ── Auto-start service ─────────────────────────────────────
if [[ "$OS" == "Darwin" ]]; then
  info "Installing launchd service ($SERVICE_LABEL)…"
  mkdir -p "$HOME/Library/LaunchAgents" "$INSTALL_DIR/logs"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$INSTALL_DIR/index.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$INSTALL_DIR/logs/runner.out.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_DIR/logs/runner.err.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  info "Started. It will relaunch on login. Logs: $INSTALL_DIR/logs/"
  info "Stop/remove:  $INSTALL_DIR/setup.sh --uninstall"
else
  info "Installing systemd user service (neoncore-runner)…"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=NeonCore machine runner
After=network-online.target

[Service]
ExecStart=$NODE_BIN $INSTALL_DIR/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT_EOF
  systemctl --user daemon-reload
  systemctl --user enable --now neoncore-runner
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "Could not enable linger — runner may only run while you're logged in."
  info "Started. Status:  systemctl --user status neoncore-runner"
  info "Stop/remove:  $INSTALL_DIR/setup.sh --uninstall"
fi
