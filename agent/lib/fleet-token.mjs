/**
 * The fleet token, for the relay and the runner.
 *
 * Same contract as agent/hooks/_fleet.py, deliberately: env NEONCORE_FLEET_TOKEN first so a
 * remote machine can point at another fleet, then the file the server publishes at
 * ~/.neoncore/token. These processes are started by launchd and by the runner, not by the
 * server, so nothing hands them the secret otherwise.
 *
 * `.mjs` rather than `.js`: agent/lib has no package.json of its own, so a bare .js would take
 * its module type from whatever package.json is found up the tree — which differs between the
 * repo and the installed ~/.neoncore/agent layout. The extension settles it in both places.
 *
 * Never throws. A relay that dies for want of a credential is worse than one that sends none:
 * in permissive mode the unauthenticated call still works and is logged, which is the whole
 * migration path this supports.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TOKEN_FILE = path.join(os.homedir(), '.neoncore', 'token');

export function fleetToken() {
  const env = (process.env.NEONCORE_FLEET_TOKEN || '').trim();
  if (env) return env;
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Headers to spread into a request. Empty when no token is configured. */
export function authHeaders() {
  const token = fleetToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
