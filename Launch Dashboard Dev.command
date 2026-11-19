#!/bin/bash
# NeonCore — the dashboard in DEV mode (live reload), against your RUNNING NeonCore server.
#
# This starts ONLY the dashboard (Vite dev server on port 4141). It does not start a
# second NeonCore server and does not touch any database: the dashboard talks to the server
# already running on http://localhost:4040, so you see your real cartridges in the scene.
# Anything you do in it (approve, send a command) is real, exactly as in the normal dashboard.
#
# Double-click this file in Finder, or run it from a terminal. Ctrl+C stops it.
set -e
cd "$(dirname "$0")"

# Use the Node version the repo pins, when nvm is installed.
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use >/dev/null 2>&1 || true; fi

if [ ! -d node_modules/vite ]; then
  echo "First run: installing the dashboard's dependencies (about a minute)…"
  npm install --workspace=dashboard --workspace=packages/client --no-audit --no-fund
fi

if ! curl -s -o /dev/null --max-time 2 http://localhost:4040/api/health; then
  echo
  echo "NOTE: no NeonCore server answered on http://localhost:4040."
  echo "      The page will sit on 'Connecting to orchestrator…' until one is running."
  echo
fi

PORT=4141
( sleep 4; open "http://localhost:$PORT" ) &
echo "NeonCore dashboard (dev) → http://localhost:$PORT   (Ctrl+C to stop)"
npm run dev --workspace=dashboard -- --port "$PORT" --strictPort
