/**
 * Express 4 does not catch a rejected promise from a route: an async handler that throws after
 * its first await left the request HANGING. Every async route goes through asyncRoute, and the
 * app answers any unhandled route error as JSON (lib/async-route.ts).
 *
 * SET-BASED over the route files: a new `async (req, res)` handler without the wrapper fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { asyncRoute, apiErrorHandler } from '../src/lib/async-route.ts';

const ROUTES = path.join(import.meta.dirname, '..', 'src', 'routes');

test('every async route handler is wrapped', () => {
  const bare: string[] = [];
  for (const f of fs.readdirSync(ROUTES).filter((x) => x.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
    // Any async function taking (req, …) in a route file — inline handlers and handler factories alike.
    src.split('\n').forEach((line, i) => {
      if (/async \(req\b/.test(line) && !line.includes('asyncRoute(')) bare.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bare, [], `async handlers a rejection would leave hanging:\n${bare.join('\n')}`);
});

test('a rejection after an await answers as JSON instead of hanging; a sync throw too', async () => {
  const app = express();
  app.get('/late', asyncRoute(async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error('boom after await'); }));
  app.get('/sync', () => { throw Object.assign(new Error('nope'), { status: 409 }); });
  app.use(apiErrorHandler);
  let server!: Server;
  const base = await new Promise<string>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)); });
  const errors = console.error;
  console.error = () => {};
  try {
    const late = await fetch(`${base}/late`, { signal: AbortSignal.timeout(3000) });
    assert.equal(late.status, 500);
    assert.deepEqual(await late.json(), { error: 'boom after await' });
    const sync = await fetch(`${base}/sync`);
    assert.equal(sync.status, 409);
    assert.deepEqual(await sync.json(), { error: 'nope' });
  } finally {
    console.error = errors;
    server.close();
  }
});
