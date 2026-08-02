/**
 * A demotion must say what actually happened.
 *
 * `DEMOTION_FAILURE_THRESHOLD` and the reason string "N consecutive failing turns" both
 * claimed consecutiveness the data could not support: the only streak reset lives past
 * `if (!functionId) return`, and the producer attributes only turns where a tool FAILED. So a
 * clean turn was dropped before it could reset anything, and three failures spread over months
 * demoted exactly like three in a row — while recording a sentence that was false.
 *
 * Two things are fixed here and they are different: the RESET must work when a success is
 * attributed (behaviour), and the recorded reason must describe what was measured rather than
 * what we wished we had measured (honesty). A demotion is evidence; evidence that overstates
 * itself is worse than none, because nothing downstream can tell.
 *
 * Set-based over turn SEQUENCES rather than single events — the bug was entirely about what
 * happens between turns, which no single-event test can see.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { consumeActivityEvent, loadDemotions, clearDemotionsForModel } from '../src/lib/engine-store.ts';
import { DEMOTION_FAILURE_THRESHOLD } from '../src/lib/engine-capability.ts';

installStubIO();
const M = 'qwen2.5-coder-14b';
const FN = 'edit_file';
const ISO = new Date().toISOString();
let n = 0;

function agent(): string {
  const id = `ag-${++n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,agent_type,status,last_seen)
              VALUES (?,?,?,?,?,?,?)`).run(id, `t/${id}`, 'm', '/r', 'gridlight', 'working', ISO);
  return id;
}

/** A turn as the PRODUCER puts it on the wire. */
function turn(a: string, kind: 'fail' | 'success' | 'unattributable') {
  const body =
    kind === 'fail'
      ? { model: M, functionId: FN, signals: { proseInsteadOfToolCall: true, success: false } }
      : kind === 'success'
        ? { model: M, functionId: FN, signals: { success: true } }
        // Producer refuses: several tools involved, it will not name one.
        : { model: M, functionId: '', signals: { success: true } };
  consumeActivityEvent('trouble_signals', JSON.stringify(body), a);
}

const F = DEMOTION_FAILURE_THRESHOLD;

const SEQUENCES: { label: string; turns: ('fail' | 'success' | 'unattributable')[]; demoted: boolean }[] = [
  {
    label: `${F} failures in a row`,
    turns: Array(F).fill('fail'),
    demoted: true,
  },
  {
    label: 'failures separated by ATTRIBUTED successes — the streak is broken each time',
    turns: Array(F).fill(null).flatMap(() => ['fail', 'success'] as const).slice(0, F * 2 - 1),
    demoted: false,
  },
  {
    label: `${F - 1} failures — one short, nothing recorded`,
    turns: Array(F - 1).fill('fail'),
    demoted: false,
  },
  {
    label: 'a success AFTER the streak resets it, so later failures start from zero',
    turns: [...Array(F - 1).fill('fail'), 'success', 'fail'],
    demoted: false,
  },
];

for (const s of SEQUENCES) {
  test(`sequence: ${s.label}`, () => {
    clearDemotionsForModel(M);
    const a = agent();
    for (const t of s.turns) turn(a, t as 'fail' | 'success');
    const got = loadDemotions(M).some((d) => d.functionId === FN);
    assert.equal(got, s.demoted,
      `${s.turns.join(' -> ')} : demoted=${got}, expected ${s.demoted}`);
  });
}

test('the recorded reason describes what was MEASURED, not consecutiveness we cannot prove', () => {
  clearDemotionsForModel(M);
  const a = agent();
  for (let i = 0; i < F; i++) turn(a, 'fail');
  const reason = loadDemotions(M).find((d) => d.functionId === FN)?.reason ?? '';

  assert.ok(reason.length > 0, 'a demotion with no reason is unauditable');
  assert.doesNotMatch(
    reason, /consecutive/i,
    `the reason claims consecutiveness: "${reason}". A clean turn that the producer could not ` +
    `attribute never reaches the reset, so the counter cannot prove turns were adjacent — ` +
    `only that no attributed success was seen between them. Say that instead.`,
  );
});
