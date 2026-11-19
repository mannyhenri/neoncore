/**
 * A minimal NeonCore server for test/fleet-token-auth.test.ts: the real auth middleware in front
 * of real routes (/api/peers for an authenticated read, /api/settings for secret redaction), in a
 * child process so each instance has its own database and auth mode.
 */
import express from 'express';
import cors from 'cors';
import peersRouter from '../../src/routes/peers.ts';
import settingsRouter from '../../src/routes/settings.ts';
import { fleetAuth } from '../../src/lib/auth.ts';
import { getServerBaseUrl } from '../../src/lib/server-url.ts';

const PORT = parseInt(process.env.PORT || '4141');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(fleetAuth());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/peers', peersRouter);
app.use('/api/settings', settingsRouter);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`READY ${getServerBaseUrl()}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
