/**
 * Fleet authentication — one shared secret, three directions.
 *
 * The same token authenticates client→server (web, iOS), server→server (gossip) and
 * agent→server (hooks, relay, runner). One secret rather than three keeps the peer list
 * free of credentials: a peer entry is just a URL, so gossiping it leaks nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROLLOUT HAZARD — read before changing the default mode.
 *
 * Turning auth on is a fleet-wide, silent, self-inflicted outage waiting to happen.
 * Every hook script, relay and runner already deployed on every machine sends no
 * Authorization header. Flip straight to strict and all of them 401 at once: agents stop
 * registering, activity stops flowing, and the grid simply goes quiet. Nothing crashes,
 * so nothing obviously points at auth.
 *
 * Hence PERMISSIVE is the default:
 *
 *   permissive (default)
 *     valid token   → allow
 *     NO header     → allow, and log loudly with the caller's IP so you can go update it
 *     WRONG token   → 401
 *
 *   strict (flip once the log goes quiet)
 *     no / wrong    → 401
 *
 * Only an ABSENT header is grandfathered. A WRONG token is always rejected, in both
 * modes — grandfathering that would mean any wrong guess is as good as the real secret,
 * which is not authentication at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import db from '../db.js';

export type AuthMode = 'permissive' | 'strict';

/** Settings keys. `fleet_token` is a SECRET — see SECRET_SETTING_KEYS below. */
const TOKEN_KEY = 'fleet_token';
const MODE_KEY = 'fleet_auth_mode';

/**
 * Settings that must never be returned by GET /api/settings.
 *
 * That endpoint dumps the whole table, so anything stored here is readable by any caller
 * that can reach it — and in permissive mode that includes an *unauthenticated* caller.
 * Without this redaction, enabling auth would publish the very credential it installs:
 * read the token from the open endpoint, then present it and be fully authorised.
 *
 * `machine_pairing_token` has the same problem and predates federation; it is redacted
 * here too rather than left as a known hole.
 */
export const SECRET_SETTING_KEYS = new Set([TOKEN_KEY, 'machine_pairing_token']);

function readSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value?.trim() || null;
}

function writeSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

/** The configured fleet token, or null if none has been generated yet. */
export function getFleetToken(): string | null {
  return process.env.NEONCORE_FLEET_TOKEN?.trim() || readSetting(TOKEN_KEY);
}

/**
 * Generate the fleet token on first launch and print it loudly.
 *
 * Returns the token and whether it was created now, so the caller can decide how noisy
 * to be. A silently-generated secret nobody ever saw is useless: the whole point is that
 * you can copy it onto the next machine.
 */
export function ensureFleetToken(): { token: string; generated: boolean } {
  const existing = getFleetToken();
  if (existing) return { token: existing, generated: false };

  const token = randomBytes(32).toString('base64url');
  writeSetting(TOKEN_KEY, token);
  return { token, generated: true };
}

export function getAuthMode(): AuthMode {
  const raw = (process.env.NEONCORE_AUTH_MODE?.trim() || readSetting(MODE_KEY) || '').toLowerCase();
  return raw === 'strict' ? 'strict' : 'permissive';
}

export function setAuthMode(mode: AuthMode): void {
  writeSetting(MODE_KEY, mode);
}

/** Constant-time compare. Length is compared first because timingSafeEqual throws on a mismatch. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the bearer token off the request. Returns null when no credential was offered at all. */
function presentedToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
    return header.trim(); // tolerate a bare token — a wrong shape is still an attempt
  }
  return null;
}

/**
 * Paths that never require auth.
 *
 * TWO separate exemptions, for two different reasons:
 *
 * 1. Anything that is not /api — the dashboard's own HTML, JS, CSS and the SPA fallback.
 *    A browser fetching index.html has nowhere to put a bearer token; gating static
 *    assets would mean the web app could not load far enough to authenticate itself.
 *    The app is not the secret — the API behind it is.
 *
 * 2. /api/health — it is how a peer decides whether this server is reachable at all, how
 *    the port-conflict check in index.ts identifies a sibling NeonCore, and how you debug
 *    a fleet that has gone quiet. Gating it behind the credential you are trying to
 *    diagnose is precisely backwards. It exposes only { status, timestamp }.
 */
function isExempt(path: string): boolean {
  if (!path.startsWith('/api')) return true;
  return path === '/api/health';
}

// One warning per caller per 5 minutes. A polling dashboard hits this every few seconds;
// unthrottled it would bury the very log line you are meant to be acting on.
const WARN_COOLDOWN_MS = 5 * 60 * 1000;
const lastWarnedAt = new Map<string, number>();

function warnUnauthenticated(req: Request): void {
  const who = req.ip || req.socket.remoteAddress || 'unknown';
  const last = lastWarnedAt.get(who) ?? 0;
  const now = Date.now();
  if (now - last < WARN_COOLDOWN_MS) return;
  lastWarnedAt.set(who, now);
  console.warn(
    `[auth] unauthenticated ${req.method} ${req.path} from ${who} — ` +
      'this caller has not been given the fleet token yet. It is allowed for now ' +
      '(permissive mode) and WILL be rejected once auth is set to strict.',
  );
}

/** Reset throttling state. Tests only — otherwise a suite's warnings mask each other. */
export function _resetAuthWarnings(): void {
  lastWarnedAt.clear();
}

export function fleetAuth() {
  return function fleetAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    if (isExempt(req.path)) return next();

    const expected = getFleetToken();
    // No token configured anywhere — nothing to check against. Fail OPEN rather than
    // bricking a server whose first-launch generation did not run; ensureFleetToken()
    // at startup means this is close to unreachable in practice.
    if (!expected) return next();

    const presented = presentedToken(req);

    if (presented === null) {
      if (getAuthMode() === 'strict') {
        return res.status(401).json({ error: 'Fleet token required' });
      }
      warnUnauthenticated(req);
      return next();
    }

    if (!tokensMatch(presented, expected)) {
      // Rejected in BOTH modes. Grandfathering a wrong token would make every wrong
      // guess equivalent to the real secret.
      return res.status(401).json({ error: 'Invalid fleet token' });
    }

    return next();
  };
}
