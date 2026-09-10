import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/isolated-db.js';
import express from 'express';
import { createServer, type Server } from 'node:http';
import db from '../src/db.js';
import activityRouter from '../src/routes/activity.js';
import { SUBSCRIPTION_PROVIDERS } from '../src/lib/token-ceiling.js';

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', activityRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function postCalibration(body: unknown) {
  return fetch(`${baseUrl}/api/activity/token-limit-calibrations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('calibration endpoint validates every provider and records the preceding seven-day total', async () => {
  const now = Date.now();
  for (const [index, provider] of SUBSCRIPTION_PROVIDERS.entries()) {
    const agentId = `agent-${provider}`;
    db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen)
      VALUES (?, ?, 'test', '/repo', 'repo', ?, 'idle', ?)`).run(agentId, provider, provider, new Date(now).toISOString());
    db.prepare(`INSERT INTO session_usage
      (id, session_id, agent_id, input_tokens, output_tokens, model, recorded_at, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`).run(
      `usage-${provider}`, `session-${provider}`, agentId, 100 + index, 200,
      new Date(now - 60_000).toISOString(), 300, 400,
    );
    const response = await postCalibration({ provider, hitAt: new Date(now).toISOString() });
    assert.equal(response.status, 201, provider);
    const body = await response.json() as { id: string; weeklyTokens: number };
    assert.ok(body.id, `${provider}: cycle boundary persisted`);
    assert.equal(body.weeklyTokens, 1_000 + index);

    const duplicate = await postCalibration({ provider, hitAt: new Date(now + 30_000).toISOString() });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as { id: string }).id, body.id);
  }

  for (const body of [
    { provider: 'other', hitAt: new Date(now).toISOString() },
    { provider: 'claude', hitAt: 'not-a-date' },
    { provider: 'claude', hitAt: new Date(now + 120_000).toISOString() },
  ]) {
    assert.equal((await postCalibration(body)).status, 400);
  }
});

test('zero-history servers retain the cycle boundary and later usage appears in burn-rate', async () => {
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    db.exec('DELETE FROM session_usage; DELETE FROM token_limit_calibrations; DELETE FROM agents;');
    const hitAt = new Date(Date.now() - 3_600_000);
    const response = await postCalibration({ provider, hitAt: hitAt.toISOString() });
    assert.equal(response.status, 201);
    assert.ok((await response.json() as { id: string }).id);

    db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen)
      VALUES (?, 'late', 'test', '/late', 'late', ?, 'idle', ?)`).run(`late-${provider}`, provider, new Date().toISOString());
    db.prepare(`INSERT INTO session_usage
      (id, session_id, agent_id, input_tokens, output_tokens, model, recorded_at, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, 25, 25, '', ?, 25, 25)`)
      .run(`late-usage-${provider}`, `late-session-${provider}`, `late-${provider}`, new Date(hitAt.getTime() + 60_000).toISOString());

    const burn = await fetch(`${baseUrl}/api/activity/burn-rate`);
    assert.equal(burn.status, 200);
    const payload = await burn.json() as { subscriptionUsage: Array<{ provider: string; tokensUsed: number; lastHitAt: string }> };
    const usage = payload.subscriptionUsage.find((row) => row.provider === provider);
    assert.equal(usage?.tokensUsed, 100, provider);
    assert.equal(usage?.lastHitAt, hitAt.toISOString(), provider);
  }
});
