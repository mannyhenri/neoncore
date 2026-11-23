/**
 * EVERY QaAction kind and EVERY expect kind is interpreted — iterated from the registries, so a kind
 * added to actions.mjs without a case here fails this file.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_KINDS, EXPECT_KINDS, invalidAction, isCheckSentence, runSpec } from '../src/index.mjs';
import { spec, startKitchen, tmp } from './helpers.mjs';

let site;
before(async () => { site = await startKitchen(); });
after(async () => { await site.close(); });

const home = { do: 'goto', path: '/' };
const go = { role: 'button', name: 'Go' };

/** One passing cache per action kind: the action, then an expectation that proves it happened. */
const ACTION_CASES = {
  goto: [{ do: 'goto', path: '/next' }, { do: 'expect', kind: 'url', equals: '/next' }],
  click: [home, { do: 'click', target: go }, { do: 'expect', kind: 'text', target: { testId: 'out' }, equals: 'clicked' }],
  fill: [home, { do: 'fill', target: { label: 'Name' }, value: 'Ada' }, { do: 'expect', kind: 'value', target: { label: 'Name' }, equals: 'Ada' }],
  select: [home, { do: 'select', target: { label: 'Colour' }, option: 'Blue' }, { do: 'expect', kind: 'value', target: { label: 'Colour' }, equals: 'Blue' }],
  check: [home, { do: 'check', target: { label: 'Agree' }, checked: true }, { do: 'expect', kind: 'count', target: { css: '#agree:checked' }, equals: 1 }],
  press: [home, { do: 'click', target: { placeholder: 'Type here' } }, { do: 'press', key: 'Enter' }, { do: 'expect', kind: 'text', target: { testId: 'out' }, equals: 'entered' }],
  wait: [home, { do: 'wait', ms: 100 }, { do: 'expect', kind: 'visible', target: go }],
  expect: [home, { do: 'expect', kind: 'visible', target: go }],
};

/** Per expect kind: one that holds and one that does not. */
const EXPECT_CASES = {
  visible: [{ do: 'expect', kind: 'visible', target: go }, { do: 'expect', kind: 'visible', target: { css: '#hidden' } }],
  hidden: [{ do: 'expect', kind: 'hidden', target: { css: '#hidden' } }, { do: 'expect', kind: 'hidden', target: go }],
  text: [{ do: 'expect', kind: 'text', contains: 'Next page' }, { do: 'expect', kind: 'text', contains: 'Not on this page' }],
  url: [{ do: 'expect', kind: 'url', equals: '/' }, { do: 'expect', kind: 'url', equals: '/elsewhere' }],
  value: [{ do: 'expect', kind: 'value', target: { label: 'Colour' }, equals: 'Red' }, { do: 'expect', kind: 'value', target: { label: 'Colour' }, equals: 'Green' }],
  count: [{ do: 'expect', kind: 'count', target: { css: '.item' }, equals: 3 }, { do: 'expect', kind: 'count', target: { css: '.item' }, equals: 4 }],
};

test('the registries are the contract: 8 action kinds, 6 expect kinds, each with a case', () => {
  assert.deepEqual([...ACTION_KINDS].sort(), ['check', 'click', 'expect', 'fill', 'goto', 'press', 'select', 'wait']);
  assert.deepEqual([...EXPECT_KINDS].sort(), ['count', 'hidden', 'text', 'url', 'value', 'visible']);
  assert.deepEqual(Object.keys(ACTION_CASES).sort(), [...ACTION_KINDS].sort());
  assert.deepEqual(Object.keys(EXPECT_CASES).sort(), [...EXPECT_KINDS].sort());
});

for (const kind of ACTION_KINDS) {
  test(`action "${kind}" is interpreted`, async () => {
    const r = await runSpec(spec(site.baseUrl, [`Do ${kind}.`], [ACTION_CASES[kind]]), tmp(kind));
    assert.equal(r.status, 'passed', JSON.stringify(r.steps));
    assert.equal(r.steps[0].status, 'passed');
  });
}

for (const kind of EXPECT_KINDS) {
  test(`expect "${kind}" passes when it holds and fails, with a reason, when it does not`, async () => {
    const [holds, fails] = EXPECT_CASES[kind];
    const ok = await runSpec(spec(site.baseUrl, ['Open the page.', `Check ${kind}.`], [[home], [holds]]), tmp(`${kind}-ok`));
    assert.equal(ok.status, 'passed', JSON.stringify(ok.steps));
    const bad = await runSpec(spec(site.baseUrl, ['Open the page.', `Check ${kind}.`], [[home], [fails]]), tmp(`${kind}-bad`));
    assert.equal(bad.status, 'failed');
    assert.equal(bad.steps[1].status, 'failed');
    assert.ok(bad.steps[1].error, 'a failed check says why');
    assert.deepEqual(bad.steps[1].failedAction, { index: 0, action: fails });
    assert.ok(bad.steps[1].screenshot, 'a failed step has a screenshot');
  });
}

test('a run stops at the first failed sentence; the rest are skipped; a trace is always written', async () => {
  const r = await runSpec(spec(site.baseUrl, ['Open.', 'Click a missing button.', 'Never reached.'],
    [[home], [{ do: 'click', target: { role: 'button', name: 'Missing' } }], [home]]), tmp('stop'));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.steps.map((s) => s.status), ['passed', 'failed', 'skipped']);
  assert.match(r.steps[1].error, /no element/);
  assert.match(r.trace, /trace\.zip$/);
});

test('a sentence with no cached actions fails rather than passing empty', async () => {
  const r = await runSpec(spec(site.baseUrl, ['Open.', 'Uncached.'], [[home]]), tmp('uncached'));
  assert.equal(r.steps[1].status, 'failed');
  assert.match(r.steps[1].error, /no cached actions/);
});

test('every action kind rejects a malformed action before anything runs', () => {
  const malformed = { goto: { do: 'goto' }, click: { do: 'click' }, fill: { do: 'fill', target: { label: 'x' } }, select: { do: 'select', target: { label: 'x' } },
    check: { do: 'check', target: { label: 'x' } }, press: { do: 'press' }, wait: { do: 'wait', ms: -1 }, expect: { do: 'expect', kind: 'nope' } };
  for (const kind of ACTION_KINDS) assert.ok(invalidAction(malformed[kind]), `${kind} accepted a malformed action`);
  assert.ok(invalidAction({ do: 'eval', code: 'x' }), 'an unknown kind is rejected');
});

test('check sentences are recognised by their verb', () => {
  for (const s of ['Check that its status is Approved.', 'Verify the total.', 'Ensure it saved.', 'Confirm the email.', 'Expect a banner.', 'Assert one row.', '4. Check the list.'])
    assert.equal(isCheckSentence(s), true, s);
  for (const s of ['Log in as a supervisor.', 'Submit it.', 'Click Check out.', 'Create a report.'])
    assert.equal(isCheckSentence(s), false, s);
});
