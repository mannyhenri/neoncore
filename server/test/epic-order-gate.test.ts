/**
 * THE NEXT EPIC WAITS (docs/plans/epic-qa-any-project.md part 5, test 6): a feature's WORKFLOW stage
 * does not launch while an earlier epic of its project has not passed QA. Stage 0 (writing the
 * acceptance tests) and the review are never held. Passing the earlier epic frees it.
 *
 * SET-BASED: every earlier-epic QA state (epicQaOf: none · open · waiting · passed) × every stage
 * kind the pipeline launches (acceptance · workflow · review). No cartridge runs in the test repo,
 * so a workflow stage that gets PAST the wait parks on "No … cartridge is running" — that is how
 * the test tells "held by the epic" from "free to launch".
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { createPilotRow, setPhase, getStage } from '../src/lib/goal-pilot.js';
import { advancePilot } from '../src/lib/goal-pilot-runner.js';
import { createEpic, planFeature, setEpicQa } from '../src/lib/roadmap.js';
import { epicQaOf, type EpicQa } from '../src/lib/project-spec.js';
import { epicOrderWait, insertEpicRun, finishEpicRun, epicFinishedAt } from '../src/lib/qa/epic-qa-store.js';

installStubIO();

let n = 0;
const nowIso = () => new Date().toISOString();
function project(): string {
  const id = `eo-p-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'','/repo/none','#fff',?,?)`).run(id, `P${n}`, '2026-01-01', '2026-01-01');
  return id;
}
function goal(projectId: string, epicId: string, done: boolean): string {
  const id = `eo-g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, origin, done_at) VALUES (?,?,'',?,?,?,?,?,'planned',?)`)
    .run(id, `G${n}`, done ? 'achieved' : 'active', '2026-01-01', '2026-01-01', projectId, n, done ? nowIso() : '');
  planFeature(id, { epicId });
  return id;
}
/** Phase 0 in the given QA state; returns its id. */
function phase0(projectId: string, state: EpicQa): string {
  const e = createEpic(projectId, { name: 'Phase 0: Setup' }).id;
  if (state === 'open') goal(projectId, e, false);
  if (state === 'waiting' || state === 'passed') goal(projectId, e, true);
  if (state === 'passed') passWithRun(projectId, e);
  assert.equal(epicQaOf(e), state, 'the setup reaches the state');
  return e;
}
function passWithRun(projectId: string, epicId: string): void {
  const r = insertEpicRun(epicId, projectId, epicFinishedAt(epicId));
  finishEpicRun(r.id, { status: 'passed', checks: [], summary: '' });
  setEpicQa(epicId, true);
}
/** A Phase 1 feature whose pipeline is running, with one stage of `kind` next. */
function phase1Stage(projectId: string, kind: 'acceptance' | 'workflow' | 'review'): { goalId: string; pilotId: string; stageId: string } {
  const e1 = createEpic(projectId, { name: 'Phase 1: The log' }).id;
  const goalId = goal(projectId, e1, false);
  const pilot = createPilotRow({ goalId, plannerAgentId: 'nobody', intake: { goal: 'x' } });
  setPhase(pilot.id, 'running');
  const stageId = randomUUID();
  db.prepare(`INSERT INTO goal_pilot_stages (id, pilot_id, position, kind, stage_key, template_id, template_name, title, why, focus, repo_path, agent_type, project_id, status, participants, skip_steps)
              VALUES (?, ?, 0, ?, 's0', '', 'Build', 'Stage 1', '', '', '/repo/none', 'claude', ?, 'pending', '[]', '[]')`).run(stageId, pilot.id, kind, projectId);
  return { goalId, pilotId: pilot.id, stageId };
}
const EPIC_WAIT = /^Waiting for "Phase 0: Setup"/;

test('every earlier-epic state × every stage kind: only a workflow stage waits, and only on an unpassed epic', () => {
  const states: EpicQa[] = ['none', 'open', 'waiting', 'passed'];
  for (const state of states) {
    for (const kind of ['acceptance', 'workflow', 'review'] as const) {
      const p = project();
      phase0(p, state);
      const { goalId, pilotId, stageId } = phase1Stage(p, kind);
      const held = state === 'open' || state === 'waiting';
      assert.equal(!!epicOrderWait(goalId), held, `${state}: epicOrderWait`);
      advancePilot(pilotId);
      const s = getStage(stageId)!;
      const waitsOnEpic = s.status === 'waiting' && EPIC_WAIT.test(s.waitReason);
      assert.equal(waitsOnEpic, held && kind === 'workflow', `${state} × ${kind}: ${s.status} — ${s.waitReason}`);
    }
  }
});

test('the reason says which epic, and whether it is still being built or only waits for QA', () => {
  for (const [state, reason] of [['open', /finished and pass QA/], ['waiting', /^Waiting for "Phase 0: Setup" to pass QA\.$/]] as const) {
    const p = project();
    phase0(p, state);
    const { goalId } = phase1Stage(p, 'workflow');
    assert.match(epicOrderWait(goalId)!, reason, state);
  }
});

test('a feature in no epic, and the first epic, never wait', () => {
  const p = project();
  phase0(p, 'open');
  const id = `eo-g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, status, created_at, updated_at, project_id, position, origin) VALUES (?,?,'','active',?,?,?,?,'planned')`)
    .run(id, 'Loose', '2026-01-01', '2026-01-01', p, n);
  assert.equal(epicOrderWait(id), null, 'no epic');
  const q = project();
  const first = createEpic(q, { name: 'Phase 0: Setup' }).id;
  assert.equal(epicOrderWait(goal(q, first, false)), null, 'the first epic');
});

test('passing the earlier epic frees the waiting stage', async () => {
  const p = project();
  const e0 = phase0(p, 'waiting');
  const { pilotId, stageId } = phase1Stage(p, 'workflow');
  advancePilot(pilotId);
  assert.match(getStage(stageId)!.waitReason, EPIC_WAIT);
  passWithRun(p, e0);
  // setEpicQa re-advances the project's running pilots (a dynamic import, then the sweep as backstop).
  for (let i = 0; i < 50 && EPIC_WAIT.test(getStage(stageId)!.waitReason); i++) await new Promise((r) => setTimeout(r, 10));
  const s = getStage(stageId)!;
  assert.doesNotMatch(s.waitReason, EPIC_WAIT, 'no longer held by the epic');
  assert.match(s.waitReason, /No .* cartridge is running/, 'it went on to launch (and found no cartridge in the test repo)');
});
