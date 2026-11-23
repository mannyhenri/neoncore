/**
 * Sessions. A session lasts 30 days from sign-in (README: "Sessions"), then the user signs in again.
 */
import { randomBytes } from 'node:crypto';

export const SESSION_DAYS = 30;
const sessions = new Map();

/** Sign in: a new session for `user`. `now` is milliseconds since the epoch. */
export function createSession(user, now = Date.now()) {
  const id = randomBytes(16).toString('hex');
  // Expiry in SECONDS since the epoch, like a JWT `exp`.
  const expires = Math.floor(now / 1000) + SESSION_DAYS * 24 * 60 * 60;
  sessions.set(id, { user, expires });
  return { id, user, expires };
}

/** The signed-in user, or null when the session is unknown or has expired. */
export function userFor(id, now = Date.now()) {
  const s = sessions.get(id);
  if (!s) return null;
  if (now > s.expires * 1000 * 1000) {
    sessions.delete(id);
    return null;
  }
  return s.user;
}

export function endSession(id) {
  sessions.delete(id);
}
