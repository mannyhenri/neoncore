#!/usr/bin/env bash
#
# Installs the machine runner into a throwaway HOME — once from the runner zip, once from
# the repo checkout — and checks the result can actually run: every relative import of the
# installed runner and relay resolves, and the runner boots without crashing.
#
# Guards the failure where agent/lib was never installed: the runner and relay import
# '../lib/*.mjs', so an install without ~/.neoncore/lib died on start with
# ERR_MODULE_NOT_FOUND and launchd restarted it forever.
#
# Usage:  ./scripts/test-runner-install.sh      (needs node, npm, python3, unzip; uses the network for npm)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/neoncore-runner-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export npm_config_cache="${npm_config_cache:-$HOME/.npm}"  # the fake HOME would start an empty cache

FAILS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

# Every relative import reachable from the given entry files exists (symlinks followed, as Node does).
check_imports() { # label entry...
  local label="$1"; shift
  local missing
  missing="$(node --input-type=module -e '
    import fs from "fs"; import path from "path";
    const seen = new Set(), missing = [];
    const walk = (file) => {
      const real = fs.realpathSync(file);
      if (seen.has(real)) return; seen.add(real);
      const src = fs.readFileSync(real, "utf8");
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["\x27](\.{1,2}\/[^"\x27]+)["\x27]/g)) {
        const target = path.resolve(path.dirname(real), m[1]);
        if (fs.existsSync(target)) walk(target); else missing.push(`${file} -> ${m[1]}`);
      }
    };
    process.argv.slice(1).forEach(walk);
    console.log(missing.join("\n"));
  ' "$@")"
  if [[ -z "$missing" ]]; then pass "$label: all relative imports resolve"; else fail "$label: unresolved imports:"; echo "$missing" | sed 's/^/        /'; fi
}

# Runs setup.sh into a fresh HOME in foreground mode and checks the installed tree.
install_and_check() { # label setup.sh
  local label="$1" setup="$2"
  local home="$WORK/home-$label" log="$WORK/setup-$label.log"
  mkdir -p "$home/repo"
  echo "[$label] $setup"
  HOME="$home" bash "$setup" --server http://127.0.0.1:9 --token test --repo "$home/repo" --no-service >"$log" 2>&1 &
  local pid=$!
  # setup ends by exec'ing the runner; give npm install time, then the runner a few seconds.
  local waited=0
  until grep -q "Starting runner in the foreground" "$log" 2>/dev/null || ! kill -0 "$pid" 2>/dev/null || (( waited >= 300 )); do
    sleep 1; waited=$((waited + 1))
  done
  sleep 4
  if kill -0 "$pid" 2>/dev/null && ! grep -q "ERR_MODULE_NOT_FOUND" "$log"; then
    pass "$label: runner is still running after boot"
  else
    fail "$label: runner did not stay up — tail of $log:"; tail -6 "$log" | sed 's/^/        /'
  fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  check_imports "$label" "$home/.neoncore/runner/index.js" "$home/.neoncore/relay/index.js"
}

echo "== Building the runner zip"
bash "$ROOT/scripts/package-runner.sh" >/dev/null || { echo "package-runner.sh failed"; exit 1; }
unzip -q "$ROOT/dist/neoncore-runner.zip" -d "$WORK/zip"
check_imports "zip contents" "$WORK/zip/neoncore-runner/runner/index.js" "$WORK/zip/neoncore-runner/relay/index.js"

echo "== Installing"
install_and_check zip  "$WORK/zip/neoncore-runner/runner/setup.sh"
install_and_check repo "$ROOT/agent/runner/setup.sh"

echo
if (( FAILS )); then echo "$FAILS check(s) failed"; exit 1; fi
echo "All checks passed"
