#!/usr/bin/env node
/**
 * NeonCore relay bootstrap — cross-platform one-click launcher.
 *
 * Runs BEFORE the relay's dependencies are guaranteed to exist, so it uses only
 * Node built-ins. It performs the setup the old bash launcher did, but portably
 * (macOS / Linux / Windows), then hands off to the relay:
 *
 *   1. Install the relay's npm deps on first use (node-pty, socket.io-client).
 *   2. Best-effort install NeonCore hooks if not already present.
 *   3. Spawn the relay (index.js) with stdio inherited, in the ORIGINAL cwd
 *      (the cartridge/repo directory), so the agent registers for the right repo.
 *
 * Invoked by the dashboard's one-click cartridge launch as: `node launch.js`.
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const isWin = process.platform === 'win32';
const relayDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(relayDir, '..', '..');
// The hooks installer lives at agent/install.py. In the repo it's two levels up
// (<repo>/agent/relay → <repo>/agent); in the runner install it's a sibling of the relay
// (~/.neoncore/relay → ~/.neoncore/agent). Try both.
const installScript = [
  path.join(repoRoot, 'agent', 'install.py'),
  path.resolve(relayDir, '..', 'agent', 'install.py'),
].find((p) => existsSync(p)) || path.join(repoRoot, 'agent', 'install.py');
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function log(msg) { process.stdout.write(`[NeonCore] ${msg}\n`); }

// 1. Relay dependencies (node-pty needs a one-time install/build).
if (!existsSync(path.join(relayDir, 'node_modules'))) {
  log('Installing relay dependencies (first run)...');
  const r = spawnSync(npmCmd, ['install'], { cwd: relayDir, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    process.stderr.write('[NeonCore] relay dependency install failed — see output above.\n');
    process.exit(r.status || 1);
  }
}

// 2. Hooks (best-effort): gives status/activity/permission gating. Skip if present.
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
let hooksPresent = false;
try {
  hooksPresent = existsSync(settingsPath) && readFileSync(settingsPath, 'utf-8').includes('neoncore');
} catch { /* ignore */ }

if (!hooksPresent && existsSync(installScript)) {
  log('Installing NeonCore hooks...');
  // python3 on macOS/Linux; try python3 then python on Windows.
  const pythons = isWin ? ['python', 'python3'] : ['python3', 'python'];
  for (const py of pythons) {
    const r = spawnSync(py, [installScript], { stdio: 'inherit', env: process.env, shell: isWin });
    if (r.error && r.error.code === 'ENOENT') continue; // try next interpreter
    break;
  }
}

// 2b. Register the NeonCore MCP server for THIS repo so Claude agents get the
// coordination + confer tools (neoncore_message_agent / neoncore_read_agent). MCP
// connects at session start, so it must be wired BEFORE the agent spawns. Idempotent:
// merges our entry and leaves any others. Best-effort — never blocks launch.
const launchType = process.env.NEONCORE_AGENT_TYPE || 'claude';
if (launchType === 'claude') {
  try {
    const mcpServerJs = [
      path.join(repoRoot, 'server', 'dist', 'mcp-server.js'),
      path.resolve(relayDir, '..', 'server', 'dist', 'mcp-server.js'),
    ].find((p) => existsSync(p));
    if (mcpServerJs) {
      const mcpPath = path.join(process.cwd(), '.mcp.json');
      let cfg = {};
      try { if (existsSync(mcpPath)) cfg = JSON.parse(readFileSync(mcpPath, 'utf-8')); } catch { cfg = {}; }
      if (!cfg || typeof cfg !== 'object') cfg = {};
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.neoncore = {
        command: 'node',
        args: [mcpServerJs],
        env: {
          NEONCORE_URL: process.env.NEONCORE_URL || 'http://localhost:4040',
          NEONCORE_AGENT_TYPE: 'claude',
        },
      };
      writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n');
      log('Registered NeonCore MCP server for this repo (confer + coordination tools).');
    } else {
      log('NeonCore MCP server build not found — run `npm run build` in server/ to enable confer tools.');
    }
  } catch { /* best-effort — never block launch */ }
}

// 3. Launch the relay in the user's current directory.
log(`Launching NeonCore relay (${launchType})...`);
const extraArgs = process.argv.slice(2);
const child = spawn(process.execPath, [path.join(relayDir, 'index.js'), ...extraArgs], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  process.stderr.write(`[NeonCore] failed to launch relay: ${err}\n`);
  process.exit(1);
});
