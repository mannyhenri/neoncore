/**
 * WHERE A TASK-LIST RUN HAS GOT TO — lib/run-progress.ts and lib/confer-sizing.ts.
 *
 *   - the engine's own record: each dispatch's claim and each coverage check, summarised the way
 *     the run card shows it (a task BLOCKED then DONE on a retry is done, not both);
 *   - the progress document: remembered from a `PROGRESS:` line, served from disk ONLY when it is
 *     a .md under docs/progress/ in the repo of a cartridge on this run, on this machine. The path
 *     comes from an agent's output, so it is never trusted as a path to read;
 *   - a confer's build rounds, sized from the task count (or what is still open), capped, with a
 *     fallback — never a wild number.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from '../src/db.ts';
import {
  recordDispatch, recordCoverage, noteProgressDoc, progressSummary, readProgressDoc, parseProgressDoc,
} from '../src/lib/run-progress.ts';
import { resolveBuildRounds } from '../src/lib/confer-sizing.ts';
import { MAX_BUILD_ROUNDS } from '../src/lib/confer-conductor.ts';

let n = 0;
const iso = () => new Date().toISOString();

function run(): { runId: string; step: { id: string; name: string; workflowId: string } } {
  const runId = `rp-run-${++n}`;
  db.prepare(`INSERT INTO workflows (id,name,status,created_at,template_id,run_number) VALUES (?, 'Epic: Task by Task', 'running', ?, 'tpl', 1)`)
    .run(runId, iso());
  return { runId, step: { id: `rp-step-${n}`, name: 'Work Every Task', workflowId: runId } };
}

function cartridge(repo: string, machine = os.hostname()): string {
  const id = `rp-agent-${++n}`;
  db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
              VALUES (?,?,?,?,?,'claude','idle',?,?)`).run(id, id, machine, repo, path.basename(repo), iso(), `s-${id}`);
  return id;
}

test('the record: a task blocked then done on a retry counts once, as done', () => {
  const { runId, step } = run();
  recordDispatch(step, 'DONE R-1 · commit a1 · 3 remaining');
  recordDispatch(step, 'BLOCKED R-2 · 2 remaining');
  recordDispatch(step, 'Some prose with no claim');       // not a claim: not recorded
  recordDispatch(step, 'DONE R-3 · commit a3 · 1 remaining');
  let s = progressSummary(runId)!;
  assert.deepEqual([s.done, s.total, s.blocked, s.basis], [2, 3, 1, 'claims']);

  recordDispatch(step, 'DONE R-2 · commit a2 · 0 remaining'); // the retry
  s = progressSummary(runId)!;
  assert.deepEqual([s.done, s.total, s.blocked], [3, 3, 0]);
});

test('a coverage check is the exact count and outranks the estimate', () => {
  const { runId, step } = run();
  recordDispatch(step, 'DONE R-1 · 5 remaining');
  recordCoverage({ ...step, name: 'Verify Coverage' }, 'loop-back', { done: 4, total: 9, outstanding: [] });
  const s = progressSummary(runId)!;
  assert.deepEqual([s.done, s.total, s.basis], [4, 9, 'coverage']);
  assert.equal(progressSummary('no-such-run'), null);
});

test('the progress document: remembered from PROGRESS:, served only from a safe place', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-repo-'));
  fs.mkdirSync(path.join(repo, 'docs', 'progress'), { recursive: true });
  const docPath = path.join(repo, 'docs', 'progress', 'GRD-1712.md');
  fs.writeFileSync(docPath, '| ID | Status |\n|---|---|\n| GRD-1 | DONE |\n');
  const agentId = cartridge(repo);

  const { runId } = run();
  assert.equal(parseProgressDoc('EPIC: x\nPROGRESS: `' + docPath + '`'), docPath);
  noteProgressDoc(runId, agentId, `PROGRESS: ${docPath}`);
  assert.equal(progressSummary(runId)!.docPath, docPath);
  assert.match(readProgressDoc(runId)!.content ?? '', /GRD-1 \| DONE/);

  // Not yet written: said so, not an error.
  const { runId: r2 } = run();
  noteProgressDoc(r2, agentId, `PROGRESS: ${path.join(repo, 'docs', 'progress', 'later.md')}`);
  assert.match(readProgressDoc(r2)!.unavailable, /not written it/);

  // Outside docs/progress/, or outside any repo on the run: refused, whatever is there.
  for (const bad of [path.join(repo, 'secrets.md'), '/etc/progress/docs/progress/x.md', path.join(repo, 'docs', 'progress', '..', '..', 'x.md')]) {
    const { runId: r } = run();
    noteProgressDoc(r, agentId, `PROGRESS: ${bad}`);
    const v = readProgressDoc(r)!;
    assert.equal(v.content, null, `${bad} was served`);
  }

  // On another machine: named, with where to find it.
  const remoteRepo = '/home/elsewhere/repo';
  const remote = cartridge(remoteRepo, 'some-other-box');
  const { runId: r3 } = run();
  noteProgressDoc(r3, remote, `PROGRESS: ${remoteRepo}/docs/progress/GRD-9.md`);
  assert.match(readProgressDoc(r3)!.unavailable, /some-other-box/);
});

test('a confer\'s build rounds come from the task count, or what is left — capped, with a fallback', () => {
  const from = { step: 'Scope the Work', pattern: 'TASK_COUNT:\\s*(\\d+)', tasksPerRound: 2 };
  const rounds = (cfg: Record<string, unknown>, people: number, scope: string) =>
    resolveBuildRounds({ buildRounds: 3, buildRoundsFrom: from, ...cfg }, people, { 'Scope the Work': scope }).rounds;
  assert.equal(rounds({}, 2, 'TASK_COUNT: 1'), 1);
  assert.equal(rounds({}, 2, 'TASK_COUNT: 12'), 3);
  assert.equal(rounds({}, 3, 'TASK_COUNT: 40'), 7);
  assert.equal(rounds({}, 2, 'TASK_COUNT: 500'), MAX_BUILD_ROUNDS, 'a huge epic must not dispatch hundreds of milestones');
  assert.equal(rounds({ _coverageRemaining: 2 }, 2, 'TASK_COUNT: 40'), 1, 'a pass back to the confer is sized to what is LEFT');
  assert.equal(rounds({}, 2, 'no count here'), 3, 'an unreadable count falls back to the template');
  assert.equal(resolveBuildRounds({ buildRounds: 3 }, 2, {}).rounds, 3, 'no resolver: the template decides');
});
