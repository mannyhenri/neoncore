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
  # `${SCANS[@]+"${SCANS[@]}"}` — NOT a plain "${SCANS[@]}". macOS ships bash
  # 3.2, where expanding an EMPTY array under `set -u` aborts with "SCANS[@]:
  # unbound variable" (bash 4.4+ made this legal). expand_scans is called
  # unconditionally below, so on stock macOS every run without --scan died right
  # here — i.e. the documented one-command setup never worked on a Mac, which
  # also meant the relay symlink step never ran and Codex cartridges kept
  # launching Claude off a stale relay copy.
  for base in ${SCANS[@]+"${SCANS[@]}"}; do
    base="${base/#\~/$HOME}"
    [[ -d "$base" ]] || { warn "Scan skipped (no such dir): $base"; continue; }
    for sub in "$base"/*/; do
      [[ -d "${sub}.git" ]] && REPOS+=("${sub%/}")
    done
  done
}

# Interactive folder browser — start at $HOME and drill down; scan or add as you go.
pick_folders_interactive() {
  local cwd="$HOME"
  while true; do
    # Collect visible subdirectories of cwd.
    local dirs=() d
    while IFS= read -r d; do dirs+=("$d"); done \
      < <(find "$cwd" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | sort)

    echo
    printf '\033[36m📁 %s\033[0m   (selected so far: %d)\n' "$cwd" "${#REPOS[@]}"
    local i=1
    for d in "${dirs[@]}"; do
      local mark=""; [[ -d "$d/.git" ]] && mark=$'  \033[35m• git repo\033[0m'
      printf '  %2d) %s%s\n' "$i" "$(basename "$d")" "$mark"
      i=$((i+1))
    done
    [[ ${#dirs[@]} -eq 0 ]] && echo "  (no subfolders here)"
    echo "  ───"
    echo "  #  enter that folder   ·   u  up a level"
    echo "  s  SCAN here (add every git repo in this folder)   ·   a  ADD this folder itself"
    echo "  d  done"
    printf '  > '
    read -r choice

    case "$choice" in
      u|U) cwd="$(dirname "$cwd")" ;;
      s|S) local before=${#REPOS[@]}; SCANS=("$cwd"); expand_scans; SCANS=()
           info "Scanned $cwd → added $(( ${#REPOS[@]} - before )) repo(s)" ;;
      a|A) add_repo "$cwd"; info "Added $cwd" ;;
      d|D) break ;;
      ''|*[!0-9]*) warn "Enter a number, or u / s / a / d." ;;
      *) if (( choice >= 1 && choice <= ${#dirs[@]} )); then cwd="${dirs[$((choice-1))]}"; else warn "Out of range."; fi ;;
    esac
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

# Resolve the repo allowlist: --scan dirs first, then an interactive browser if still empty.
expand_scans
if [[ ${#REPOS[@]} -eq 0 && -t 0 ]]; then
  info "No folders given — let's pick which ones this machine exposes."
  echo "  Browse from your home folder, drill into a directory, then SCAN it (add every git"
  echo "  repo inside) or ADD it directly. Repeat as needed, then press d."
  pick_folders_interactive
fi
[[ ${#REPOS[@]} -gt 0 ]] || die "No folders selected. Pass --repo DIR / --scan DIR, or use the interactive picker."

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
# When setup runs from a repo checkout, symlink the relay instead of copying it, so
# `git pull` keeps the installed relay current and the dashboard button can never lag
# behind the source (the "works in terminal, not from the button" drift). Runner-zip
# installs have no repo, so they still copy. The runner spawns the relay fresh per
# launch, so the link is picked up with no daemon restart.
IN_REPO=""
[[ -d "$SOURCE_DIR/../../.git" ]] && IN_REPO=1
link_or_copy() { # src dst
  local src="$1" dst="$2"
  if [[ -n "$IN_REPO" ]]; then
    local abs; abs="$(cd "$src" && pwd -P)"
    rm -rf "$dst"          # dst is under ~/.neoncore; the repo src is never touched
    ln -sfn "$abs" "$dst"
    info "Linked $dst -> $abs (repo checkout — no drift)"
  else
    mkdir -p "$dst"
    copy "$src" "$dst"
  fi
}
copy "$SOURCE_DIR" "$INSTALL_DIR"
# The relay + hooks live beside the runner in the package; keep that layout in the install
# home (~/.neoncore/{runner,relay,agent}).
if [[ -d "$SOURCE_DIR/../relay" ]]; then
  link_or_copy "$SOURCE_DIR/../relay" "$INSTALL_DIR/../relay"
fi
# The runner and relay import ../lib/*.mjs, so lib lives beside them (~/.neoncore/lib);
# without it both die on start with ERR_MODULE_NOT_FOUND and launchd restarts them forever.
if [[ -d "$SOURCE_DIR/../lib" ]]; then
  mkdir -p "$INSTALL_DIR/../lib"
  copy "$SOURCE_DIR/../lib" "$INSTALL_DIR/../lib"
fi
HOOKS_SRC=""
if [[ -f "$SOURCE_DIR/../agent/install.py" ]]; then HOOKS_SRC="$SOURCE_DIR/../agent"; fi   # runner zip: runner/ + agent/ siblings
if [[ -z "$HOOKS_SRC" && -f "$SOURCE_DIR/../install.py" ]]; then HOOKS_SRC="$SOURCE_DIR/.."; fi  # in-repo: agent/runner → agent/
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

# Build repos JSON from the --repo list. SCANS is empty without --scan — guarded for bash 3.2
# (see expand_scans).
SCAN_ROOTS_JSON="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' ${SCANS[@]+"${SCANS[@]}"} 2>/dev/null || echo "[]")"
REPOS_JSON="$(node -e '
  const path = require("path");
  const repos = process.argv.slice(1).map(p => ({ path: p, name: path.basename(p.replace(/[\\/]+$/,"")) || p }));
  process.stdout.write(JSON.stringify(repos));
' "${REPOS[@]}")"

node -e '
  const fs = require("fs");
  const [out, server, token, name, machineId, reposJson, scanRootsJson] = process.argv.slice(1);
  const cfg = {
    serverUrl: server,
    token: token || "",
    machineId: machineId || "",
    hostname: name || "",
    repos: JSON.parse(reposJson),
    // Roots given with --scan stay tracked: the runner re-scans them periodically, so a
    // repo cloned into one later appears in "+ Launch" without re-running setup.
    scanRoots: JSON.parse(scanRootsJson || "[]"),
  };
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
' "$INSTALL_DIR/runner.config.json" "$SERVER" "$TOKEN" "$NAME" "$MACHINE_ID" "$REPOS_JSON" "$SCAN_ROOTS_JSON"
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
