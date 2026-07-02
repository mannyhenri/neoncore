#!/usr/bin/env bash
#
# Build the distributable NeonCore packages into dist/:
#
#   dist/neoncore-agent-mac.zip      connect a Mac/Linux machine to an existing server
#   dist/neoncore-agent-windows.zip  connect a Windows machine to an existing server
#   dist/neoncore-full.zip           the whole orchestrator (server + dashboard + installers)
#
# dist/ and *.zip are gitignored - these are build artifacts. Upload them to a
# GitHub Release (or share directly) to distribute. Regenerate anytime with:
#
#   ./scripts/package.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
BUILD="$DIST/.build"
AGENT="$ROOT/agent"

rm -rf "$BUILD"
mkdir -p "$DIST" "$BUILD"

echo "Packaging into $DIST ..."

# --- Agent package: Mac / Linux ----------------------------------------------
mac="$BUILD/neoncore-agent"
rm -rf "$mac"; mkdir -p "$mac"
rsync -a --exclude node_modules --exclude __pycache__ --exclude '*.pyc' \
  --exclude '.DS_Store' --exclude 'bootstrap.ps1' "$AGENT"/ "$mac"/
rm -f "$DIST/neoncore-agent-mac.zip"
( cd "$BUILD" && zip -rq "$DIST/neoncore-agent-mac.zip" neoncore-agent )
rm -rf "$mac"

# --- Agent package: Windows ---------------------------------------------------
win="$BUILD/neoncore-agent"
rm -rf "$win"; mkdir -p "$win"
rsync -a --exclude node_modules --exclude __pycache__ --exclude '*.pyc' \
  --exclude '.DS_Store' --exclude 'bootstrap.sh' --exclude 'install.sh' "$AGENT"/ "$win"/
rm -f "$DIST/neoncore-agent-windows.zip"
( cd "$BUILD" && zip -rq "$DIST/neoncore-agent-windows.zip" neoncore-agent )
rm -rf "$win"

# --- Full package: server + dashboard + installers (source only) --------------
# Source snapshot = git-tracked files (current working-tree content, so uncommitted
# edits are included) + the new untracked installer/bootstrap files. Using the
# tracked list guarantees no local junk, DB, secrets, or build output leak in.
full="$BUILD/neoncore"
rm -rf "$full"; mkdir -p "$full"

{
  ( cd "$ROOT" && git ls-files )
  printf '%s\n' \
    install-neoncore.sh install-neoncore.ps1 \
    scripts/package.sh \
    agent/bootstrap.sh agent/bootstrap.ps1 \
    INSTALL.md FEATURES.md
} | sort -u | while read -r f; do
  [[ -f "$ROOT/$f" ]] || continue
  mkdir -p "$full/$(dirname "$f")"
  cp -p "$ROOT/$f" "$full/$f"
done

rm -f "$DIST/neoncore-full.zip"
( cd "$BUILD" && zip -rq "$DIST/neoncore-full.zip" neoncore )
rm -rf "$full"

rm -rf "$BUILD"

echo "Done:"
ls -lh "$DIST"/*.zip
