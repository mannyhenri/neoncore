/**
 * THE RUNNER AGAINST THE DEMO APP (eval/qa-demo): the supervisor test passes on variant A, fails at
 * the renamed step on B (repair needed), fails at the approval on C; every planted bug reproduces;
 * snapshot and act give a cartridge what it needs; the CLI's exit codes.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { actSpec, runSpec, snapshot } from '../src/index.mjs';
import { startDemo } from '../../../eval/qa-demo/server.mjs';
import { tmp } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'cli.mjs');
const BUGS_MD = join(here, '..', '..', '..', 'eval', 'qa-demo', 'BUGS.md');
const run = promisify(execFile);

let demo;
before(async () => { process.env.QA_DEMO_SUPERVISOR_PASS = 'sup-test-pass'; demo = await startDemo({ port: 0 }); });
after(async () => { await demo.close(); });

const post = (path, body) => fetch(demo.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const variant = async (v) => { await post('/__reset'); assert.equal((await post('/__variant', { variant: v })).status, 200); };

const login = [{ do: 'goto', path: '/login' }, { do: 'fill', target: { label: 'Username' }, value: 'supervisor' },
  { do: 'fill', target: { label: 'Password' }, valueEnv: 'QA_DEMO_SUPERVISOR_PASS' }, { do: 'click', target: { role: 'button', name: 'Log in' } }];

const supervisorTest = () => ({
  baseUrl: demo.baseUrl, allowHosts: ['127.0.0.1'], env: ['QA_DEMO_SUPERVISOR_PASS'],
  sentences: ['Log in as a supervisor.', 'Create a daily report for project Alpha with 8 hours.', 'Submit it and approve it.', 'Check that its status is Approved.'],
  cache: [
    login,
    [{ do: 'goto', path: '/reports/new' }, { do: 'fill', target: { label: 'Project' }, value: 'Alpha' }, { do: 'fill', target: { label: 'Date' }, value: '2026-11-21' }, { do: 'fill', target: { label: 'Hours' }, value: '8' }],
    [{ do: 'click', target: { role: 'button', name: 'Submit' } }, { do: 'expect', kind: 'text', target: { css: '#status' }, equals: 'Awaiting approval' }, { do: 'click', target: { role: 'button', name: 'Approve' } }],
    [{ do: 'expect', kind: 'text', target: { css: '#status' }, equals: 'Approved' }],
  ],
});

test('variant A: the cached supervisor test passes, and the password is never in the output', async () => {
  await variant('A');
  const r = await runSpec(supervisorTest(), tmp('demo-a'));
  assert.equal(r.status, 'passed', JSON.stringify(r.steps, null, 1));
  assert.ok(!JSON.stringify(r).includes('sup-test-pass'));
});

test('variant B: the renamed button fails the cached test at "Submit it" — a repair is needed', async () => {
  await variant('B');
  const r = await runSpec(supervisorTest(), tmp('demo-b'));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.steps.map((s) => s.status), ['passed', 'passed', 'failed', 'skipped']);
  assert.match(r.steps[2].error, /no element role="button" name="Submit"/);
  // The intent is still achievable: the same sentence with the new label passes.
  const repaired = supervisorTest();
  repaired.cache[2][0] = { do: 'click', target: { role: 'button', name: 'Send report' } };
  assert.equal((await runSpec(repaired, tmp('demo-b-fixed'))).status, 'passed');
});

test('variant C: with approval removed, the test fails at the approval — no repair can pass it', async () => {
  await variant('C');
  const r = await runSpec(supervisorTest(), tmp('demo-c'));
  assert.equal(r.status, 'failed');
  assert.equal(r.steps[2].status, 'failed');
  assert.match(r.steps[2].error, /name="Approve"/);
  await variant('A');
});

/** Every planted bug in BUGS.md, reproduced. The table there must list exactly these eight. */
const BUGS = {
  1: async () => {
    const r = await runSpec({ ...supervisorTest(), sentences: ['Log in.', 'Open the reports list.'], cache: [login, [{ do: 'goto', path: '/reports' }]] }, tmp('bug1'));
    assert.ok(r.console.some((c) => /reading 'length'/.test(c)), JSON.stringify(r.console));
  },
  2: async () => {
    const r = await runSpec({ ...supervisorTest(), sentences: ['Log in.', 'Filter by Alpha.'], cache: [login, [{ do: 'goto', path: '/reports' }, { do: 'fill', target: { label: 'Filter by project' }, value: 'Alpha' }, { do: 'click', target: { role: 'button', name: 'Filter' } }, { do: 'expect', kind: 'text', target: { css: '#filter-msg' }, contains: 'Could not' }]] }, tmp('bug2'));
    assert.equal(r.status, 'passed', JSON.stringify(r.steps));
    assert.ok(r.network.some((n) => n.status === 500 && n.url.includes('/api/reports')));
  },
  3: async () => { assert.equal((await fetch(`${demo.baseUrl}/help`)).status, 404); },
  4: async () => {
    const r = await runSpec({ ...supervisorTest(), sentences: ['Log in.', 'Export.', 'Check nothing happened.'], cache: [login,
      [{ do: 'goto', path: '/reports' }, { do: 'click', target: { role: 'button', name: 'Export' } }],
      [{ do: 'expect', kind: 'url', equals: '/reports' }, { do: 'expect', kind: 'text', target: { css: '#filter-msg' }, equals: '' }]] }, tmp('bug4'));
    assert.equal(r.status, 'passed', JSON.stringify(r.steps));
  },
  5: async () => {
    const r = await runSpec({ ...supervisorTest(), sentences: ['Log in.', 'Submit with no project.'], cache: [login,
      [{ do: 'goto', path: '/reports/new' }, { do: 'fill', target: { label: 'Hours' }, value: '4' }, { do: 'click', target: { role: 'button', name: 'Submit' } }, { do: 'expect', kind: 'text', contains: '(no project)' }]] }, tmp('bug5'));
    assert.equal(r.status, 'passed', JSON.stringify(r.steps));
  },
  6: async () => {
    const r = await runSpec({ ...supervisorTest(), sentences: ['Log in.', 'Submit an impossible date.'], cache: [login,
      [{ do: 'goto', path: '/reports/new' }, { do: 'fill', target: { label: 'Project' }, value: 'Beta' }, { do: 'fill', target: { label: 'Date' }, value: '2026-13-45' }, { do: 'fill', target: { label: 'Hours' }, value: '4' },
        { do: 'click', target: { role: 'button', name: 'Submit' } }, { do: 'expect', kind: 'text', contains: 'Date: 2026-13-45' }]] }, tmp('bug6'));
    assert.equal(r.status, 'passed', JSON.stringify(r.steps));
  },
  7: async () => {
    // Quick approve on report 3 (Alpha, the third row) approves report 2 (Beacon) instead.
    const r = await runSpec({ ...supervisorTest(), sentences: ['Log in.', 'Quick approve Alpha.', 'Check Beacon was approved instead.'], cache: [login,
      [{ do: 'goto', path: '/reports' }, { do: 'click', target: { css: 'tr[data-id="3"] button' } }],
      [{ do: 'expect', kind: 'text', target: { css: 'tr[data-id="2"] .status' }, equals: 'Approved' }, { do: 'expect', kind: 'text', target: { css: 'tr[data-id="3"] .status' }, equals: 'Awaiting approval' }]] }, tmp('bug7'));
    assert.equal(r.status, 'passed', JSON.stringify(r.steps));
  },
  8: async () => {
    const r = await runSpec({ ...supervisorTest(), sentences: ['Log in.', 'Open a report.'], cache: [login, [{ do: 'goto', path: '/reports/2' }]] }, tmp('bug8'));
    assert.ok(r.network.some((n) => n.status === 404 && /stamp-/.test(n.url)), JSON.stringify(r.network));
  },
};

test('BUGS.md lists exactly eight planted bugs, and each has a reproduction here', () => {
  const rows = readFileSync(BUGS_MD, 'utf8').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => Number(/^\|\s*(\d+)/.exec(l)[1]));
  assert.deepEqual(rows, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Object.keys(BUGS).map(Number), rows);
});

for (const [n, reproduce] of Object.entries(BUGS)) {
  test(`planted bug ${n} reproduces`, async () => { await variant('A'); await reproduce(); });
}

test('snapshot lists the page\'s links, buttons and fields, each with a locator the runner accepts', async () => {
  await variant('A');
  const s = await snapshot({ url: `${demo.baseUrl}/login`, allowHosts: ['127.0.0.1'], outDir: tmp('snap') });
  assert.equal(s.status, 'passed');
  assert.deepEqual(s.fields.map((f) => f.label), ['Username', 'Password']);
  assert.equal(s.fields[1].sensitive, true);
  assert.deepEqual(s.buttons.map((b) => b.name), ['Log in']);
  assert.deepEqual(s.buttons[0].locator, { role: 'button', name: 'Log in' });
  assert.match(s.aria, /Log in/);
  assert.ok(s.screenshot);
});

test('snapshot of a URL off the allow-list is refused', async () => {
  const s = await snapshot({ url: 'https://production.example.com/', allowHosts: ['127.0.0.1'], outDir: tmp('snap-off') });
  assert.equal(s.status, 'blocked');
});

test('act runs actions, then snapshots where it ends — and --state keeps the login between calls', async () => {
  await variant('A');
  const dir = tmp('act');
  const state = join(dir, 'state.json');
  const base = { baseUrl: demo.baseUrl, allowHosts: ['127.0.0.1'], env: ['QA_DEMO_SUPERVISOR_PASS'] };
  const first = await actSpec({ ...base, actions: login }, dir, { state });
  assert.equal(first.status, 'passed', JSON.stringify(first.steps));
  assert.match(first.snapshot.url, /\/reports$/);
  assert.ok(first.snapshot.links.some((l) => l.text === 'Help'));
  assert.ok(first.snapshot.buttons.some((b) => b.name === 'Export'));
  const second = await actSpec({ ...base, start: '/reports/new', actions: [] }, dir, { state });
  assert.match(second.snapshot.url, /\/reports\/new$/, 'still logged in');
  assert.deepEqual(second.snapshot.fields.map((f) => f.label), ['Project', 'Date', 'Hours', 'Notes']);
});

test('the CLI prints one JSON result; exit 0 when it ran, 2 when it was refused', async () => {
  await variant('A');
  const dir = tmp('cli');
  const ok = join(dir, 'ok.json');
  writeFileSync(ok, JSON.stringify(supervisorTest()));
  const r = await run(process.execPath, [CLI, 'run', '--spec', ok, '--out', join(dir, 'out')], { env: { ...process.env } });
  assert.equal(JSON.parse(r.stdout).status, 'passed');

  const refused = join(dir, 'refused.json');
  writeFileSync(refused, JSON.stringify({ ...supervisorTest(), allowHosts: ['staging.example.test'] }));
  await assert.rejects(run(process.execPath, [CLI, 'run', '--spec', refused, '--out', join(dir, 'out2')]), (err) => err.code === 2 && JSON.parse(err.stdout).status === 'blocked');
  await assert.rejects(run(process.execPath, [CLI, 'bogus']), (err) => err.code === 2);
});
