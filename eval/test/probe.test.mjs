import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeGateway } from '../src/probe.mjs';

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

test('probe: accepts a gateway serving the requested model', async () => {
  const { s, url } = await server((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.1' }] }));
  });
  try {
    const p = await probeGateway(url, 'qwen2.5-coder:7b');
    assert.equal(p.ok, true, p.detail);
  } finally { s.close(); }
});

test('probe: REJECTS a live gateway that is not serving the model (the false-0% guard)', async () => {
  const { s, url } = await server((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'llama3.1' }] }));
  });
  try {
    const p = await probeGateway(url, 'qwen2.5-coder:7b');
    assert.equal(p.ok, false);
    assert.match(p.detail, /not served/);
  } finally { s.close(); }
});

test('probe: rejects a down gateway', async () => {
  // nothing listening on this port
  const p = await probeGateway('http://127.0.0.1:1', 'any-model', 500);
  assert.equal(p.ok, false);
  assert.match(p.detail, /unreachable/);
});
