import { Router } from 'express';
import { registerPushToken, removePushToken, isApnsDeviceToken, sendPushToAll, isPushConfigured } from '../lib/apns-push.js';

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
router.post('/test', async (_req, res) => {
  const configured = isPushConfigured();
  await sendPushToAll('NeonCore', 'Push notifications are working.', { type: 'test' });
  res.json({
    ok: true,
    configured,
    ...(configured ? {} : { note: 'APNs is not configured — set APNS_KEY_PATH, APNS_KEY_ID and APNS_TEAM_ID. Nothing was sent.' }),
  });
});

export default router;
