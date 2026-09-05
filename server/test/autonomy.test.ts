// FIRST import — reaches db.ts through autonomy.ts. See helpers/isolated-db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { ATTENTION_REASONS } from '../src/lib/workflow-attention.ts';
import {
  AUTONOMY_LEVELS, AUTO_RESOLVABLE, NEVER_AUTO, SETTABLE_LEVELS,
  canAutoResolve, effectiveAutonomy, setWorkflowAutonomy, parseDuration,
  listAutoResolutions, isAutonomyLevel, type AutonomyLevel,
} from '../src/lib/autonomy.ts';
import { sweepAttention, __resetAttentionStateForTest } from '../src/lib/attention-notifier.ts';
import { registerChannel, clearChannels, type Notice } from '../src/lib/channels.ts';

/**
 * What a run may settle without you — N4.
 *
 * SET-BASED OVER THE CROSS-PRODUCT of AUTONOMY_LEVELS x ATTENTION_REASONS, both registries, not
 * over the combination someone happened to think about. Autonomy is where a partial
 * implementation is most expensive: every pair that is wrong is a thing decided on your behalf
 * that you did not agree to, discovered later from an audit table you had no reason to open.
 *
 * The invariant that outranks the table: "`failed` and `interrupted` are never auto-resolved at
 * any level — that is breakage, not a gate." Asserted against EVERY level, so a future level
 * cannot quietly acquire the ability to clear breakage.
 */

// Production always has a socket server; the stub keeps the tests on that path.
installStubIO();

const CROSS = AUTONOMY_LEVELS.flatMap((l) => ATTENTION_REASONS.map((r) => ({ level: l, reason: r })));

test('the cross-product is real — an empty scan would pass vacuously', () => {
  assert.equal(CROSS.length, AUTONOMY_LEVELS.length * ATTENTION_REASONS.length);
  assert.ok(CROSS.length >= 15, `expected >=15 level x reason pairs, got ${CROSS.length}`);
});

test('every level x reason pair resolves exactly as its level declares', () => {
  const failures: string[] = [];
  for (const { level, reason } of CROSS) {
    const want = AUTO_RESOLVABLE[level].includes(reason) && !NEVER_AUTO.includes(reason);
    const got = canAutoResolve(level, reason);
    if (got !== want) failures.push(`${level} x ${reason}: canAutoResolve=${got}, declared ${want}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('breakage is never auto-resolved, at ANY level — including levels added later', () => {
  // This outranks AUTO_RESOLVABLE: even if someone lists 'failed' in a level's array, the
  // guard in canAutoResolve must still refuse it.
  const failures: string[] = [];
  for (const level of AUTONOMY_LEVELS) {
    for (const reason of NEVER_AUTO) {
      if (canAutoResolve(level, reason)) failures.push(`${level} would auto-resolve ${reason}`);
    }
    // And the declaration itself should not claim it either.
    for (const reason of AUTO_RESOLVABLE[level]) {
      if (NEVER_AUTO.includes(reason)) failures.push(`${level} DECLARES ${reason}, which is breakage`);
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('manual grants nothing', () => {
  assert.deepEqual(AUTO_RESOLVABLE.manual, []);
  for (const reason of ATTENTION_REASONS) assert.equal(canAutoResolve('manual', reason), false);
});

test('advance grants exactly reason 5 — releasing a finished step decides nothing', () => {
  assert.deepEqual(AUTO_RESOLVABLE.advance, ['manual-advance']);
});

/**
 * THE ORDERING CONSTRAINT, ENCODED.
 *
 * The plan's "Do not" is explicit: ship `advance` before `full`, live with it for a week. So
 * `full` exists in the schema and the audit but must grant nothing more than `advance` until
 * the hold-if-no-default rule and the override window are written. Asserting it here means the
 * day someone adds `decision` to `full` they must also come and change this test, which is the
 * moment to ask whether the machinery landed with it.
 */
test('full grants nothing beyond advance yet, and is not settable', () => {
  const extra = AUTO_RESOLVABLE.full.filter((r) => !AUTO_RESOLVABLE.advance.includes(r));
  assert.deepEqual(extra, [],
    `full grants ${extra.join(', ')} beyond advance — did the hold-if-no-default rule and ` +
    'override window ship with it? See docs/plans/build-order.md N4.');

  assert.ok(!SETTABLE_LEVELS.includes('full'), 'full must not be settable while it means nothing extra');
  assert.ok(SETTABLE_LEVELS.every((l) => isAutonomyLevel(l)), 'a settable level must be a known level');
});

// ── Effective level, and the time-box ────────────────────────────────────────

function seedRun(opts: { autonomy?: string; expiresAt?: string | null; projectDefault?: string } = {}): void {
  db.prepare('DELETE FROM workflow_steps').run();
  db.prepare('DELETE FROM workflows').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM workflow_auto_resolutions').run();
  const now = new Date().toISOString();

  if (opts.projectDefault !== undefined) {
    db.prepare(`INSERT INTO projects (id, name, description, created_at, updated_at, default_autonomy)
                VALUES ('p1', 'Film', '', ?, ?, ?)`).run(now, now, opts.projectDefault);
  }
  db.prepare(`INSERT INTO workflows
      (id, name, description, status, created_at, run_number, project_id, autonomy, autonomy_expires_at)
      VALUES ('wf1', 'CE: Full Delivery', '', 'running', ?, 2, ?, ?, ?)`)
    .run(now, opts.projectDefault !== undefined ? 'p1' : null, opts.autonomy ?? 'manual', opts.expiresAt ?? null);
}

test('an unset run is manual', () => {
  seedRun();
  const a = effectiveAutonomy('wf1');
  assert.equal(a.level, 'manual');
  assert.equal(a.source, 'default');
});

test('a live grant is in force, and reports when it ends', () => {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  seedRun({ autonomy: 'advance', expiresAt: until });
  const a = effectiveAutonomy('wf1');
  assert.equal(a.level, 'advance');
  assert.equal(a.source, 'workflow');
  assert.equal(a.expiresAt, until);
});

test('an EXPIRED grant stops applying — a time-box that keeps granting is decorative', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  seedRun({ autonomy: 'advance', expiresAt: past });
  const a = effectiveAutonomy('wf1');
  assert.equal(a.level, 'manual', 'an expired grant was still in force');
  assert.equal(a.source, 'expired', 'expiry is not distinguishable from never having been set');
});

test('an expired grant falls through to the PROJECT default, not the stale column', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  seedRun({ autonomy: 'advance', expiresAt: past, projectDefault: 'advance' });
  const a = effectiveAutonomy('wf1');
  assert.equal(a.level, 'advance');
  assert.equal(a.source, 'project', 'the run-level grant outlived its expiry');
});

test('the project default applies when the run has none', () => {
  seedRun({ projectDefault: 'advance' });
  assert.equal(effectiveAutonomy('wf1').source, 'project');
  assert.equal(effectiveAutonomy('wf1').level, 'advance');
});

test('a duration typo never becomes an unbounded grant', () => {
  const failures: string[] = [];
  for (const good of ['30m', '2h', '1d', ' 2h ']) {
    if (parseDuration(good) === null) failures.push(`${JSON.stringify(good)} should parse`);
  }
  for (const bad of ['', '2', 'h', '2 hours', 'forever', '0h', '-1h', '2w']) {
    if (parseDuration(bad) !== null) failures.push(`${JSON.stringify(bad)} should NOT parse`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

// ── The sweep actually resolving, and recording it ───────────────────────────

/** A held step: completed, auto_advance 0, with something still pending — reason 5. */
function seedHeldStep(): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, status, executor_type, executor_id, executor_config, auto_advance, position_y, created_at)
      VALUES ('s1','wf1','[P3] Build Summary','completed','agent','','{}',0,0,?)`).run(now);
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, status, executor_type, executor_id, executor_config, auto_advance, position_y, created_at)
      VALUES ('s2','wf1','[P4] Review','pending','agent','','{}',1,1,?)`).run(now);
}

function collector(): Notice[] {
  const seen: Notice[] = [];
  clearChannels();
  registerChannel({ name: 'c', isConfigured: () => true, async send(n) { seen.push(n); return { ok: true }; } });
  return seen;
}

test('at manual, a held step ASKS and is not released', async () => {
  __resetAttentionStateForTest();
  seedRun();
  seedHeldStep();
  const seen = collector();

  await sweepAttention();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data?.type, 'workflow_attention', 'manual auto-resolved something');
  assert.equal((db.prepare("SELECT auto_advance FROM workflow_steps WHERE id='s1'").get() as { auto_advance: number }).auto_advance, 0);
  assert.deepEqual(listAutoResolutions('wf1'), [], 'manual wrote an audit row');
});

test('at advance, a held step is released, announced, and RECORDED', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedHeldStep();
  const seen = collector();

  await sweepAttention();

  const step = db.prepare("SELECT auto_advance FROM workflow_steps WHERE id='s1'").get() as { auto_advance: number };
  assert.equal(step.auto_advance, 1, 'the held step was not released');

  assert.equal(seen.length, 1, 'an autonomous action was taken without telling anyone');
  assert.equal(seen[0].data?.type, 'workflow_auto_resolved');
  assert.deepEqual(seen[0].actions, [], 'nothing left to press, so no buttons');

  const audit = listAutoResolutions('wf1');
  assert.equal(audit.length, 1, 'no audit row — the plan calls the audit table not optional');
  assert.equal(audit[0].reason, 'manual-advance');
  assert.equal(audit[0].chose, 'advance');
  assert.equal(audit[0].autonomy, 'advance', 'the audit must record the level IN FORCE');
});

test('an EXPIRED advance grant does not release the step', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() - 60_000).toISOString() });
  seedHeldStep();
  const seen = collector();

  await sweepAttention();
  const step = db.prepare("SELECT auto_advance FROM workflow_steps WHERE id='s1'").get() as { auto_advance: number };
  assert.equal(step.auto_advance, 0, 'an expired grant released a step');
  assert.equal(seen[0].data?.type, 'workflow_attention');
});

test('the audit records the level in force even after the grant lapses', async () => {
  // The point of storing the level per row: a run raised for two hours and then lapsed must
  // still explain why it advanced itself at 3am.
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedHeldStep();
  collector();
  await sweepAttention();

  setWorkflowAutonomy('wf1', 'manual', null);
  assert.equal(effectiveAutonomy('wf1').level, 'manual');
  assert.equal(listAutoResolutions('wf1')[0].autonomy, 'advance', 'the audit followed the current level');
});
