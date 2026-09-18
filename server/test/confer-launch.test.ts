/**
 * A FULLY-SPECIFIED CONFER RUN MUST LAUNCH — for every executor type, not the four someone listed.
 *
 * THE BUG. Pick a template, pick two cartridges to confer across, press Run, nothing happens.
 * Measured against the live database: **12 of 24 templates could not launch in confer mode**,
 * including `Epic: Confer Across Repos`, which was refused because of its own `confer` step.
 *
 * WHY. Two registries described the same thing and disagreed.
 *   · `CONFER_CONVERSION` (routes/workflows.ts) — a Record over the executor-type union, so
 *     adding a type fails to compile until someone decides. Correct by construction.
 *   · `CONFER_SATISFIED` (lib/workflow-launch.ts) — a hand-written Set of four names, consulted
 *     by the guard that refuses the launch AT THE DOOR, before the conversion can happen.
 * The guard is the one that runs first, and it had never heard of half the union. A type absent
 * from that Set is refused no matter what the conversion would have done with it.
 *
 * This is the same failure the codebase has already paid for three times — KNOWN_ENGINES as a
 * hand-maintained copy of AgentType, the escalation ladder as a copy of rollup(), AUTO_RESOLVABLE
 * as a copy of the attention registry. The fix is the same one: ONE registry, keyed by the union,
 * and the guard derives its answer from it instead of restating it.
 *
 * WHY THE TEST ITERATES THE UNION FROM SOURCE. A test listing the eight types would be a fourth
 * copy. It reads `StepExecutorType` out of types.ts, so a ninth type fails here until CONFER_FILL
 * covers it — which is the only way this stays true.
 *
 * THE THIRD BUG, found while writing this: `CONFER_CONVERSION` called `command` a 'no-agent'
 * step and the old guard agreed, but `executeCommandStep` opens with
 * `if (!step.executorId) throw new Error('Command step requires an agent ID')`. A confer run
 * containing a command step passed the door and died at that step. It needs a single cartridge,
 * and CONFER_FILL says so.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { unrunnableSteps, CONFER_FILL, type ConferFill } from '../src/lib/workflow-launch.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();

/** The union, read from source — never restated here. */
function executorTypes(): string[] {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/types.ts'), 'utf8');
  const m = src.match(/export type StepExecutorType\s*=\s*([^;]+);/);
  assert.ok(m, 'StepExecutorType union not found — the registry moved');
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
}

const iso = () => new Date().toISOString();
let n = 0;

/** Two real cartridges to confer across. */
function participants(): string[] {
  const ids = [`cf-a-${++n}`, `cf-b-${n}`];
  for (const id of ids) {
    db.prepare(
      `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
       VALUES (?,?,'mac',?,'repo','claude','idle',?,?)`,
    ).run(id, id, `/tmp/${id}`, iso(), `sess-${id}`);
  }
  return ids;
}

/** A template holding exactly one step of the given type, deferred as a template's steps are. */
function templateWithStep(type: string): string {
  const wfId = `cf-wf-${++n}`;
  db.prepare(
    `INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at)
     VALUES (?,?,'','pending','[]',?,'')`,
  ).run(wfId, `confer ${type}`, iso());
  db.prepare(
    `INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,
       executor_type,executor_id,executor_config,auto_advance,depends_on,created_at)
     VALUES (?,?,?,'',300,0,?, '__deferred__','{}',1,'[]',?)`,
  ).run(`cf-s-${n}`, wfId, `a ${type} step`, type, iso());
  return wfId;
}

// ── The registry covers the union, and nothing else ────────────────────────────────────

test('CONFER_FILL covers EVERY executor type — no type may be undecided', () => {
  const types = executorTypes();
  assert.equal(types.length, 8, `expected 8 executor types, found ${types.length} — union changed`);

  const missing = types.filter((t) => !(t in CONFER_FILL));
  assert.deepEqual(missing, [], `executor types with no confer disposition: ${missing.join(', ')}`);

  const extra = Object.keys(CONFER_FILL).filter((k) => !types.includes(k));
  assert.deepEqual(extra, [], `CONFER_FILL names types that do not exist: ${extra.join(', ')}`);

  const VALID: ConferFill[] = ['confer-all', 'single', 'multi-if-empty', 'none'];
  for (const t of types) {
    assert.ok(VALID.includes(CONFER_FILL[t as keyof typeof CONFER_FILL]),
      `${t} has an unknown disposition`);
  }
  console.log(`[set] ${types.length}/${types.length} executor types have a confer disposition`);
});

// ── The door lets every one of them through ────────────────────────────────────────────

test('EVERY executor type launches in confer mode — the door refuses none of them', () => {
  const types = executorTypes();
  const [a, b] = participants();
  const refused: string[] = [];

  for (const type of types) {
    const wfId = templateWithStep(type);
    const blocked = unrunnableSteps(wfId, { conferAllSteps: [a, b] });
    if (blocked.length > 0) refused.push(`${type} (${blocked[0].reason})`);
  }

  assert.deepEqual(refused, [],
    `confer mode refused at the door: ${refused.join(', ')} — a fully-specified confer must launch`);
  console.log(`[set] ${types.length}/${types.length} executor types pass the confer door`);
});

test('a confer with fewer than 2 cartridges is NOT treated as confer mode', () => {
  // One participant is an ordinary dispatch, and the door must still demand a cartridge —
  // otherwise "confer" becomes a way to bypass the assignment check entirely.
  const [a] = participants();
  const wfId = templateWithStep('claude-code');
  assert.equal(unrunnableSteps(wfId, { conferAllSteps: [a] }).length, 1,
    'a one-cartridge confer must not satisfy the door');
  assert.equal(unrunnableSteps(wfId, {}).length, 1, 'no confer at all must not satisfy the door');
});

test('confer mode does not rescue a step pinned to a cartridge that no longer exists', () => {
  // The conversion fills what is UNASSIGNED. A stale pin on a type the conversion does not
  // rewrite is still a dead step, and saying otherwise would hide breakage behind the mode.
  const [a, b] = participants();
  const wfId = templateWithStep('quality-gate');
  db.prepare("UPDATE workflow_steps SET executor_id = 'ghost-cartridge' WHERE workflow_id = ?").run(wfId);
  const blocked = unrunnableSteps(wfId, { conferAllSteps: [a, b] });
  assert.equal(blocked.length, 1, 'a stale pin must survive confer mode as a real refusal');
  assert.equal(blocked[0].reason, 'cartridge-gone');
});

// ── The whole template set, which is what the user actually hit ────────────────────────

test('EVERY template in the database can be launched in confer mode', () => {
  const [a, b] = participants();
  // The real templates only. This file's own single-step fixtures are also `template_id IS
  // NULL`, and one of them is deliberately pinned to a dead cartridge — counting it here would
  // assert that a stale pin launches, which is the opposite of what the test above proves.
  const templates = db.prepare(
    "SELECT id, name FROM workflows WHERE template_id IS NULL AND id NOT LIKE 'cf-wf-%' ORDER BY name",
  ).all() as { id: string; name: string }[];
  assert.ok(templates.length > 0);

  const blocked: string[] = [];
  for (const t of templates) {
    const bad = unrunnableSteps(t.id, { conferAllSteps: [a, b] });
    if (bad.length > 0) blocked.push(`${t.name} → ${bad.map((x) => x.name).join(', ')}`);
  }
  assert.deepEqual(blocked, [],
    `${blocked.length}/${templates.length} templates still cannot confer:\n  ${blocked.join('\n  ')}`);
  console.log(`[set] ${templates.length}/${templates.length} templates launch in confer mode`);
});

// ── The duplicate registry must not come back ──────────────────────────────────────────

test('the guard derives from the registry — no second list of type names', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '../src/lib/workflow-launch.ts'), 'utf8');
  assert.ok(!/CONFER_SATISFIED/.test(src),
    'CONFER_SATISFIED is back — the guard must read CONFER_FILL, not restate the union');

  const route = fs.readFileSync(
    path.join(import.meta.dirname, '../src/routes/workflows.ts'), 'utf8');
  assert.match(route, /CONFER_FILL/,
    'the conversion must apply the same registry the door checks, or they drift again');
});
