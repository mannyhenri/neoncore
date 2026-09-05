import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import db from '../db.js';

/**
 * Apple Push Notification service (APNs) for the NeonCore mobile app.
 *
 * Replaces the old Expo push path. The mobile app was ejected from Expo, which removed
 * both halves of the previous setup: the client no longer mints an `ExponentPushToken`,
 * and we no longer relay through Expo's `exp.host` service. This talks to Apple directly.
 *
 * Deliberately dependency-free: Node's built-in http2 speaks APNs' HTTP/2 API, and
 * node:crypto signs the ES256 JWT that authenticates us. No SDK, no third-party service.
 *
 * Auth is token-based (an APNs Auth Key), which is the modern Apple approach — one .p8 key
 * works for every app on the team and never expires, unlike push certificates.
 *
 * NOTE: the APNs Auth Key is NOT the same thing as the App Store Connect API key used to
 * upload builds. Both are .p8 files from Apple, but they're issued in different places and
 * are not interchangeable. This one comes from:
 *   Apple Developer ▸ Certificates, Identifiers & Profiles ▸ Keys ▸ (+) ▸ Apple Push
 *   Notifications service (APNs)
 *
 * Configure via env (all required for push to be active — otherwise this no-ops cleanly):
 *   APNS_KEY_PATH    path to AuthKey_XXXXXXXXXX.p8
 *   APNS_KEY_ID      the key's 10-char Key ID
 *   APNS_TEAM_ID     Apple Developer Team ID (Gridlight, Inc. = 3AXRJ22S9P)
 *   APNS_BUNDLE_ID   app bundle id (default: ai.gridlight.neoncore)
 *   APNS_SANDBOX     set to '1' to target the sandbox gateway (debug builds installed from
 *                    Xcode). TestFlight and App Store builds use PRODUCTION, which is the
 *                    default — this is the single most common cause of "push works in Xcode
 *                    but not in TestFlight" and vice versa.
 */

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  host: string;
}

function readConfig(): ApnsConfig | null {
  const keyPath = process.env.APNS_KEY_PATH || '';
  const keyId = process.env.APNS_KEY_ID || '';
  const teamId = process.env.APNS_TEAM_ID || '';
  if (!keyPath || !keyId || !teamId) return null;
  if (!fs.existsSync(keyPath)) {
    console.warn(`[apns] APNS_KEY_PATH does not exist: ${keyPath} — push disabled`);
    return null;
  }
  return {
    keyPath,
    keyId,
    teamId,
    bundleId: process.env.APNS_BUNDLE_ID || 'ai.gridlight.neoncore',
    host: process.env.APNS_SANDBOX === '1' ? SANDBOX_HOST : PROD_HOST,
  };
}

/** True once configured — lets callers/log lines distinguish "off" from "broken". */
export function isPushConfigured(): boolean {
  return readConfig() !== null;
}

// ── Auth token (JWT, ES256) ───────────────────────────────────────────────────
// Apple requires the bearer token be refreshed at most once every 20 minutes and at least
// every 60. We regenerate at 50 to stay comfortably inside that window.
const TOKEN_TTL_MS = 50 * 60 * 1000;
let cachedJwt: { value: string; mintedAt: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function authToken(cfg: ApnsConfig): string {
  if (cachedJwt && Date.now() - cachedJwt.mintedAt < TOKEN_TTL_MS) return cachedJwt.value;

  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signingInput = `${header}.${payload}`;
  // JWS requires the raw (r||s) form, not DER — hence ieee-p1363.
  const signature = crypto
    .createSign('SHA256')
    .update(signingInput)
    .sign({ key: fs.readFileSync(cfg.keyPath, 'utf-8'), dsaEncoding: 'ieee-p1363' });

  const value = `${signingInput}.${b64url(signature)}`;
  cachedJwt = { value, mintedAt: Date.now() };
  return value;
}

// ── Token storage (unchanged contract from the Expo implementation) ───────────

export function registerPushToken(token: string, platform: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO push_tokens (token, platform, created_at, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, last_seen = excluded.last_seen
  `).run(token, platform || '', now, now);
}

export function removePushToken(token: string): void {
  db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

function allTokens(): string[] {
  const rows = db.prepare('SELECT token FROM push_tokens').all() as { token: string }[];
  return rows.map((r) => r.token);
}

/**
 * An APNs device token is 32 bytes rendered as hex. Apple has signalled tokens may grow,
 * so this accepts any even-length hex string of a plausible size rather than pinning 64.
 */
export function isApnsDeviceToken(token: unknown): token is string {
  return typeof token === 'string' && /^[0-9a-fA-F]{64,200}$/.test(token) && token.length % 2 === 0;
}

// ── Sending ───────────────────────────────────────────────────────────────────

interface SendResult {
  status: number;
  reason?: string;
}

/** POST one notification to one device over a shared HTTP/2 session. */
function sendOne(
  session: http2.ClientHttp2Session,
  cfg: ApnsConfig,
  token: string,
  body: string,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${authToken(cfg)}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status = 0;
    let raw = '';
    req.setEncoding('utf-8');
    req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let reason: string | undefined;
      if (raw) {
        try { reason = (JSON.parse(raw) as { reason?: string }).reason; } catch { /* non-JSON body */ }
      }
      resolve({ status, reason });
    });
    req.on('error', () => resolve({ status: 0, reason: 'stream-error' }));

    req.end(body);
  });
}

/**
 * Send one notification to every registered device. Prunes tokens Apple reports as dead so
 * the table doesn't accumulate garbage. Never throws — a push failure must not affect
 * workflow execution.
 *
 * Returns what actually happened rather than void: lib/channels/apns.ts wraps this as a
 * Channel, and a Channel that reports `ok` without knowing whether anything was delivered is
 * the "pretending" the channel contract exists to forbid.
 */
export async function sendPushToAll(
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<{ sent: number; pruned: number }> {
  const cfg = readConfig();
  if (!cfg) return { sent: 0, pruned: 0 }; // not configured — inert, same as having no devices

  const tokens = allTokens().filter(isApnsDeviceToken);
  if (tokens.length === 0) return { sent: 0, pruned: 0 };

  // aps carries the user-visible alert; custom keys ride alongside it and arrive in the
  // notification's userInfo, which is what the app's tap-routing reads.
  const payload = JSON.stringify({
    aps: { alert: { title, body }, sound: 'default' },
    ...(data ?? {}),
  });

  let session: http2.ClientHttp2Session | null = null;
  try {
    session = http2.connect(cfg.host);
    // Without this the process can hang on a dead gateway.
    session.setTimeout(10_000, () => session?.destroy());

    let sent = 0;
    let pruned = 0;
    for (const token of tokens) {
      const { status, reason } = await sendOne(session, cfg, token, payload);
      if (status === 200) {
        sent += 1;
      } else if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
        // 410 Gone / bad token: the app was uninstalled or the token rotated.
        removePushToken(token);
        pruned += 1;
      } else {
        console.warn(`[apns] send failed: status=${status} reason=${reason ?? 'unknown'}`);
      }
    }
    console.log(`[apns] Sent "${title}" to ${sent} device(s)${pruned ? `, pruned ${pruned}` : ''}`);
    return { sent, pruned };
  } catch (err) {
    console.warn(`[apns] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: 0, pruned: 0 };
  } finally {
    session?.close();
  }
}
