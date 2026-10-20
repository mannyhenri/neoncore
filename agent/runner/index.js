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
import { authHeaders } from '../lib/fleet-token.mjs';
import { ensureFolderTrusted } from '../lib/folder-trust.mjs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { findGitRepos, rescanRoots } from './scan.js';
import { acquireRunnerLock, refreshRunnerLock, releaseRunnerLock, lockPathFor } from './lock.js';
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
    // Strip a leading BOM: PowerShell 5.1's Set-Content -Encoding UTF8 (and Notepad)
    // prepend U+FEFF, which JSON.parse rejects outright. Without this the runner dies
    // on startup with "not valid JSON" and the machine never registers.
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^﻿/, ''));
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
  // Roots the user asked us to keep watching. Absent on configs written before rescanning
  // existed — those keep working, they just track nothing until the next Scan.
  cfg.scanRoots = Array.isArray(cfg.scanRoots) ? cfg.scanRoots : [];
  return cfg;
}

const cfg = loadConfig();

/** Directories re-scanned on a timer so hand-cloned repos appear by themselves. */
const scanRoots = cfg.scanRoots;

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

// ── One runner per machineId ───────────────────────────────
// Two daemons reading this config both answer every instruction the server sends — which is
// how one "+ Launch" click used to open two terminals. Whoever holds the lock keeps running;
// a second start exits instead of shadowing it. NEONCORE_RUNNER_ALLOW_MULTI=1 overrides.
const LOCK_PATH = lockPathFor(CONFIG_PATH, identity.machineId);
if (!process.env.NEONCORE_RUNNER_ALLOW_MULTI) {
  const lock = acquireRunnerLock({ lockPath: LOCK_PATH, machineId: identity.machineId });
  if (!lock.ok) {
    log(`Another runner (pid ${lock.holder.pid}) is already serving machine ${identity.machineId}.`);
    log(`Not starting a second one — it would double every launch. Stop that process first,`);
    log(`or set NEONCORE_RUNNER_ALLOW_MULTI=1 if you really want both.`);
    process.exit(0);
  }
}

async function register() {
  const res = await fetch(`${cfg.serverUrl}/api/machines/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
function launchCartridge({ repoPath, agentType, sessionId, context, resumeSessionId }) {
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
  // Native resume. Set ONLY when the portal is recovering a specific session — a cold launch
  // must not carry it, or the relay would try to resume a session that never existed. Both the
  // POSIX and Windows branches below serialize this same object, so one line covers both.
  if (resumeSessionId) env.NEONCORE_RESUME_SESSION_ID = resumeSessionId;
  if (isWin && type === 'claude') env.NEONCORE_AGENT_CMD = 'claude.cmd';

  // Before any terminal exists: a first-ever launch into this directory would otherwise stop
  // on Claude's folder-trust prompt, which defaults to "No, exit". Covers BOTH branches below.
  ensureFolderTrusted(repoPath);

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

      // `bash <script>`, not the bare path: a fresh executable waits on macOS's malware scan (and can be killed).
      if (process.platform === 'darwin') {
        execSync(
          `osascript -e 'tell application "Terminal"' -e 'do script ${JSON.stringify(`bash ${JSON.stringify(scriptPath)}`)}' -e 'activate' -e 'end tell'`,
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

let announceRetry = null;

async function announce() {
  // Join the room FIRST, and unconditionally. Room membership is the ONLY thing that makes
  // this machine launchable: the server's socketToMachine map is built here, and
  // isMachineOnline() reads nothing else.
  //
  // This used to sit AFTER `await register()`, inside the try. On a server restart the
  // socket reconnects in milliseconds while the HTTP endpoint is still coming up, so
  // register() threw, the room join never happened, and the machine was stranded offline
  // PERMANENTLY — its 30s heartbeat kept updating last_seen, so it looked alive in the
  // database while "+ Launch" refused to list it. "Retry on next connect" never fired
  // because the socket never disconnected again. Only restarting the runner fixed it.
  socket.emit('join_machine_room', { machineId: identity.machineId });

  if (announceRetry) { clearTimeout(announceRetry); announceRetry = null; }

  try {
    await register();
    log(`Registered "${identity.hostname}" with ${identity.repos.length} repo(s).`);
  } catch (err) {
    // Retry on a timer rather than waiting for a reconnect that may never come.
    log(`register error: ${err.message} — retrying in 5s`);
    announceRetry = setTimeout(announce, 5000);
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
    // Remember the root. Scanning used to be a ONE-TIME snapshot, which is why a repo
    // cloned into the folder afterwards never showed up in "+ Launch" — the folder was
    // never actually watched, despite being presented that way.
    if (!scanRoots.includes(root)) {
      scanRoots.push(root);
      cfg.scanRoots = scanRoots;
    }
    const found = findGitRepos(root);
    const { repos } = rescanRoots({ existing: identity.repos, roots: scanRoots });
    persistAndRegister(repos, `Scan ${root}: found ${found.length} git repo(s) → ${repos.length} total (root now tracked)`);
  } catch (err) {
    log(`Scan failed for ${root}: ${err.message}`);
  }
});

/**
 * Re-scan the tracked roots so repos cloned by hand appear on their own.
 *
 * Quiet by design: it re-registers only when the set actually changed, so a stable machine
 * costs the server nothing. RESCAN_MS is minutes, not seconds — a new clone showing up
 * within a couple of minutes is indistinguishable from instant in practice, and polling
 * hard would put a readdir on every root of every machine constantly.
 */
// Overridable so an operator can verify the behaviour immediately instead of waiting out
// the default interval.
const RESCAN_MS = Number(process.env.NEONCORE_RESCAN_MS) || 2 * 60 * 1000;
setInterval(() => {
  if (scanRoots.length === 0) return;
  try {
    const { repos, changed } = rescanRoots({ existing: identity.repos, roots: scanRoots });
    if (!changed) return;
    const before = identity.repos.length;
    persistAndRegister(repos, `Rescan: ${before} → ${repos.length} folder(s) across ${scanRoots.length} tracked root(s)`);
  } catch (err) {
    log(`Rescan failed: ${err.message}`);
  }
}, RESCAN_MS);

// Heartbeat so the server's last_seen stays fresh even if it never disconnects. The same tick
// refreshes the single-instance lock: a holder that stops checking in is treated as gone, so
// a runner killed with -9 never blocks the next start.
setInterval(() => {
  if (socket.connected) socket.emit('machine_heartbeat', { machineId: identity.machineId });
  if (!process.env.NEONCORE_RUNNER_ALLOW_MULTI) {
    refreshRunnerLock({ lockPath: LOCK_PATH, machineId: identity.machineId });
  }
}, 30_000);

log(`Starting runner for machine ${identity.machineId} (${identity.hostname}, ${identity.platform}/${identity.arch})`);

function shutdown() {
  log('Shutting down.');
  if (!process.env.NEONCORE_RUNNER_ALLOW_MULTI) releaseRunnerLock({ lockPath: LOCK_PATH });
  socket.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
