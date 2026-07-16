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
import { spawn } from 'child_process';
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

/** Spawn the relay in a repo from the allowlist. Runs headless, logs to logs/. */
function launchCartridge({ repoPath, agentType, sessionId, context }) {
  const allowed = identity.repos.find((r) => r.path === repoPath);
  if (!allowed) {
    log(`Refused launch: ${repoPath} is not in the allowlist.`);
    return;
  }
  if (!fs.existsSync(repoPath)) {
    log(`Refused launch: ${repoPath} does not exist on disk.`);
    return;
  }

  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
  const logPath = path.join(LOG_DIR, `launch-${sessionId || Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');

  const env = {
    ...process.env,
    NEONCORE_URL: cfg.serverUrl,
    NEONCORE_AGENT_TYPE: agentType || 'claude',
    NEONCORE_SESSION_ID: sessionId || '',
    // Passed through for a future relay that types an initial prompt; not auto-injected yet.
    NEONCORE_LAUNCH_CONTEXT: context || '',
  };
  if (process.platform === 'win32' && (agentType || 'claude') === 'claude' && !env.NEONCORE_AGENT_CMD) {
    env.NEONCORE_AGENT_CMD = 'claude.cmd';
  }

  const child = spawn(process.execPath, [RELAY_LAUNCH], {
    cwd: repoPath,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.on('error', (err) => log(`launch spawn error: ${err.message}`));
  child.unref();
  log(`Launched ${agentType || 'claude'} in ${allowed.name} (${repoPath}) → ${logPath}`);
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

// Portal edited this machine's exposed folders. We stay the authority on what's real:
// keep only paths that exist on disk, persist to the config, and re-register.
socket.on('machine_set_repos', (payload) => {
  if (!payload || payload.machineId !== identity.machineId) return;
  const requested = Array.isArray(payload.repos) ? payload.repos : [];
  const valid = [];
  for (const r of requested) {
    if (!r || !r.path) continue;
    try {
      if (fs.existsSync(r.path) && fs.statSync(r.path).isDirectory()) {
        valid.push({ path: r.path, name: r.name || path.basename(r.path) || r.path });
      } else {
        log(`Ignoring folder that isn't a directory here: ${r.path}`);
      }
    } catch { log(`Ignoring unreadable folder: ${r.path}`); }
  }
  identity.repos = valid;
  cfg.repos = valid;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  } catch (err) {
    log(`Could not persist config: ${err.message}`);
  }
  register()
    .then(() => log(`Exposed folders updated → ${valid.length}`))
    .catch((err) => log(`re-register after repo update failed: ${err.message}`));
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
