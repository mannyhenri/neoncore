/**
 * THE GUARDRAILS EACH REFUSE (docs/plans/qa-section.md § Runner CLI): the allow-list, every default
 * deny pattern, credentials masked in every output, the wait cap and the time budget.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DENY, MAX_WAIT_MS, deniedBy, runSpec, zipTexts } from '../src/index.mjs';
import { denyLabel, spec, startKitchen, tmp } from './helpers.mjs';

let site;
before(async () => { site = await startKitchen(); });
after(async () => { await site.close(); });

const home = { do: 'goto', path: '/' };

test('a base URL off the allow-list is refused before a browser starts', async () => {
  const r = await runSpec({ ...spec(site.baseUrl, ['Open.'], [[home]]), allowHosts: ['staging.example.test'] }, tmp('base'));
  assert.equal(r.status, 'blocked');
  assert.match(r.error, /not on the allow-list/);
});

test('navigating off the allow-list is refused, and the run is blocked', async () => {
  const r = await runSpec(spec(site.baseUrl, ['Go to production.'], [[{ do: 'goto', path: 'https://production.example.com/' }]]), tmp('goto'));
  assert.equal(r.status, 'blocked');
  assert.match(r.steps[0].error, /not on the allow-list/);
});

test('a request from the page to a host off the allow-list is aborted and reported', async () => {
  const r = await runSpec(spec(site.baseUrl, ['Open the offsite page.'], [[{ do: 'goto', path: '/offsite' }]]), tmp('offsite'));
  assert.equal(r.status, 'passed');
  const blocked = r.network.filter((n) => n.blocked);
  assert.equal(blocked.length, 1, JSON.stringify(r.network));
  assert.match(blocked[0].url, /blocked\.example\.invalid/);
});

for (const pattern of DEFAULT_DENY) {
  test(`a click on "${denyLabel(pattern)}" is refused unless allowDestructive`, async () => {
    const cache = [[home, { do: 'click', target: { role: 'button', name: denyLabel(pattern) } }]];
    const refused = await runSpec(spec(site.baseUrl, ['Click it.'], cache), tmp(`deny-${pattern}`));
    assert.equal(refused.status, 'blocked');
    assert.match(refused.steps[0].error, /destructive action/);
    const allowed = await runSpec(spec(site.baseUrl, ['Click it.'], cache, { allowDestructive: true }), tmp(`allow-${pattern}`));
    assert.equal(allowed.status, 'passed', JSON.stringify(allowed.steps));
  });
}

test('deny patterns match whole words only', () => {
  assert.equal(deniedBy('Payroll report'), null);
  assert.equal(deniedBy('Removed items'), null);
  assert.equal(deniedBy('Pay now'), 'pay');
  assert.equal(deniedBy('Send  Email'), 'send email');
});

test('a credential read through valueEnv appears in NO output: result, console, error or trace', async () => {
  const secret = 'Hunter2-very-secret';
  process.env.QA_TEST_SECRET = secret;
  const r = await runSpec(spec(site.baseUrl, ['Type the secret.', 'Check a wrong value.'], [
    [home, { do: 'fill', target: { label: 'Secret' }, valueEnv: 'QA_TEST_SECRET' }, { do: 'press', key: 'a' }],
    [{ do: 'expect', kind: 'value', target: { label: 'Secret' }, equals: 'wrong' }],
  ], { env: ['QA_TEST_SECRET'] }), tmp('secret'));
  assert.equal(r.status, 'failed', 'the wrong value must fail');
  const json = JSON.stringify(r);
  assert.ok(!json.includes(secret), 'the secret leaked into the result');
  assert.ok(json.includes('•••'), 'the secret was not masked where it appeared');
  assert.ok(r.console.some((c) => c.includes('•••')), 'the page echoed the secret to the console, masked');
  for (const { name, text } of zipTexts(r.trace)) assert.ok(!text.includes(secret), `the secret leaked into the trace (${name})`);
});

test('valueEnv may only read the env names the spec lists', async () => {
  process.env.QA_OTHER_SECRET = 'other';
  const r = await runSpec(spec(site.baseUrl, ['Type.'], [[home, { do: 'fill', target: { label: 'Name' }, valueEnv: 'QA_OTHER_SECRET' }]], { env: ['QA_TEST_SECRET'] }), tmp('envlist'));
  assert.equal(r.status, 'failed');
  assert.match(r.steps[0].error, /not one this spec may read/);
});

test(`a wait is capped at ${MAX_WAIT_MS} ms`, async () => {
  const t = Date.now();
  const r = await runSpec(spec(site.baseUrl, ['Wait a minute.'], [[home, { do: 'wait', ms: 60_000 }]]), tmp('wait'));
  assert.equal(r.status, 'passed');
  assert.ok(Date.now() - t < MAX_WAIT_MS + 10_000, `waited ${Date.now() - t} ms`);
});

test('a run over its time budget is stopped and blocked', async () => {
  const r = await runSpec(spec(site.baseUrl, ['Wait.', 'Wait more.'], [[home, { do: 'wait', ms: 5000 }], [{ do: 'wait', ms: 5000 }]], { budget: { minutes: 0.05 } }), tmp('budget'));
  assert.equal(r.status, 'blocked');
  assert.match(r.error, /budget/);
});

test('the allow-list rule is the server\'s: a port in an entry pins the port, no port allows any; subdomains count', async () => {
  const { hostAllowed } = await import('../src/guard.mjs');
  const CASES = [
    ['127.0.0.1:49729', ['127.0.0.1:49729'], true], ['127.0.0.1:49729', ['127.0.0.1'], true],
    ['127.0.0.1:5000', ['127.0.0.1:49729'], false], ['localhost', ['localhost:4061'], false],
    ['api.example.com', ['example.com'], true], ['evil.com', ['example.com'], false],
    ['example.com:8443', ['example.com'], true], ['[::1]:4061', ['[::1]:4061'], true],
  ];
  for (const [host, list, want] of CASES) assert.equal(hostAllowed(host, list), want, `${host} vs ${list}`);
});
