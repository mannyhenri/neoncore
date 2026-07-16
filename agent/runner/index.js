/**
 * NeonCore machine runner — a persistent per-machine daemon.
 *
 * Runs once on a computer (e.g. your Windows box). It registers the machine with the
 * orchestrator, holds a Socket.io connection, and — on a `launch_cartridge` instruction
 * dispatched from the web/mobile portal — spawns the relay in the chosen repo. That's the
 * piece that lets you start a cartridge on THIS machine from somewhere else.
 *
 * It launches nothing on its own and only ever starts a cartridge in a directory from the
 * configured `repos` allowlist.
 *
 * Config: runner.config.json next to this file (copy runner.config.example.json), or a path
 * in NEONCORE_RUNNER_CONFIG. Cross-platform: Node built-ins + socket.io-client only; the
 * heavy lifting (node-pty) lives in the relay it spawns.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.NEONCORE_RUNNER_CONFIG || path.join(__dirname, 'runner.config.json');
const RELAY_LAUNCH = path.join(__dirname, '..', 'relay', 'launch.js');
const LOG_DIR = path.join(__dirname, 'logs');

function log(msg) {
  process.stdout.write(`[runner] ${msg}\n`);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    log(`No config at ${CONFIG_PATH}. Copy runner.config.example.json → runner.config.json and edit it.`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    log(`Config is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!cfg.serverUrl) {
    log('Config is missing "serverUrl".');
    process.exit(1);
  }
  // Assign a stable machine id on first run and persist it back.
  if (!cfg.machineId) {
    cfg.machineId = randomUUID();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    log(`Assigned machineId ${cfg.machineId} (saved to config).`);
  }
  cfg.serverUrl = String(cfg.serverUrl).replace(/\/+$/, '');
  cfg.hostname = cfg.hostname || os.hostname();
  cfg.repos = Array.isArray(cfg.repos) ? cfg.repos : [];
  return cfg;
}

const cfg = loadConfig();

const identity = {
  machineId: cfg.machineId,
  hostname: cfg.hostname,
  platform: process.platform,
  arch: process.arch,
  repos: cfg.repos.map((r) => ({
    path: r.path,
    name: r.name || path.basename(r.path) || r.path,
  })),
  token: cfg.token || '',
};

async function register() {
  const res = await fetch(`${cfg.serverUrl}/api/machines/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(identity),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`register failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * Launch a cartridge in a repo from the allowlist by opening a real terminal that runs the
 * relay. Using a terminal (vs. a headless background spawn) matters for two reasons:
 *   1. The runner often runs under launchd/systemd/Task Scheduler with a minimal PATH, so a
 *      headless spawn can't find `claude`/`node`. A terminal starts a LOGIN shell that sources
 *      the user's profile, restoring PATH.
 *   2. You can watch and type in the session locally, same as the old one-click launch.
 * The cartridge also registers back to the portal as usual.
 */
function launchCartridge({ repoPath, agentType, sessionId, context }) {
  const allowed = identity.repos.find((r) => r.path === repoPath);
  if (!allowed) { log(`Refused launch: ${repoPath} is not in the allowlist.`); return; }
  if (!fs.existsSync(repoPath)) { log(`Refused launch: ${repoPath} does not exist on disk.`); return; }

  const isWin = process.platform === 'win32';
  const nodeBin = process.execPath; // reliable node path even if PATH is thin
  const type = agentType || 'claude';
  const env = {
    NEONCORE_URL: cfg.serverUrl,
    NEONCORE_AGENT_TYPE: type,
    NEONCORE_SESSION_ID: sessionId || '',
    NEONCORE_LAUNCH_CONTEXT: context || '',
  };
  if (isWin && type === 'claude') env.NEONCORE_AGENT_CMD = 'claude.cmd';

  try {
    if (isWin) {
      const scriptPath = path.join(os.tmpdir(), `neoncore-launch-${Date.now()}.cmd`);
      fs.writeFileSync(scriptPath, [
        '@echo off',
        `cd /d "${repoPath}"`,
        ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`),
        `"${nodeBin}" "${RELAY_LAUNCH}"`,
      ].join('\r\n') + '\r\n');
      setTimeout(() => { try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } }, 60_000);
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', scriptPath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const scriptPath = path.join(os.tmpdir(), `neoncore-launch-${Date.now()}.sh`);
      fs.writeFileSync(scriptPath, [
        '#!/usr/bin/env bash',
        `cd ${JSON.stringify(repoPath)}`,
        ...Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
        // Source login files so PATH picks up claude/node even under launchd/systemd.
        '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null',
        '[ -f "$HOME/.zshrc" ]  && source "$HOME/.zshrc"  2>/dev/null',
        '[ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null',
        `"${nodeBin}" ${JSON.stringify(RELAY_LAUNCH)}`,
      ].join('\n') + '\n');
      fs.chmodSync(scriptPath, '755');
      setTimeout(() => { try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } }, 60_000);

      if (process.platform === 'darwin') {
        execSync(
          `osascript -e 'tell application "Terminal"' -e 'do script ${JSON.stringify(scriptPath)}' -e 'activate' -e 'end tell'`,
          { timeout: 8000 },
        );
      } else {
        const terms = [
          ['gnome-terminal', ['--', 'bash', scriptPath]],
          ['konsole', ['-e', `bash ${scriptPath}`]],
          ['xfce4-terminal', ['--command', `bash ${scriptPath}`]],
          ['xterm', ['-e', `bash ${scriptPath}`]],
        ];
        let opened = false;
        for (const [term, args] of terms) {
          try { execSync(`command -v ${term}`, { stdio: 'ignore', timeout: 1000 }); } catch { continue; }
          spawn(term, args, { detached: true, stdio: 'ignore' }).unref();
          opened = true;
          break;
        }
        if (!opened) throw new Error('no terminal emulator found (install gnome-terminal/konsole/xterm)');
      }
    }
    log(`Launched ${type} in ${allowed.name} (${repoPath}) — terminal opened`);
  } catch (err) {
    log(`Failed to open terminal for ${repoPath}: ${err.message}`);
  }
}

// ─── Connect + stay online ──────────────────────────────────────
const socket = io(cfg.serverUrl, { transports: ['websocket', 'polling'] });

async function announce() {
  try {
    await register();
    socket.emit('join_machine_room', { machineId: identity.machineId });
    log(`Registered "${identity.hostname}" with ${identity.repos.length} repo(s).`);
  } catch (err) {
    log(`register error: ${err.message} — will retry on next connect`);
  }
}

socket.on('connect', () => {
  log(`Connected to ${cfg.serverUrl}`);
  announce();
});
socket.on('disconnect', () => log('Disconnected — will reconnect'));
socket.on('connect_error', (err) => log(`connect_error: ${err.message}`));

socket.on('launch_cartridge', (payload) => {
  if (!payload || payload.machineId !== identity.machineId) return;
  log(`Launch request: ${payload.agentType} @ ${payload.repoPath}`);
  launchCartridge(payload);
});

// Keep only paths that are real directories here, normalize names.
function validateRepos(list) {
  const valid = [];
  for (const r of list || []) {
    if (!r || !r.path) continue;
    try {
      if (fs.existsSync(r.path) && fs.statSync(r.path).isDirectory()) {
        valid.push({ path: r.path, name: r.name || path.basename(r.path) || r.path });
      } else {
        log(`Ignoring folder that isn't a directory here: ${r.path}`);
      }
    } catch { log(`Ignoring unreadable folder: ${r.path}`); }
  }
  return valid;
}

// Persist the allowlist to config and re-register so the change lands server-side.
function persistAndRegister(repos, note) {
  identity.repos = repos;
  cfg.repos = repos;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  } catch (err) {
    log(`Could not persist config: ${err.message}`);
  }
  register().then(() => log(note)).catch((err) => log(`re-register failed: ${err.message}`));
}

// Portal edited this machine's exposed folders — replace the list with the validated set.
socket.on('machine_set_repos', (payload) => {
  if (!payload || payload.machineId !== identity.machineId) return;
  const valid = validateRepos(payload.repos);
  persistAndRegister(valid, `Exposed folders updated → ${valid.length}`);
});

// Portal asked to scan a folder on THIS machine: add every git repo directly under it,
// merged with what's already exposed (dedup by path).
socket.on('machine_scan', (payload) => {
  if (!payload || payload.machineId !== identity.machineId) return;
  const root = payload.root;
  try {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      log(`Scan: not a directory here: ${root}`);
      return;
    }
    const found = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(root, entry.name);
      if (fs.existsSync(path.join(p, '.git'))) found.push({ path: p, name: entry.name });
    }
    const byPath = new Map(identity.repos.map((r) => [r.path, r]));
    for (const r of found) byPath.set(r.path, r);
    const merged = [...byPath.values()];
    persistAndRegister(merged, `Scan ${root}: found ${found.length} git repo(s) → ${merged.length} total`);
  } catch (err) {
    log(`Scan failed for ${root}: ${err.message}`);
  }
});

// Heartbeat so the server's last_seen stays fresh even if it never disconnects.
setInterval(() => {
  if (socket.connected) socket.emit('machine_heartbeat', { machineId: identity.machineId });
}, 30_000);

log(`Starting runner for machine ${identity.machineId} (${identity.hostname}, ${identity.platform}/${identity.arch})`);

function shutdown() {
  log('Shutting down.');
  socket.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
