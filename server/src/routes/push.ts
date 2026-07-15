import { Router } from 'express';
import { registerPushToken, removePushToken, isExpoPushToken, sendPushToAll } from '../lib/expo-push.js';

const router = Router();

// The mobile app calls this after it obtains an Expo push token. Idempotent.
router.post('/register', (req, res) => {
  const { token, platform } = req.body || {};
  if (!isExpoPushToken(token)) {
    return res.status(400).json({ error: 'A valid Expo push token is required' });
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
router.post('/test', async (_req, res) => {
  await sendPushToAll('NeonCore', 'Push notifications are working.', { type: 'test' });
  res.json({ ok: true });
});

export default router;
