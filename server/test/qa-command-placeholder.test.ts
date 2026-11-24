/**
 * `{n}` IN A QA COMMAND IS THE EPIC'S PHASE NUMBER — so one project command, e.g.
 * `bash scripts/run_gates.sh {n}`, gates every phase (Beam, FacetDB). Deferred by the dashboard
 * track because the server did not substitute it.
 * n = the first number in the epic's name ("Phase 0: Setup" → 0); a name with no number → the
 * epic's 0-based place in the project's epic order.
 * SET: every name shape × {project default, epic override} × {no {n}, one, several}.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { createEpic } from '../src/lib/roadmap.js';
import { qaCommandFor } from '../src/lib/qa/epic-qa-store.js';

let n = 0;
function project(qa: string): string {
  const id = `ph-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at, qa_command) VALUES (?,?,'','/code/x','#fff',?,?,?)`)
    .run(id, `P${n}`, '2026-01-01', '2026-01-01', qa);
  return id;
}

const NAMES: [string, (idx: number) => string][] = [
  ['Phase 0: Setup', () => '0'],
  ['Phase 12 — Planner', () => '12'],
  ['Epic 3 stretch', () => '3'],
  ['Setup (no number)', (idx) => String(idx)],
];
const COMMANDS: [string, (v: string) => string][] = [
  ['bash scripts/run_gates.sh', () => 'bash scripts/run_gates.sh'],
  ['bash scripts/run_gates.sh {n}', (v) => `bash scripts/run_gates.sh ${v}`],
  ['make gate-{n} && ./check {n}', (v) => `make gate-${v} && ./check ${v}`],
];

for (const where of ['project default', 'epic override'] as const) {
  for (const [cmd, expected] of COMMANDS) {
    test(`${where}: "${cmd}" for every epic name shape`, () => {
      const p = project(where === 'project default' ? cmd : '');
      // A filler epic first, so a number-less name's place (1, 2, …) differs from any number in a name.
      createEpic(p, { name: 'Filler epic' });
      NAMES.forEach(([name, value], i) => {
        const e = createEpic(p, { name }).id;
        if (where === 'epic override') db.prepare('UPDATE epics SET qa_command = ? WHERE id = ?').run(cmd, e);
        assert.equal(qaCommandFor(e), expected(value(i + 1)), name);
      });
    });
  }
}

test('no command anywhere → empty, placeholder or not', () => {
  const p = project('');
  const e = createEpic(p, { name: 'Phase 4' }).id;
  assert.equal(qaCommandFor(e), '');
});
