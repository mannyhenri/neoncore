import { Router } from 'express';
// Token registration is genuinely APNs-specific and stays. Sending is not: that goes
// through the channel layer, so this file no longer reaches an app SDK to notify.
import { registerPushToken, removePushToken, isApnsDeviceToken } from '../lib/apns-push.js';
import { notifyAll, listChannels } from '../lib/channels.js';
import { desktopStatus, DESKTOP_MODES, DESKTOP_SETTING_KEY, type DesktopMode } from '../lib/channels/desktop.js';
import db from '../db.js';
import { asyncRoute } from '../lib/async-route.js';

const router = Router();

// The mobile app calls this after iOS hands it an APNs device token (hex). Idempotent.
router.post('/register', (req, res) => {
  const { token, platform } = req.body || {};
  if (!isApnsDeviceToken(token)) {
    return res.status(400).json({ error: 'A valid APNs device token (hex) is required' });
  }
  registerPushToken(token, typeof platform === 'string' ? platform : '');
  res.json({ ok: true });
});

// Called when the user disables notifications or on sign-out.
router.post('/unregister', (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'token is required' });
  }
  removePushToken(token);
  res.json({ ok: true });
});

// Send a test push to all registered devices — handy for verifying the pipeline end to end.
// Reports whether APNs is configured so a silent no-op isn't mistaken for a delivery.
/**
 * Test every configured channel, not just the phone.
 *
 * This called `sendPushToAll` directly, so the one endpoint anybody would press to check
 * notifications tested APNs and nothing else — with Discord configured and working, a green
 * answer here still told you nothing about it. That is the direct-import problem N1 removed
 * from the executor and the permission route, left standing in the place most likely to be
 * used to diagnose the thing.
 *
 * `target` routes the test where a real notice would go, so the channel map can be checked from
 * outside the process rather than by reading config.
 */
router.post('/test', asyncRoute(async (req, res) => {
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  // The channels that will actually SEND — by name. This returned the registered channel objects,
  // configured or not, so the answer read as a list of every app NeonCore knows about (and the
  // "nothing is configured" note below could never appear).
  const names = listChannels().filter((c) => c.isConfigured()).map((c) => c.name);

  await notifyAll({
    title: 'NeonCore',
    body: target ? `Test notice addressed to \`${target}\`.` : 'Notifications are working.',
    data: { type: 'test', ...(target ? { target } : {}) },
  });

  res.json({
    ok: true,
    channels: names,
    routed_to: target || null,
    ...(names.length ? {} : { note: 'No channel is configured, so nothing was sent.' }),
  });
}));

/**
 * The desktop channel: can this server raise OS notifications, and which ones. `available: false`
 * comes with the reason (e.g. no notify-send on a headless Linux box), so the setting never looks
 * switched on while nothing can appear.
 */
router.get('/desktop', (_req, res) => {
  res.json({ ...desktopStatus(), envOverride: Boolean((process.env.NEONCORE_DESKTOP_NOTIFY || '').trim()) });
});

router.put('/desktop', (req, res) => {
  const mode = String(req.body?.mode ?? '') as DesktopMode;
  if (!DESKTOP_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${DESKTOP_MODES.join(', ')}` });
  }
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(DESKTOP_SETTING_KEY, mode, new Date().toISOString());
  res.json(desktopStatus());
});

export default router;
