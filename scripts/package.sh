#!/usr/bin/env bash
#
# Build the distributable NeonCore packages into dist/:
#
#   dist/neoncore-full.zip     the whole orchestrator (server + dashboard + installers + source)
#   dist/neoncore-runner.zip   connect a machine to an existing server (the machine runner)
#
# The old per-OS agent zips (neoncore-agent-*.zip) are retired — the runner supersedes them
# for connecting machines, and their source still ships inside neoncore-full.
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

# Retire any previously-built per-OS agent zips so dist/ only carries the current artifacts.
rm -f "$DIST/neoncore-agent-mac.zip" "$DIST/neoncore-agent-linux.zip" "$DIST/neoncore-agent-windows.zip"

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
    agent/bootstrap.sh agent/bootstrap.ps1 agent/README.md \
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

# --- Runner package: the per-machine daemon (delegated) -----------------------
bash "$ROOT/scripts/package-runner.sh"

echo "Done:"
ls -lh "$DIST"/*.zip
