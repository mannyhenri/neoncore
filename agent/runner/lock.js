/**
 * Single-instance guard for the machine runner.
 *
 * The runner's identity is its machineId, read from runner.config.json — so two processes
 * reading that file are two daemons wearing ONE identity. That is not hypothetical: the
 * installed launchd/systemd service plus a leftover `node index.js` from a manual start is
 * the normal way to end up with it, and the second one keeps running long after the terminal
 * that started it is closed. Both then answer every instruction the server sends, so one
 * "+ Launch" click opened two terminals.
 *
 * The server now addresses one socket per machine, which stops the double terminal. This
 * stops the duplicate itself — the duplicate also doubles registrations, heartbeats and
 * config writes (two processes writing runner.config.json is a lost-update race).
 *
 * The rules are deliberately biased toward starting: a runner that refuses to start is worse
 * than one duplicate, because a service manager will just retry it forever. A lock is only
 * honoured when its holder is alive AND has checked in recently.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

/** A holder that hasn't refreshed in this long is treated as gone (SIGKILL, reused pid). */
export const LOCK_STALE_MS = 3 * 60 * 1000;

/** Where the lock for a machineId lives: beside its config, so two configs never collide. */
export function lockPathFor(configPath, machineId) {
  return path.join(path.dirname(configPath), `.runner-${machineId}.lock`);
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, delivers nothing
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return err.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (!raw || typeof raw.pid !== 'number') return null;
    return raw;
  } catch {
    return null; // absent or corrupt — nobody holds it
  }
}

function writeLock(lockPath, record) {
  fs.writeFileSync(lockPath, JSON.stringify(record) + '\n');
}

/**
 * Take the lock for this machineId, or report who holds it.
 *
 * @returns {{ ok: true } | { ok: false, holder: { pid: number, ts: number } }}
 */
export function acquireRunnerLock({
  lockPath,
  machineId,
  pid = process.pid,
  now = Date.now(),
  isAlive = defaultIsAlive,
  staleMs = LOCK_STALE_MS,
}) {
  const held = readLock(lockPath);
  const takeable =
    !held ||
    held.pid === pid ||                 // us (a restart that reused the pid is still us)
    held.machineId !== machineId ||     // a different identity has no claim on this one
    !isAlive(held.pid) ||               // holder is gone
    now - (held.ts ?? 0) > staleMs;     // holder stopped checking in

  if (!takeable) return { ok: false, holder: { pid: held.pid, ts: held.ts ?? 0 } };

  writeLock(lockPath, { pid, machineId, hostname: os.hostname(), ts: now });
  return { ok: true };
}

/** Prove we're still here. Called on the heartbeat so the lock can't go stale under us. */
export function refreshRunnerLock({ lockPath, machineId, pid = process.pid, now = Date.now() }) {
  try {
    const held = readLock(lockPath);
    if (held && held.pid !== pid) return false; // someone else owns it now — don't stomp
    writeLock(lockPath, { pid, machineId, hostname: os.hostname(), ts: now });
    return true;
  } catch {
    return false;
  }
}

/** Drop the lock on a clean shutdown, but never one we don't own. */
export function releaseRunnerLock({ lockPath, pid = process.pid }) {
  try {
    const held = readLock(lockPath);
    if (held && held.pid === pid) fs.unlinkSync(lockPath);
  } catch { /* best-effort */ }
}
