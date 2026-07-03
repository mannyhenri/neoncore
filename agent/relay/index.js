#!/usr/bin/env node
/**
 * NeonCore agent relay
 * ====================
 * Launches an agent CLI (Claude Code by default) inside a pseudo-terminal that
 * THIS process owns, then connects to the NeonCore orchestrator over Socket.io
 * and types dispatched workflow commands straight into that PTY's stdin.
 *
 * Why this exists: the VS Code extension is the only client that opens an
 * addressed `agent:<id>` socket and injects commands into a specific window.
 * Without it, a bare-terminal `claude` session is a passive target — the server
 * queues commands as "pending" and nothing ever delivers them. This relay is
 * that missing client, with none of the editor: because it owns exactly one PTY,
 * delivery is perfectly addressed (1 relay = 1 agent = 1 PTY), so a dozen
 * windows each get only their own commands.
 *
 * Cross-platform: node-pty uses ConPTY on Windows and forkpty on macOS/Linux,
 * so this works everywhere — unlike the AppleScript "type into frontmost window"
 * fallback, which is macOS-only and can't target a specific window.
 *
 * Usage:
 *   node index.js                 # launches `claude` in the current repo
 *   node index.js -- --resume     # everything after `--` is passed to the agent
 *   NEONCORE_URL=http://host:4040 NEONCORE_AGENT_CMD=claude node index.js
 *
 * Env:
 *   NEONCORE_URL         orchestrator base URL (default http://localhost:4040)
 *   NEONCORE_AGENT_CMD   binary to launch (default "claude"; on Windows you may
 *                        need "claude.cmd")
 *   NEONCORE_AGENT_TYPE  agent type to register as (default "claude")
 *   NEONCORE_RELAY_DEBUG set to 1 to mirror relay logs to stderr (off by default
 *                        so they don't corrupt the agent's TUI)
 */

import { io } from 'socket.io-client';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// Self-heal the node-pty spawn-helper exec bit before importing node-pty — some
// prebuild extractions drop +x, which surfaces at runtime as "posix_spawnp
// failed". Harmless if already correct; no-op on Windows (ConPTY, no helper).
if (process.platform !== 'win32') {
  try {
    const prebuilds = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'node_modules', 'node-pty', 'prebuilds',
    );
    if (fs.existsSync(prebuilds)) {
      for (const dir of fs.readdirSync(prebuilds)) {
        const helper = path.join(prebuilds, dir, 'spawn-helper');
        if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
      }
    }
  } catch { /* non-fatal */ }
}

const { default: pty } = await import('node-pty');

// ── Config ────────────────────────────────────────────────────────────────
const URL = process.env.NEONCORE_URL || 'http://localhost:4040';
const AGENT_TYPE = process.env.NEONCORE_AGENT_TYPE || 'claude';
const AGENT_CMD = process.env.NEONCORE_AGENT_CMD || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
// Everything after a literal `--` is forwarded to the agent CLI.
const dashIdx = process.argv.indexOf('--');
const AGENT_ARGS = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];

// Bracketed-paste wrappers — let the agent TUI treat multi-line prompts as a
// single paste instead of submitting on the first embedded newline.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// ── Logging (file by default; the terminal belongs to the agent's TUI) ──────
const LOG_DIR = path.join(os.homedir(), '.neoncore');
const LOG_FILE = path.join(LOG_DIR, 'relay.log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  if (process.env.NEONCORE_RELAY_DEBUG === '1') process.stderr.write(line);
}

// ── Identity (mirrors the VS Code extension's getLocalIdentity) ─────────────
function getIdentity() {
  const cwd = process.cwd();
  let repoPath = cwd;
  let branch = '';
  try {
    repoPath = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim();
  } catch { /* not a git repo — keep cwd */ }
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
  } catch { /* ignore */ }
  return {
    machine: os.hostname(),
    repoPath,
    repoName: repoPath ? path.basename(repoPath) : '',
    branch,
  };
}

// ── Server calls ────────────────────────────────────────────────────────────
async function registerAgent(identity) {
  const res = await fetch(`${URL}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${identity.machine}/${identity.repoName}`,
      machine: identity.machine,
      repoPath: identity.repoPath,
      repoName: identity.repoName,
      branch: identity.branch,
      sessionId: `relay-${process.pid}`,
      agentType: AGENT_TYPE,
      status: 'idle',
    }),
  });
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
  const agent = await res.json();
  return agent.id;
}

function markDelivered(commandId) {
  fetch(`${URL}/api/commands/delivered/${commandId}`, { method: 'POST' })
    .catch((err) => log(`markDelivered failed: ${err}`));
}

async function drainPending(agentId, inject) {
  try {
    const res = await fetch(`${URL}/api/commands/pending/${agentId}`);
    const commands = await res.json();
    if (Array.isArray(commands) && commands.length > 0) {
      log(`Draining ${commands.length} pending command(s)`);
      for (const cmd of commands) inject(cmd);
    }
  } catch (err) {
    log(`drainPending failed: ${err}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const identity = getIdentity();
  log(`Starting relay: url=${URL} type=${AGENT_TYPE} cmd=${AGENT_CMD} repo=${identity.repoPath}`);

  // 1. Register first so the agent row + id exist before we join its socket room.
  let agentId;
  try {
    agentId = await registerAgent(identity);
    log(`Registered agent ${agentId}`);
  } catch (err) {
    process.stderr.write(`NeonCore relay: could not reach orchestrator at ${URL} — launching agent anyway.\n`);
    log(`registerAgent failed: ${err}`);
  }

  // 2. Spawn the agent CLI inside a PTY we own, and bridge it to this terminal.
  const ptyProc = pty.spawn(AGENT_CMD, AGENT_ARGS, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
  });

  ptyProc.onData((data) => process.stdout.write(data));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => ptyProc.write(data.toString('utf-8')));
  process.stdout.on('resize', () => ptyProc.resize(process.stdout.columns || 80, process.stdout.rows || 30));

  // Inject a dispatched command into the PTY as a bracketed paste, then submit.
  function inject(command) {
    if (!command || !command.text) return;
    log(`Injecting command ${command.id}: ${String(command.text).slice(0, 80)}`);
    ptyProc.write(PASTE_START + command.text + PASTE_END);
    // Small gap so the TUI finishes ingesting the paste before Enter submits it.
    setTimeout(() => ptyProc.write('\r'), 120);
    if (command.id) markDelivered(command.id);
  }

  // 3. Connect the addressed socket so the server can push commands to us.
  if (agentId) {
    const socket = io(URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 5000,
    });

    socket.on('connect', () => {
      log('Socket connected — joining agent room');
      // register_extension lands us in the path room; join_agent_room makes this
      // socket the primary for agent:<id>, which is where sendCommandToAgent emits.
      socket.emit('register_extension', { machine: identity.machine, repoPath: identity.repoPath, agentType: AGENT_TYPE });
      socket.emit('join_agent_room', { agentId });
      drainPending(agentId, inject); // catch anything queued while we were away
    });

    socket.on('command_send', (command) => {
      if (command.agentId && command.agentId !== agentId) {
        log(`Ignoring command for ${command.agentId} (we are ${agentId})`);
        return;
      }
      inject(command);
    });

    socket.on('connect_error', (err) => log(`Socket connect_error: ${err.message}`));

    process.on('exit', () => { try { socket.close(); } catch { /* ignore */ } });
  }

  // 4. Lifecycle: when the agent exits, tear the relay down with it.
  ptyProc.onExit(({ exitCode }) => {
    log(`Agent exited with code ${exitCode}`);
    cleanup();
    process.exit(exitCode || 0);
  });

  function cleanup() {
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
    process.stdin.pause();
  }

  // Tell the server this agent is dying so it can flag any in-flight workflow
  // step as interrupted immediately (fast path; the server's sweep backstops a
  // missed POST). Best-effort and fire-and-forget — on a hard kill it may not
  // land, which is exactly what the reconciler exists to cover.
  function reportInterrupted() {
    if (!agentId) return;
    fetch(`${URL}/api/agents/interrupted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, machine: identity.machine, repoPath: identity.repoPath, agentType: AGENT_TYPE }),
      keepalive: true,
    }).catch((err) => log(`reportInterrupted failed: ${err}`));
  }

  // Forward Ctrl-C etc. to the child (raw mode means we receive them as data),
  // but still clean up the terminal if we're killed directly. SIGTERM/SIGHUP are
  // the crash/kill signals (parent quit, machine going down) — report those as an
  // interrupt. SIGINT is a normal user Ctrl-C, so we don't treat it as a crash.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (sig !== 'SIGINT') reportInterrupted();
      try { ptyProc.kill(); } catch { /* ignore */ }
      cleanup();
    });
  }
}

main().catch((err) => {
  process.stderr.write(`NeonCore relay fatal: ${err}\n`);
  log(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
