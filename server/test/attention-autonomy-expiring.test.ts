/**
 * A GRANT THAT LAPSES AT 3AM STOPS THE RUN AT 3AM.
 *
 * When an autonomy grant expires the level falls back to `manual`, and from that moment every
 * attention reason holds instead of auto-resolving. So you ARE told — at the instant work stops,
 * which for an overnight epic is the middle of the night. Warning while the grant is still in
 * force costs one message and is actionable in exactly one way: extend it.
 *
 * ── NO FORECAST, ON PURPOSE ───────────────────────────────────────────────────────────
 * The obvious version compares an ESTIMATED finish (median cadence x loops remaining) against
 * the deadline and warns only when the run cannot make it. That multiplies two numbers which
 * were both wrong on live runs: a 19-task epic reported `TASKS: 1`, and observed cadence on one
 * run ranged 4 to 65 minutes. A detector built on those cries wolf, and its failure mode is
 * SILENCE — an optimistic forecast means no warning at all. This reads one column and states a
 * fact. The cost is a harmless warning for a run that would have finished in time anyway.
 *
 * ── WHY IT DOES NOT CALL effectiveAutonomy() ──────────────────────────────────────────
 * That is the authority on the level in force, and asking the authority is the rule this
 * codebase follows. It cannot be asked here: `autonomy.ts` imports `REASONS` at module top level
 * to derive AUTO_RESOLVABLE, so importing it back would make module init order decide whether
 * `REASONS` is in its temporal dead zone — a cycle that breaks on load, not at runtime.
 *
 * The detector therefore asks a NARROWER question that has no fallback semantics: is there a
 * workflow-level grant, not already lapsed, whose deadline is inside the window? A project
 * default never expires (`expiresAt: null`), so it is not in scope by construction. The last
 * test here pins the two in agreement so the narrow read cannot drift from the authority.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { workflowNeedsAttention, AUTONOMY_WARN_WINDOW_MS } from '../src/lib/workflow-attention.ts';
import { effectiveAutonomy } from '../src/lib/autonomy.ts';

installStubIO();

let n = 0;
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();

function run(o: { autonomy?: string | null; expiresIn?: number | null; projectDefault?: string } = {}): string {
  const id = `wf-aut-${++n}`;
  let projectId: string | null = null;
  if (o.projectDefault) {
    projectId = `proj-${++n}`;
    db.prepare('INSERT INTO projects (id,name,description,created_at,updated_at,default_autonomy) VALUES (?,?,?,?,?,?)')
      .run(projectId, 'P', '', iso(), iso(), o.projectDefault);
  }
  db.prepare(
    `INSERT INTO workflows (id,name,status,created_at,template_id,run_number,project_id,autonomy,autonomy_expires_at)
     VALUES (?,?,'running',?, 'tpl',1,?,?,?)`,
  // `autonomy` is TEXT NOT NULL DEFAULT 'manual' — an ungranted run stores the word, not null.
  ).run(id, `run ${id}`, iso(), projectId, o.autonomy ?? 'manual',
        o.expiresIn === null || o.expiresIn === undefined ? null : iso(o.expiresIn));

  const a = `ag-aut-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,?,'working',?,?,'')`,
  ).run(a, `m/${a}`, 'm', `/r/${a}`, 'r', 'claude', iso(), `s-${a}`);
  db.prepare(
    `INSERT INTO workflow_steps
       (id,workflow_id,name,description,position_x,position_y,status,executor_type,executor_id,
        executor_config,auto_advance,created_at,recovery_status,dispatched_prompt,result,started_at)
     VALUES (?,?,'Work','',0,1,'running','claude-code',?,'{}',1,?,'','do it','',?)`,
  ).run(`st-aut-${++n}`, id, a, iso(), iso(-60_000));
  return id;
}

const MIN = 60_000;

interface Case { label: string; opts: Parameters<typeof run>[0]; fires: boolean }

const CASES: Case[] = [
  { label: 'no grant at all — nothing can lapse', opts: {}, fires: false },
  { label: 'grant explicitly manual', opts: { autonomy: 'manual', expiresIn: 10 * MIN }, fires: false },
  {
    label: 'grant with hours left',
    opts: { autonomy: 'full', expiresIn: AUTONOMY_WARN_WINDOW_MS * 8 },
    fires: false,
  },
  {
    label: 'grant lapsing inside the window',
    opts: { autonomy: 'full', expiresIn: AUTONOMY_WARN_WINDOW_MS / 2 },
    fires: true,
  },
  {
    label: 'grant lapsing right at the window edge',
    opts: { autonomy: 'advance', expiresIn: AUTONOMY_WARN_WINDOW_MS - MIN },
    fires: true,
  },
  {
    // Already lapsed: the run has fallen back to manual and every reason now holds by itself.
    // Warning about a deadline that has passed is noise about a decision already made.
    label: 'grant already expired',
    opts: { autonomy: 'full', expiresIn: -5 * MIN },
    fires: false,
  },
  {
    // A project default has no expiry — `effectiveAutonomy` returns expiresAt: null for it.
    // There is no deadline, so there is nothing to warn about.
    label: 'project-default grant, which never expires',
    opts: { projectDefault: 'full' },
    fires: false,
  },
  {
    label: 'grant with no expiry set at all',
    opts: { autonomy: 'full', expiresIn: null },
    fires: false,
  },
];

test('EVERY grant shape resolves correctly', () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const id = run(c.opts);
    const got = workflowNeedsAttention(id);
    const fired = got?.reason === 'autonomy-expiring';
    if (fired !== c.fires) wrong.push(`${c.label}: fired=${fired}, expected ${c.fires}`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('the detail says how long is left and what to do', () => {
  const id = run({ autonomy: 'full', expiresIn: 12 * MIN });
  const got = workflowNeedsAttention(id);
  assert.equal(got?.reason, 'autonomy-expiring');
  assert.match(String(got?.detail), /\b12 minutes\b/, 'the time left is the actionable part');
  assert.match(String(got?.detail), /extend/i, 'and the action is to extend the grant');
});

test('it never claims a level the authority disagrees with', () => {
  // The detector reads the columns directly because it cannot import autonomy.ts (module cycle).
  // This pins the narrow read to the authority: whenever it warns, a grant really is in force.
  const wrong: string[] = [];
  for (const c of CASES) {
    const id = run(c.opts);
    const fired = workflowNeedsAttention(id)?.reason === 'autonomy-expiring';
    if (!fired) continue;
    const eff = effectiveAutonomy(id);
    if (eff.level === 'manual') wrong.push(`${c.label}: warned, but effectiveAutonomy says manual`);
    if (!eff.expiresAt) wrong.push(`${c.label}: warned, but the authority reports no deadline`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('a lapsed grant is silent here AND manual to the authority — they agree', () => {
  const id = run({ autonomy: 'full', expiresIn: -5 * MIN });
  assert.notEqual(workflowNeedsAttention(id)?.reason, 'autonomy-expiring');
  assert.equal(effectiveAutonomy(id).level, 'manual');
});
