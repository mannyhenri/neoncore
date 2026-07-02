#!/usr/bin/env bash
#
# One-shot NeonCore AGENT setup for a Mac or Linux machine.
#
# Connects THIS machine to an existing NeonCore server: installs the Claude Code
# hooks, builds the relay, and launches a bare-terminal Claude Code session that
# shows up as a cartridge in the dashboard.
#
# It first copies the agent files to a stable home (~/.neoncore/agent) and installs
# from there, so you can safely run this from Downloads and delete the download after.
#
# Usage (from anywhere - e.g. the unzipped folder):
#   ./bootstrap.sh                                  # auto-find server, relay in $PWD
#   ./bootstrap.sh --repo-path ~/code/my-project
#   ./bootstrap.sh --server-ip 192.168.4.20 --trust
#
# Flags:
#   --server-url URL   full orchestrator URL (e.g. http://192.168.4.20:4040)
#   --server-ip IP     server LAN IP (combined with --port)
#   --port N           server port (default 4040)
#   --repo-path DIR    folder the Claude session runs in (default: current dir)
#   --agent-type T     agent type to register as (default: claude)
#   --trust            auto-approve this agent's permissions
#   --skip-hooks       don't install the Claude Code hooks
#   --skip-relay       install/verify only; don't launch the relay

set -euo pipefail

DEFAULT_SERVER_IP="192.168.4.20"
PORT=4040
REPO_PATH="$(pwd)"
AGENT_TYPE="claude"
TRUST=""
SKIP_HOOKS=""
SKIP_RELAY=""
SERVER_URL=""
SERVER_IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --server-ip)  SERVER_IP="$2";  shift 2 ;;
    --port)       PORT="$2";       shift 2 ;;
    --repo-path)  REPO_PATH="$2";  shift 2 ;;
    --agent-type) AGENT_TYPE="$2"; shift 2 ;;
    --trust)      TRUST=1;         shift ;;
    --skip-hooks) SKIP_HOOKS=1;    shift ;;
    --skip-relay) SKIP_RELAY=1;    shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

info() { printf '  \033[36m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK  %s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!   %s\033[0m\n' "$*"; }
die()  { printf '  \033[31mX   %s\033[0m\n' "$*"; exit 1; }

test_neoncore() { # ip port
  curl -fsS --max-time 2 "http://$1:$2/api/agents" >/dev/null 2>&1
}

find_server() {
  info "Trying known server $DEFAULT_SERVER_IP ..." >&2
  if test_neoncore "$DEFAULT_SERVER_IP" "$PORT"; then echo "$DEFAULT_SERVER_IP"; return; fi

  warn "$DEFAULT_SERVER_IP did not answer - scanning the local network..." >&2
  local myip=""
  for iface in en0 en1 en2 eth0 wlan0; do
    myip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    [[ -n "$myip" ]] && break
  done
  [[ -z "$myip" ]] && myip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  [[ -z "$myip" ]] && return
  local prefix="${myip%.*}"
  info "Probing ${prefix}.0/24 on port $PORT ..." >&2

  local tmp; tmp=$(mktemp)
  for h in $(seq 1 254); do
    ( nc -z -G1 "${prefix}.$h" "$PORT" >/dev/null 2>&1 && echo "${prefix}.$h" >>"$tmp" ) &
  done
  wait
  while read -r ip; do
    if test_neoncore "$ip" "$PORT"; then echo "$ip"; rm -f "$tmp"; return; fi
  done <"$tmp"
  rm -f "$tmp"
}

echo
printf '\033[35mNeonCore Agent Bootstrap (Mac/Linux)\033[0m\n'
printf '\033[35m====================================\033[0m\n'
echo

# --- Relocate agent files to a stable home ------------------------------------
# Hook commands bake in absolute paths; installing from a throwaway location
# (Downloads, an extracted zip) breaks them the moment that folder is removed.
# Copy to ~/.neoncore/agent and install from there.
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.neoncore/agent"
if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
  info "Installing agent files to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude node_modules --exclude __pycache__ --exclude '*.pyc' "$SOURCE_DIR"/ "$INSTALL_DIR"/
  else
    cp -R "$SOURCE_DIR"/. "$INSTALL_DIR"/
    rm -rf "$INSTALL_DIR/relay/node_modules"
  fi
fi
AGENT_DIR="$INSTALL_DIR"
INSTALL_PY="$AGENT_DIR/install.py"
RELAY_DIR="$AGENT_DIR/relay"
RELAY_JS="$RELAY_DIR/index.js"
echo

# --- Resolve the orchestrator URL ---------------------------------------------
if [[ -z "$SERVER_URL" ]]; then
  if [[ -z "$SERVER_IP" ]]; then
    echo "Locating the NeonCore server..."
    SERVER_IP="$(find_server || true)"
    if [[ -n "$SERVER_IP" ]]; then
      ok "Found orchestrator at $SERVER_IP"
    else
      warn "Auto-discovery failed."
      read -r -p "  Enter the NeonCore server LAN IP (default $DEFAULT_SERVER_IP): " SERVER_IP
      [[ -z "$SERVER_IP" ]] && SERVER_IP="$DEFAULT_SERVER_IP"
    fi
    echo
  fi
  SERVER_URL="http://${SERVER_IP}:${PORT}"
fi
SERVER_URL="${SERVER_URL%/}"

info "Orchestrator : $SERVER_URL"
info "Agent home   : $AGENT_DIR"
info "Repo (relay) : $REPO_PATH"
info "Agent type   : $AGENT_TYPE"
info "Trust mode   : $([[ -n "$TRUST" ]] && echo 'enabled (auto-approve)' || echo 'disabled (manual approval)')"
echo

export NEONCORE_URL="$SERVER_URL"
export NEONCORE_AGENT_TYPE="$AGENT_TYPE"
[[ -n "$TRUST" ]] && export NEONCORE_TRUST=1

# --- Step 1: connectivity check -----------------------------------------------
echo "[1/4] Checking connectivity to the orchestrator..."
if curl -fsS --max-time 8 "$SERVER_URL/api/agents" >/dev/null 2>&1; then
  ok "Reachable."
else
  warn "Could not reach $SERVER_URL/api/agents"
  warn "Check: server running, same subnet, port $PORT open. Continuing anyway."
fi
echo

# --- Step 2: install hooks ----------------------------------------------------
echo "[2/4] Installing Claude Code hooks..."
if [[ -n "$SKIP_HOOKS" ]]; then
  info "Skipped (--skip-hooks)."
elif ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found - skipping hooks."
elif [[ ! -f "$INSTALL_PY" ]]; then
  warn "install.py not found in agent home - skipping hooks."
else
  python3 "$INSTALL_PY" --url "$SERVER_URL" && ok "Hooks installed." || warn "Hook installer reported an error."
fi
echo

# --- Step 3: relay prerequisites ----------------------------------------------
echo "[3/4] Preparing the relay..."
if [[ -n "$SKIP_RELAY" ]]; then
  info "Skipped (--skip-relay)."
elif ! command -v node >/dev/null 2>&1; then
  warn "Node.js not found - install from https://nodejs.org to use the relay."
  SKIP_RELAY=1
elif [[ ! -f "$RELAY_JS" ]]; then
  warn "relay/index.js not found - skipping relay."
  SKIP_RELAY=1
else
  if [[ ! -d "$RELAY_DIR/node_modules" ]]; then
    info "Installing relay dependencies (builds node-pty)..."
    ( cd "$RELAY_DIR" && npm install ) && ok "Relay dependencies ready." || { warn "npm install failed."; SKIP_RELAY=1; }
  else
    ok "Relay dependencies already present."
  fi
fi
echo

# --- Resolve the Claude Code CLI ----------------------------------------------
if [[ -z "$SKIP_RELAY" && -z "${NEONCORE_AGENT_CMD:-}" ]]; then
  if command -v claude >/dev/null 2>&1; then
    export NEONCORE_AGENT_CMD="$(command -v claude)"
    ok "Claude CLI: $NEONCORE_AGENT_CMD"
  else
    warn "Claude Code CLI ('claude') not found on PATH - cannot start a session."
    warn "Install it:  npm install -g @anthropic-ai/claude-code"
    warn "Then re-run this script."
    SKIP_RELAY=1
  fi
fi
echo

# --- Step 4: launch the relay -------------------------------------------------
echo "[4/4] Launching the relay..."
if [[ -n "$SKIP_RELAY" ]]; then
  info "Not launching. To start a session later, run:"
  info "  NEONCORE_URL=$SERVER_URL node \"$RELAY_JS\"   # from inside your repo"
else
  [[ -d "$REPO_PATH" ]] || die "Repo path does not exist: $REPO_PATH"
  ok "Starting Claude Code in $REPO_PATH - NeonCore can now dispatch to this session."
  info "Tip: relaunch anytime with:  NEONCORE_URL=$SERVER_URL node \"$RELAY_JS\""
  echo
  cd "$REPO_PATH"
  exec node "$RELAY_JS"
fi
