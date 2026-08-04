import os from 'node:os';

/**
 * Is this cartridge's repo on THIS server's filesystem?
 *
 * A cartridge registers with exactly one server, but it does not have to RUN on that
 * server's machine — a relay on another Mac registers straight into this DB and reports
 * its own `repo_path`. That path (`/Users/someone-else/Documents/Git/foo`) is perfectly
 * valid over there and does not exist here.
 *
 * Anything that touches an agent's repo with fs/git on this box must ask this first.
 * Skipping it is how "Cannot attach files: repo path does not exist (...)" got thrown for
 * a live, healthy cartridge whose only sin was running on the other laptop.
 */

/** Hostnames arrive both bare ("Mannys-Mac-Pro") and mDNS-suffixed ("Mannys-Mac-Pro.local"). */
export function normalizeHostname(host: string | null | undefined): string {
  return (host || '').trim().replace(/\.local$/i, '').toLowerCase();
}

/**
 * True when `machine` is this host. A blank machine is treated as local: rows predating the
 * column, and hand-inserted test fixtures, have always been served locally and must not
 * start failing now.
 */
export function isLocalMachine(machine: string | null | undefined): boolean {
  const norm = normalizeHostname(machine);
  if (!norm) return true;
  return norm === normalizeHostname(os.hostname());
}

/** Display label for an off-box cartridge — the bare hostname, never the foreign path. */
export function machineLabel(machine: string | null | undefined): string {
  return (machine || '').trim().replace(/\.local$/i, '') || 'another machine';
}
