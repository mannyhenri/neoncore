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

test('probe (gridlight): up when /health responds', async () => {
  const { s, url } = await server((req, res) => {
    if (req.url === '/health') { res.end('ok'); } else { res.statusCode = 404; res.end(); }
  });
  try {
    const p = await probeGateway(url, 'gridlight-default', 'gridlight');
    assert.equal(p.ok, true, p.detail);
    assert.match(p.detail, /\/health/);
  } finally { s.close(); }
});

test('probe (gridlight): down gateway is rejected', async () => {
  const p = await probeGateway('http://127.0.0.1:1', 'gridlight-default', 'gridlight', 500);
  assert.equal(p.ok, false);
  assert.match(p.detail, /unreachable/);
});

test('probe (openai-compatible): accepts a gateway serving the requested model', async () => {
  const { s, url } = await server((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.1' }] }));
  });
  try {
    const p = await probeGateway(url, 'qwen2.5-coder:7b', 'openai-compatible');
    assert.equal(p.ok, true, p.detail);
  } finally { s.close(); }
});

test('probe (openai-compatible): REJECTS a live gateway not serving the model (false-0% guard)', async () => {
  const { s, url } = await server((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'llama3.1' }] }));
  });
  try {
    const p = await probeGateway(url, 'qwen2.5-coder:7b', 'openai-compatible');
    assert.equal(p.ok, false);
    assert.match(p.detail, /not served/);
  } finally { s.close(); }
});
