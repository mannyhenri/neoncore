import { Router } from 'express';
// Token registration is genuinely APNs-specific and stays. Sending is not: that goes
// through the channel layer, so this file no longer reaches an app SDK to notify.
import { registerPushToken, removePushToken, isApnsDeviceToken } from '../lib/apns-push.js';
import { notifyAll, listChannels } from '../lib/channels.js';

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
router.post('/test', async (req, res) => {
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  const names = listChannels();

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
});

export default router;
