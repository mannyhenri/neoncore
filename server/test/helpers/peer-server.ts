/**
 * A real, minimal NeonCore server for federation tests.
 *
 * Spawned as a CHILD PROCESS, never imported. That is the whole point: db.ts holds a
 * module-level singleton, so two servers inside one process would share one database and
 * stop being independent servers — which is exactly the property under test. Separate
 * processes give each its own module registry, its own NEONCORE_DB_PATH and its own port.
 *
 * It mounts the real auth middleware and the real peers router against the real database
 * schema. It deliberately does NOT boot src/index.ts, which would also seed 20 workflow
 * templates, start six schedulers, and run the first-launch hook installer against the
 * developer's actual home directory.
 *
 * Env in:  PORT, NEONCORE_DB_PATH, NEONCORE_URL, NEONCORE_FLEET_TOKEN, NEONCORE_AUTH_MODE
 * Stdout:  a single line "READY <url>" once listening, so the parent can await startup
 *          rather than sleeping and hoping.
 */

import express from 'express';
import cors from 'cors';
import peersRouter from '../../src/routes/peers.ts';
import settingsRouter from '../../src/routes/settings.ts';
import { fleetAuth } from '../../src/lib/auth.ts';
import { getServerBaseUrl, getServerIdentity } from '../../src/lib/server-url.ts';
import { runPeerTick } from '../../src/lib/peer-scheduler.ts';

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

// Test-only: run one gossip tick on demand. The scheduler's 15s cadence is far too slow
// for a test, and sleeping for it would make the suite both slow and flaky.
app.post('/api/test/tick', async (_req, res) => {
  await runPeerTick();
  res.json({ ok: true, identity: getServerIdentity() });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`READY ${getServerBaseUrl()}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
