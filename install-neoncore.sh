#!/usr/bin/env bash
#
# Full NeonCore installer for Mac / Linux.
#
# Installs and builds the NeonCore server + dashboard from this repo, then
# (optionally) starts it. Run this from the repo root, e.g. inside the folder
# extracted from neoncore-full.zip, or from a fresh `git clone`.
#
# Usage:
#   ./install-neoncore.sh            # install, build, then prompt to start
#   ./install-neoncore.sh --start    # install, build, start (no prompt)
#   ./install-neoncore.sh --no-start # install, build only
#   ./install-neoncore.sh --dev      # install, then run hot-reload dev mode

set -euo pipefail

START_MODE="prompt"   # prompt | yes | no | dev
while [[ $# -gt 0 ]]; do
  case "$1" in
    --start)    START_MODE="yes"; shift ;;
    --no-start) START_MODE="no";  shift ;;
    --dev)      START_MODE="dev"; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

info() { printf '  \033[36m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK  %s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!   %s\033[0m\n' "$*"; }
die()  { printf '  \033[31mX   %s\033[0m\n' "$*"; exit 1; }

echo
printf '\033[35mNeonCore Full Installer (Mac/Linux)\033[0m\n'
printf '\033[35m===================================\033[0m\n'
echo

# --- Sanity: are we in the repo? ----------------------------------------------
[[ -f "$ROOT/package.json" ]] || die "package.json not found - run this from the NeonCore repo root."
grep -q '"name": *"neoncore"' "$ROOT/package.json" || warn "This doesn't look like the neoncore package - continuing anyway."

# --- Prerequisites ------------------------------------------------------------
echo "[1/4] Checking prerequisites..."
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 18+ from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm not found. It ships with Node.js."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node 18+ required (found $(node -v))."
ok "Node $(node -v), npm $(npm -v)"
echo

# --- Install dependencies -----------------------------------------------------
echo "[2/4] Installing dependencies (npm install)..."
npm install
ok "Dependencies installed."
echo

# --- Build --------------------------------------------------------------------
echo "[3/4] Building dashboard + server (npm run build)..."
npm run build
ok "Build complete (dashboard bundled into server/public)."
echo

# --- Report the URLs ----------------------------------------------------------
LAN_IP=""
for iface in en0 en1 en2 eth0 wlan0; do
  LAN_IP=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
  [[ -n "$LAN_IP" ]] && break
done
[[ -z "$LAN_IP" ]] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)

echo "[4/4] Ready."
ok "Local:    http://localhost:4040"
[[ -n "$LAN_IP" ]] && ok "Network:  http://${LAN_IP}:4040   (agents connect here)"
echo
info "Agents on other machines connect with the agent package (bootstrap.sh /"
info "bootstrap.ps1), pointing at the Network URL above. See INSTALL.md."
echo

# --- Start --------------------------------------------------------------------
run_start() { exec npm start; }
run_dev()   { exec npm run dev; }

case "$START_MODE" in
  yes) info "Starting server (Ctrl-C to stop)..."; run_start ;;
  dev) info "Starting dev mode with hot reload (Ctrl-C to stop)..."; run_dev ;;
  no)  info "Not starting. Launch it anytime with:  npm start" ;;
  prompt)
    if [[ -t 0 ]]; then
      read -r -p "  Start the NeonCore server now? [Y/n]: " ans
      case "${ans:-Y}" in
        [Nn]*) info "Not starting. Launch it anytime with:  npm start" ;;
        *)     info "Starting server (Ctrl-C to stop)..."; run_start ;;
      esac
    else
      info "Non-interactive shell - not starting. Launch it with:  npm start"
    fi
    ;;
esac
