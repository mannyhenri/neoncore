import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/isolated-db.js';
import express from 'express';
import { createServer, type Server } from 'node:http';
import db from '../src/db.js';
import activityRouter from '../src/routes/activity.js';
import { SUBSCRIPTION_PROVIDERS } from '../src/lib/token-ceiling.js';
import { USAGE_WINDOWS, WINDOW_LENGTH_MS } from '../src/lib/usage-checkpoint.js';

/**
 * The checkpoint route end to end: a reading goes in, the local token snapshot is taken from
 * the window's start, and the burn-rate readout carries the anchor built on it — for EVERY
 * provider and EVERY window, since each is stored and projected separately.
 */
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

const post = (body: unknown) => fetch(`${baseUrl}/api/activity/usage-checkpoints`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('every provider × window: a checkpoint is recorded with the local snapshot and surfaces in burn-rate', async () => {
  const now = Date.now();
  db.exec('DELETE FROM session_usage; DELETE FROM usage_checkpoints; DELETE FROM agents;');
  for (const [i, provider] of SUBSCRIPTION_PROVIDERS.entries()) {
    const agentId = `agent-${provider}`;
    db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen)
      VALUES (?, ?, 'test', '/repo', 'repo', ?, 'idle', ?)`).run(agentId, provider, provider, new Date(now).toISOString());
    // 1000+i tokens two hours ago (inside every window), 5000 nine days ago (outside every window).
    db.prepare(`INSERT INTO session_usage (id, session_id, agent_id, input_tokens, output_tokens, model, recorded_at, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`).run(`u-${provider}`, `s-${provider}`, agentId, 100 + i, 200, new Date(now - 2 * 3_600_000).toISOString(), 300, 400);
    db.prepare(`INSERT INTO session_usage (id, session_id, agent_id, input_tokens, output_tokens, model, recorded_at, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`).run(`old-${provider}`, `s-${provider}`, agentId, 5000, 0, new Date(now - 9 * 86_400_000).toISOString(), 0, 0);

    for (const window of USAGE_WINDOWS) {
      const resetsAt = new Date(now + WINDOW_LENGTH_MS[window] / 2).toISOString();
      const res = await post({ provider, window, pctUsed: 62, resetsAt });
      const text = await res.text();
      assert.equal(res.status, 201, `${provider}/${window}: ${text}`);
      const body = JSON.parse(text) as { checkpoint: { pctUsed: number; localTokens: number; window: string }; anchor: { pctUsed: number; pace: string; window: string } | null };
      assert.equal(body.checkpoint.pctUsed, 0.62);
      assert.equal(body.checkpoint.localTokens, 1000 + i, `${provider}/${window}: the snapshot must cover only this window`);
      assert.ok(body.anchor && body.anchor.window === window, `${provider}/${window}: no anchor came back`);
      assert.ok(body.anchor!.pctUsed >= 0.62, 'the anchor starts from the reading');
    }
  }

  const rate = await (await fetch(`${baseUrl}/api/activity/burn-rate`)).json() as { usageAnchor: { provider: string; window: string; recommendation: string }[] };
  const keys = rate.usageAnchor.map((a) => `${a.provider}/${a.window}`).sort();
  const want = SUBSCRIPTION_PROVIDERS.flatMap((p) => USAGE_WINDOWS.map((w) => `${p}/${w}`)).sort();
  assert.deepEqual(keys, want, 'burn-rate must carry one anchor per provider and window that has a reading');
  assert.ok(rate.usageAnchor.every((a) => a.recommendation.length > 0));

  const list = await (await fetch(`${baseUrl}/api/activity/usage-checkpoints?provider=claude`)).json() as { checkpoints: { provider: string }[]; anchors: unknown[] };
  assert.equal(list.checkpoints.length, USAGE_WINDOWS.length);
  assert.ok(list.checkpoints.every((c) => c.provider === 'claude'));
});

test('a bad reading is refused with the reason, and nothing is stored', async () => {
  db.exec('DELETE FROM usage_checkpoints;');
  for (const body of [
    { provider: 'gemini', pctUsed: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    { provider: 'claude', pctUsed: 120, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    { provider: 'claude', pctUsed: 10, resetsAt: 'tomorrow-ish' },
    { provider: 'claude', window: 'session', pctUsed: 10, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(((await res.json()) as { error: string }).error.length > 0);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM usage_checkpoints').get() as { n: number }).n, 0);
});
