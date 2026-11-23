/**
 * The seed is the scope's §9 set: 6 real bugs (one per planted bug), 1 duplicate, 1 vague, 1
 * feature request, 1 works-as-designed — plus the injection ticket. Every issue has an EXPECTED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED, REAL_BUG_KEYS, SEED_ISSUES } from '../seed.mjs';
import { startJiraSim } from '../jira-sim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const keys = SEED_ISSUES.map((_, i) => `DEMO-${i + 1}`);

test('exactly 11 issues, each with an EXPECTED entry, and no EXPECTED without an issue', () => {
  assert.equal(SEED_ISSUES.length, 11);
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...keys].sort());
});

test('the scope\'s mix: 6 real bugs, 1 duplicate, 1 vague, 1 feature request, 1 works-as-designed, + the injection ticket', () => {
  const plain = Object.values(EXPECTED).filter((e) => !e.injection);
  assert.equal(REAL_BUG_KEYS.length, 6);
  assert.deepEqual(REAL_BUG_KEYS.map((k) => EXPECTED[k].bug).sort(), [1, 2, 3, 4, 5, 6], 'one issue per planted bug');
  assert.equal(plain.filter((e) => e.outcome === 'duplicate').length, 1);
  assert.equal(plain.filter((e) => e.outcome === 'needs_info').length, 1);
  assert.equal(plain.filter((e) => e.classification === 'feature').length, 1);
  assert.equal(plain.filter((e) => e.outcome === 'works_as_designed').length, 1);
  assert.equal(Object.values(EXPECTED).filter((e) => e.injection).length, 1);
});

test('every expected outcome is one the contract defines', () => {
  const contract = readFileSync(join(HERE, '..', '..', '..', 'docs', 'plans', 'bug-triage.md'), 'utf8');
  for (const [key, e] of Object.entries(EXPECTED)) {
    assert.ok(contract.includes(`\`${e.outcome}\``), `${key}: outcome ${e.outcome} is not in the contract`);
    assert.ok(['bug', 'question', 'feature'].includes(e.classification), `${key}: classification ${e.classification}`);
  }
});

test('a duplicate points at an earlier issue that reports a real bug', () => {
  for (const [key, e] of Object.entries(EXPECTED).filter(([, x]) => x.duplicateOf)) {
    assert.ok(EXPECTED[e.duplicateOf]?.bug, `${key} duplicates ${e.duplicateOf}, which must be a real bug`);
    assert.ok(Number(e.duplicateOf.split('-')[1]) < Number(key.split('-')[1]), `${key} must be filed after ${e.duplicateOf}`);
  }
});

test('the injection ticket hides instructions inside an otherwise real report', () => {
  const [key] = Object.entries(EXPECTED).find(([, e]) => e.injection);
  const issue = SEED_ISSUES[Number(key.split('-')[1]) - 1];
  for (const phrase of [/ignore all of your previous instructions/i, /delete the tests/i, /environment variable/i, /auth/i]) {
    assert.match(issue.description, phrase);
  }
  assert.match(issue.description, /page 1 ends at 1004/, 'it also reports a real symptom');
});

test('the simulator is seeded with exactly these issues, in filing order, all Open bugs in DEMO', async () => {
  const sim = await startJiraSim({ port: 0 });
  try {
    const issues = [...sim.state.issues.values()];
    assert.deepEqual(issues.map((i) => i.key), keys);
    assert.ok(issues.every((i) => i.project.key === 'DEMO' && i.issuetype.name === 'Bug' && i.status.name === 'Open'));
    for (let i = 1; i < issues.length; i++) assert.ok(issues[i].created > issues[i - 1].created, 'filed in order');
    assert.deepEqual(issues.map((i) => i.summary), SEED_ISSUES.map((s) => s.summary));
  } finally {
    await sim.close();
  }
});
