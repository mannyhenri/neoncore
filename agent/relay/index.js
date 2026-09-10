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
 *   NEONCORE_RELAY_PROTECT
 *                        set to 1 for user terminal sessions; ignores stray
 *                        SIGTERM from broad external cleanup commands while
 *                        still honoring SIGHUP/exit when the terminal closes
 *   NEONCORE_RELAY_DEBUG set to 1 to mirror relay logs to stderr (off by default
 *                        so they don't corrupt the agent's TUI)
 */

import { io } from 'socket.io-client';
import { randomBytes } from 'node:crypto';
import os from 'os';
import { authHeaders } from '../lib/fleet-token.mjs';
import { resumeArgsFor, canVerifyTranscript, transcriptExists } from './resume-args.mjs';
import { codexArgsForMode } from './codex-mode.mjs';
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
const PROTECT_RELAY = process.env.NEONCORE_RELAY_PROTECT === '1';
// When the exact binary isn't pinned via NEONCORE_AGENT_CMD, derive it from the
// agent type. The relay-launched engines (claude, codex, gridlight) each name
// their CLI after the type, so a `codex` launch spawns `codex` — not claude.
// Without this, any non-claude type whose launcher forgot to set AGENT_CMD (e.g.
// the runner, which only sets AGENT_TYPE) would silently fall back to `claude`.
const AGENT_CMD = process.env.NEONCORE_AGENT_CMD
  || (process.platform === 'win32' ? `${AGENT_TYPE}.cmd` : AGENT_TYPE);
// Everything after a literal `--` is forwarded to the agent CLI.
const dashIdx = process.argv.indexOf('--');
const EXPLICIT_ARGS = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];

// Native session resume. NEONCORE_RESUME_SESSION_ID is set only when a launcher is RECOVERING
// a specific session — never on an ordinary cold start. It is deliberately NOT
// NEONCORE_SESSION_ID, which carries synthetic labels like `neoncore-claude-1757...` on every
// normal launch and would turn each of them into a resume against a session that never existed.
//
// The resume args go FIRST so an explicit `-- <args>` from the caller can still override or
// extend them, and an already-explicit `--resume` wins rather than being duplicated.
const RESUME_SESSION_ID = (process.env.NEONCORE_RESUME_SESSION_ID || '').trim();
const alreadyResuming = EXPLICIT_ARGS.some((a) => a === '--resume' || a === 'resume');

// THE RELAY HAS THE VETO. The server proposes a session id from what the hooks last reported,
// but only this process is on the disk that holds the transcript. Resuming one that has been
// deleted or rotated exits the CLI with an unknown-session error and leaves a dead terminal —
// worse than the cold start it replaced, and the very failure that made native resume distrusted
// in the first place. Checked ONLY where verification is possible: an engine whose layout we do
// not model is trusted rather than blocked, or no codex session could ever resume.
const transcriptMissing = Boolean(RESUME_SESSION_ID)
  && canVerifyTranscript(AGENT_TYPE)
  && !transcriptExists(AGENT_TYPE, process.cwd(), RESUME_SESSION_ID);

const resumeArgs = (alreadyResuming || transcriptMissing)
  ? null
  : resumeArgsFor(AGENT_TYPE, RESUME_SESSION_ID);
const BASE_AGENT_ARGS = resumeArgs ? [...resumeArgs, ...EXPLICIT_ARGS] : EXPLICIT_ARGS;

// Reported at spawn time, not here: `log()` writes to LOG_FILE, which is a `const` declared
// further down this module — calling it now is a temporal-dead-zone crash.
const RESUME_DOWNGRADED = Boolean(RESUME_SESSION_ID) && !resumeArgs && !alreadyResuming;

// Bracketed-paste wrappers — let the agent TUI treat multi-line prompts as a
// single paste instead of submitting on the first embedded newline.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Enter-submission tuning (see inject()). The Enter is decoupled from the paste
// because the TUI needs a beat to finish ingesting a bracketed paste before a `\r`
// submits it rather than being absorbed as a literal newline. The old fixed 120ms
// gap lost that race for large prompts — the paste landed but the Enter got
// swallowed, so nothing sent. We now scale the first Enter to the payload size and
// fire a backstop Enter afterward. Overridable via env for tuning.
// ADX-002 — the messaging token for our PTY child's addressed inbox.
//
// MINTED HERE, NOT READ FROM THE CHILD. ADX-001 proved the obvious approach is
// impossible: `ps eww` does expose a same-uid process's environment on macOS, so
// reading it out of the child LOOKS viable, but what ps shows is the EXEC-TIME
// environment and claude generates its token after exec. Measured on a live
// relay-owned session: 47 vars visible, MESSAGING_TOKEN absent — while a child
// OF claude sees it, because claude adds it for processes it spawns. The
// direction is the trap.
//
// So we choose the value and inject it below at pty.spawn, which is an
// environment this process already controls. The relay then knows the token by
// construction rather than by discovery.
//
// An operator-supplied value wins, so a session launched inside an existing
// messaging context is not silently re-keyed.
const INBOX_TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN
  || randomBytes(32).toString('hex');

const ENTER_BASE_MS = Number(process.env.NEONCORE_RELAY_ENTER_MS) || 150;
const ENTER_CHARS_PER_MS = 8;   // +1ms of pre-Enter wait per 8 chars pasted
const ENTER_MAX_MS = 1500;      // cap on the scaled first-Enter delay
const ENTER_BACKSTOP_MS = Number(process.env.NEONCORE_RELAY_ENTER_BACKSTOP_MS) || 450;

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
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      name: `${identity.machine}/${identity.repoName}`,
      machine: identity.machine,
      repoPath: identity.repoPath,
      repoName: identity.repoName,
      branch: identity.branch,
      // On a RESUME we already know the real session id — registering `relay-<pid>` would
      // display a placeholder for the session we deliberately came back as, until the first
      // hook fired and corrected it. On a cold start there is genuinely nothing to name yet,
      // so the pid label stands until the hooks report the session Claude Code assigns.
      sessionId: resumeArgs ? RESUME_SESSION_ID : `relay-${process.pid}`,
      agentType: AGENT_TYPE,
      status: 'idle',
    }),
  });
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
  return await res.json();
}

// Tell the server which socket addresses this cartridge: /tmp/cc-socks/<pid>.sock,
// plus the token that names us on platforms that require one. The token is never
// logged — it is a credential with the lifetime of this session, and a log file is
// plain text that outlives it and gets quoted into bug reports.
async function reportInbox(pid) {
  if (!pid) return;
  try {
    const res = await fetch(`${URL}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        name: `${identityForInbox.machine}/${identityForInbox.repoName}`,
        machine: identityForInbox.machine,
        repoPath: identityForInbox.repoPath,
        repoName: identityForInbox.repoName,
        branch: identityForInbox.branch,
        agentType: AGENT_TYPE,
        inboxPid: pid,
        inboxToken: INBOX_TOKEN,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`Reported inbox pid ${pid}`);
  } catch (err) {
    log(`reportInbox failed: ${err}`);
  }
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
// reportInbox runs after spawn and needs the same identity the registration used.
let identityForInbox = { machine: '', repoPath: '', repoName: '', branch: '' };

async function main() {
  const identity = getIdentity();
  identityForInbox = identity;
  log(`Starting relay: url=${URL} type=${AGENT_TYPE} cmd=${AGENT_CMD} repo=${identity.repoPath}`);

  // 1. Register first so the agent row + id exist before we join its socket room.
  let agentId;
  let initialMode = 'manual';
  try {
    const registered = await registerAgent(identity);
    agentId = registered.id;
    initialMode = registered.mode || 'manual';
    log(`Registered agent ${agentId}`);
  } catch (err) {
    process.stderr.write(`NeonCore relay: could not reach orchestrator at ${URL} — launching agent anyway.\n`);
    log(`registerAgent failed: ${err}`);
  }

  // Say a downgrade out loud. A silent fall back to a cold session is the failure this whole
  // path exists to end: the cartridge comes back looking healthy with none of its context, and
  // nobody finds out until it answers as if the last three hours never happened.
  if (transcriptMissing) {
    log(`Resume requested for ${RESUME_SESSION_ID} but no ${AGENT_TYPE} transcript for it exists `
      + `under ${process.cwd()} — starting a fresh session rather than a terminal that dies on `
      + 'an unknown session id.');
  } else if (RESUME_DOWNGRADED) {
    log(`Resume requested for ${RESUME_SESSION_ID} but ${AGENT_TYPE} has no native resume — `
      + 'starting a fresh session; NeonCore transcript replay is the fallback.');
  } else if (resumeArgs) {
    log(`Resuming ${AGENT_TYPE} session ${RESUME_SESSION_ID} (${resumeArgs.join(' ')})`);
  }

  // 2. Spawn the agent CLI inside a PTY we own, and bridge it to this terminal.
  let ptyProc;
  let pendingCodexRestart;
  const spawnAgent = (mode, sessionId = '') => {
    const args = AGENT_TYPE === 'codex'
      ? codexArgsForMode(BASE_AGENT_ARGS, mode, sessionId)
      : BASE_AGENT_ARGS;
    const proc = pty.spawn(AGENT_CMD, args, {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 30,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN },
    });
    ptyProc = proc;
    proc.onData((data) => process.stdout.write(data));
    proc.onExit(({ exitCode }) => {
      if (proc !== ptyProc) return;
      log(`Agent exited with code ${exitCode}`);
      cleanup();
      process.exit(exitCode || 0);
    });
    reportInbox(proc.pid);
    return proc;
  };

  spawnAgent(initialMode, resumeArgs ? RESUME_SESSION_ID : '');

  // Report the addressed inbox now that a child — and therefore a pid — exists.
  //
  // This cannot ride on the first registration above: that runs BEFORE spawn, on
  // purpose, so the agent row and id exist before we join the socket room. There
  // is no child at that moment, so a pid in that payload could only be undefined.
  //
  // Fire-and-forget: the relay's job is to run the agent. A server that is down
  // must not stop a cartridge from starting, and the next hook-driven register
  // re-reports the same values.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => ptyProc?.write(data.toString('utf-8')));
  process.stdout.on('resize', () => ptyProc?.resize(process.stdout.columns || 80, process.stdout.rows || 30));

  // Inject a dispatched command into the PTY as a bracketed paste, then submit.
  // The submit is a scaled-delay Enter plus a backstop Enter: a plain Enter on an
  // already-submitted (empty) Claude Code prompt is a harmless no-op, so the second
  // press costs nothing when the first worked but rescues the case where the first
  // was swallowed because the TUI hadn't finished ingesting the paste yet.
  function inject(command) {
    if (!command || !command.text) return;
    const text = String(command.text);
    log(`Injecting command ${command.id}: ${text.slice(0, 80)}`);
    ptyProc.write(PASTE_START + text + PASTE_END);
    const firstMs = Math.min(ENTER_MAX_MS, ENTER_BASE_MS + Math.floor(text.length / ENTER_CHARS_PER_MS));
    const submit = () => { try { ptyProc.write('\r'); } catch { /* PTY may have closed */ } };
    setTimeout(submit, firstMs);
    setTimeout(submit, firstMs + ENTER_BACKSTOP_MS);
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

    socket.on('agent_mode_changed', ({ agentId: changedId, mode, sessionId }) => {
      if (AGENT_TYPE !== 'codex' || changedId !== agentId) return;
      log(`Applying Codex ${mode} permissions by restarting and resuming the session`);
      pendingCodexRestart = { mode, sessionId: sessionId || '' };
      const previous = ptyProc;
      if (!previous) return;
      ptyProc = undefined;
      previous.onExit(() => {
        const next = pendingCodexRestart;
        pendingCodexRestart = undefined;
        if (next) spawnAgent(next.mode, next.sessionId);
      });
      try {
        previous.kill();
      } catch {
        const next = pendingCodexRestart;
        pendingCodexRestart = undefined;
        if (next) spawnAgent(next.mode, next.sessionId);
      }
    });

    socket.on('connect_error', (err) => log(`Socket connect_error: ${err.message}`));

    process.on('exit', () => { try { socket.close(); } catch { /* ignore */ } });
  }

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
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ agentId, machine: identity.machine, repoPath: identity.repoPath, agentType: AGENT_TYPE }),
      keepalive: true,
    }).catch((err) => log(`reportInterrupted failed: ${err}`));
  }

  // Forward Ctrl-C etc. to the child (raw mode means we receive them as data),
  // but still clean up the terminal if we're killed directly. SIGHUP means the
  // terminal actually closed. SIGTERM is usually a supervisor stop, but some
  // external cleanup scripts use broad `pkill -f` patterns; protected terminal
  // relays ignore those so a Gridlight-side cleanup cannot tear down unrelated
  // Claude/Codex sessions.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (sig === 'SIGTERM' && PROTECT_RELAY) {
        log('Ignoring SIGTERM because NEONCORE_RELAY_PROTECT=1');
        return;
      }
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
