/**
 * A goal must reach the agents working toward it.
 *
 * THE DEFECT THIS CLOSES. `sendCommandToAgent` is the single funnel every prompt in the fleet
 * passes through — dashboard, workflow steps, queued tasks, confer turns, agent handoffs. It
 * injected attachments, memory and the work standard, and never the goal. The only code that
 * read a goal at dispatch time was the heartbeat budget gate, reading `budget_usd` in order to
 * STOP work. So an executive could define a goal and every agent building toward it worked
 * blind: the goal could halt an agent, but never direct one.
 *
 * WHY THE TEST IS SET-BASED OVER THE FIELDS. The failure mode is a half-wired object — a
 * column added to the schema and the form, never read by the compiler, so it looks authored
 * and changes nothing. That is invisible from the UI, which is exactly how `successMetric`
 * spent its whole life. Iterating the field registry means a new goal field cannot ship
 * without either reaching the agent or being explicitly excluded.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { buildGoalBrief, goalForAgent, GOAL_BRIEF_MAX_CHARS } from '../src/lib/goal-brief.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function goal(fields: Record<string, unknown> = {}): string {
  const id = `goal-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, token_budget, budget_usd,
              status, created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results,
              autonomy, target_date)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,
      fields.name ?? 'Ship SSO for enterprise trials',
      fields.description ?? 'Three of the last five trials stalled at SSO.',
      fields.successMetric ?? '',
      null,
      fields.budgetUsd ?? 200,
      'active', ISO, ISO,
      fields.acceptanceCriteria ?? 'When an admin uploads an invalid IdP certificate, the system shall name the field at fault.',
      fields.noGos ?? 'SCIM provisioning. Redesigning the admin nav.',
      fields.rabbitHoles ?? 'Okta-specific shortcuts burned a week last quarter.',
      fields.invariants ?? 'Existing password sessions must not be invalidated.',
      fields.keyResults ?? JSON.stringify([
        { metric: 'SSO setup completion rate', baseline: '40%', target: '90%', measure: 'manual' },
      ]),
      fields.autonomy ?? 'supervised',
      fields.targetDate ?? '2030-01-31');
  return id;
}

function project(goalId: string | null, repoPath: string): string {
  const id = `proj-${++n}`;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
              VALUES (?,?,?,'',?,'#fff',?,?)`).run(id, goalId, `p-${id}`, repoPath, ISO, ISO);
  db.prepare('INSERT OR IGNORE INTO project_cartridges (project_id, repo_path) VALUES (?,?)').run(id, repoPath);
  return id;
}

function agent(repoPath: string): string {
  const id = `ag-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,'idle',?,'')`)
    .run(id, `t/${id}`, 'm', repoPath, path.basename(repoPath), 'claude', ISO);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY: every field an executive authors, and the words that prove it
// travelled. Derived from the goals table, not from the proposal.
// ─────────────────────────────────────────────────────────────────────────────

const AUTHORED_FIELDS: { column: string; label: string; sample: string; set: (v: string) => Record<string, unknown> }[] = [
  { column: 'name',                label: 'outcome',            sample: 'Ship SSO for enterprise trials', set: (v) => ({ name: v }) },
  { column: 'description',         label: 'why now',            sample: 'Three of the last five trials stalled at SSO.', set: (v) => ({ description: v }) },
  { column: 'acceptance_criteria', label: 'acceptance criteria', sample: 'the system shall name the field at fault', set: (v) => ({ acceptanceCriteria: v }) },
  { column: 'no_gos',              label: 'no-gos',             sample: 'SCIM provisioning', set: (v) => ({ noGos: v }) },
  { column: 'rabbit_holes',        label: 'rabbit holes',       sample: 'Okta-specific shortcuts burned a week', set: (v) => ({ rabbitHoles: v }) },
  { column: 'invariants',          label: 'invariants',         sample: 'password sessions must not be invalidated', set: (v) => ({ invariants: v }) },
  { column: 'key_results',         label: 'key results',        sample: 'SSO setup completion rate', set: () => ({}) },
  { column: 'budget_usd',          label: 'appetite',           sample: '200', set: () => ({}) },
  // Phase 7. Autonomy travels as an instruction — a posture the agent is not told about
  // changes nothing. The deadline travels because it changes how work should be scoped.
  { column: 'autonomy',            label: 'autonomy',           sample: 'Supervised', set: () => ({}) },
  { column: 'target_date',         label: 'target date',        sample: '2030-01-31', set: () => ({}) },
];

/**
 * AUTHORED BY A PERSON, BUT DELIBERATELY NOT SENT TO THE AGENT.
 *
 * The registry above encodes "authored ⇒ must reach the agent", and that premise was right
 * until Phase 7 added two fields it does not hold for. Rather than weakening the rule — or
 * quietly padding the brief with fields that change no behaviour — these are listed with the
 * reason, so leaving one out of the brief is a decision on the record rather than an omission.
 */
const AUTHORED_NOT_DISPATCHED: { column: string; why: string }[] = [
  { column: 'owner', why: 'accountability metadata — an agent does not work differently because of who owns the goal' },
  { column: 'investment_category', why: 'a finance and reporting attribute; it does not change how the work is done' },
];

test('the registry covers every authored column on the goals table', () => {
  // Both directions, so a column added to the schema cannot quietly skip the brief. Derived
  // columns (counts, timestamps, status) are excluded by name and reason.
  const cols = (db.prepare('PRAGMA table_info(goals)').all() as { name: string }[]).map((c) => c.name);
  // Not authored by a person, so not expected in the brief. `budget_alert_state` is machine
  // bookkeeping — which alert has already fired for this goal — kept on the row only because
  // the server restarts constantly under tsx watch and an in-memory guard would re-warn.
  const DERIVED = [
    'id', 'created_at', 'updated_at', 'status', 'token_budget', 'success_metric',
    'budget_alert_state',
  ];
  const excluded = new Set([...DERIVED, ...AUTHORED_NOT_DISPATCHED.map((f) => f.column)]);
  const authored = cols.filter((c) => !excluded.has(c));
  const covered = AUTHORED_FIELDS.map((f) => f.column);
  assert.deepEqual(authored.sort(), covered.sort(),
    'a goal column is authored by a human but never proved to reach the agent');
});

test('EVERY authored field reaches the compiled brief', () => {
  const g = goal();
  const brief = buildGoalBrief(g);
  assert.ok(brief, 'no brief was produced at all');

  const missing = AUTHORED_FIELDS.filter((f) => !brief!.includes(f.sample)).map((f) => f.label);
  assert.deepEqual(missing, [],
    `these fields are authored and never reach the agent — the exact defect successMetric had:\n  ${missing.join('\n  ')}`);
});

test('an agent resolves to its goal through the project that owns its cartridge', () => {
  const g = goal();
  project(g, '/repo/sso');
  const a = agent('/repo/sso');
  assert.equal(goalForAgent(a)?.id, g, 'the agent could not be traced to its goal');
});

test('a cartridge with no project, or a project with no goal, produces NO brief', () => {
  // Silence is the correct output. Injecting a placeholder would add noise to every prompt in
  // a fleet where most cartridges are not on a goal at all.
  const orphan = agent('/repo/unowned');
  assert.equal(goalForAgent(orphan), null);

  project(null, '/repo/goalless');
  const b = agent('/repo/goalless');
  assert.equal(goalForAgent(b), null);
  assert.equal(buildGoalBrief(''), '');
});

test('an empty field is omitted, not printed as an empty heading', () => {
  const g = goal({ noGos: '', rabbitHoles: '', invariants: '' });
  const brief = buildGoalBrief(g)!;
  for (const label of ['NO-GOS', 'RABBIT HOLES', 'INVARIANTS']) {
    assert.ok(!brief.includes(label), `${label} printed with nothing under it`);
  }
  assert.ok(brief.includes('Ship SSO'), 'the outcome should still be there');
});

test('the brief is capped — it competes with memory and the work standard for context', () => {
  const g = goal({ description: 'x'.repeat(20_000), noGos: 'y'.repeat(20_000) });
  const brief = buildGoalBrief(g)!;
  assert.ok(brief.length <= GOAL_BRIEF_MAX_CHARS,
    `brief is ${brief.length} chars, over the ${GOAL_BRIEF_MAX_CHARS} cap — it will crowd out memory`);
});

test('the dispatch funnel injects the brief', () => {
  // One place, and nine call sites inherit it: workflow steps, queued tasks, confer turns,
  // epic tasks, recovery replays, the dashboard and mobile. Asserted at the funnel rather than
  // per caller, because that is the property that makes the other eight free.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/lib/send-command.ts'), 'utf8');
  assert.match(src, /buildGoalBrief|goalBrief/,
    'send-command does not inject the goal brief, so no dispatched prompt carries the goal');
});
