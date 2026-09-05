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
  listAutoResolutions, isAutonomyLevel, recommendationOf,
  getAutoResolution, isOverridable, OVERRIDE_WINDOW_MS, type AutonomyLevel,
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

test('advance grants only the reasons where nothing is decided for you', () => {
  // `manual-advance` releases work that is already finished. `agent-idle` nudges a cartridge to
  // complete the instruction it was already given. Neither picks anything on your behalf, which
  // is the whole definition of this level — so the assertion is the PROPERTY, not a fixed list
  // that has to be edited every time a reason is added.
  assert.deepEqual(AUTO_RESOLVABLE.advance.slice().sort(), ['agent-idle', 'manual-advance']);

  const DECIDES_FOR_YOU: string[] = ['decision', 'agent-waiting'];
  for (const r of AUTO_RESOLVABLE.advance) {
    assert.ok(!DECIDES_FOR_YOU.includes(r),
      `advance grants ${r}, which makes a choice for you — that belongs to full`);
  }
});

/**
 * THE ORDERING CONSTRAINT, LIFTED ON THE RECORD.
 *
 * This test previously asserted `full` granted nothing beyond `advance`, so that anyone growing
 * it had to come here first and ask whether the machinery had landed. That is exactly what
 * happened: `full` was asked for, and it ships WITH the two things that gate it — the
 * hold-if-no-default rule and the override window. The assertion inverts rather than
 * disappearing, because "full is a strict superset of advance" is the property that stays true.
 */
test('full is a strict superset of advance, and both are settable', () => {
  for (const r of AUTO_RESOLVABLE.advance) {
    assert.ok(AUTO_RESOLVABLE.full.includes(r), `full lost ${r}, which advance grants`);
  }
  const extra = AUTO_RESOLVABLE.full.filter((r) => !AUTO_RESOLVABLE.advance.includes(r));
  assert.deepEqual(extra.slice().sort(), ['agent-waiting', 'decision'],
    'full must add decision gates and agent questions, and nothing else');
  assert.ok(AUTO_RESOLVABLE.full.includes('agent-idle'),
    'full must still nudge a stalled cartridge — it is a superset of advance');

  assert.deepEqual(SETTABLE_LEVELS.slice().sort(), ['advance', 'full', 'manual']);
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
  // This asserted "no buttons" until the override window shipped. That was the wrong call:
  // an auto-resolution you cannot take back is automation you watch rather than trust.
  assert.equal(seen[0].actions?.length, 1, 'an auto-resolution shipped with no way to reverse it');
  assert.equal(seen[0].actions?.[0].label, 'Override');

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

// ── full: decision gates, and the hold rule ──────────────────────────────────

/** A decision gate with a recommendation — the configured default `full` is allowed to take. */
function seedDecisionGate(recommendation: string | null): void {
  const now = new Date().toISOString();
  const cfg = {
    question: 'Ship it?',
    ...(recommendation ? { recommendation } : {}),
    options: [{ id: 'ship', label: 'Ship it' }, { id: 'hold', label: 'Hold' }],
  };
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, status, executor_type, executor_id, executor_config, auto_advance, position_y, created_at)
      VALUES ('d1','wf1','[P4] Review Decision','running','decision','',?,1,0,?)`)
    .run(JSON.stringify(cfg), now);
}

/**
 * THE SET: what a gate's config can look like, and whether it constitutes a default.
 *
 * "What full does at a decision gate with no configured default" was flagged as a tunable and
 * set to HOLD. A stale recommendation — one naming an option that no longer exists — is the
 * same case and the easy one to get wrong: it looks configured and is not.
 */
const GATE_CONFIGS: { label: string; config: string; want: string | null }[] = [
  { label: 'a recommendation matching an option', config: '{"recommendation":"ship","options":[{"id":"ship"},{"id":"hold"}]}', want: 'ship' },
  { label: 'no recommendation at all', config: '{"options":[{"id":"ship"}]}', want: null },
  { label: 'an empty recommendation', config: '{"recommendation":"","options":[{"id":"ship"}]}', want: null },
  { label: 'a STALE recommendation naming a removed option', config: '{"recommendation":"gone","options":[{"id":"ship"}]}', want: null },
  { label: 'no options at all', config: '{"recommendation":"ship"}', want: null },
  { label: 'unparseable config', config: 'not json', want: null },
  { label: 'empty config', config: '', want: null },
];

test('a configured default is recognised, and anything less is not', () => {
  const failures: string[] = [];
  for (const c of GATE_CONFIGS) {
    const got = recommendationOf(c.config);
    if (got !== c.want) failures.push(`${c.label}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('at full, a decision gate is taken by its recommendation and recorded', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'full', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedDecisionGate('ship');
  const seen = collector();

  await sweepAttention();

  const step = db.prepare("SELECT status, result FROM workflow_steps WHERE id='d1'").get() as { status: string; result: string };
  assert.equal(step.status, 'completed', 'the gate was not taken');
  assert.match(step.result, /ship/);

  const audit = listAutoResolutions('wf1');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, 'decision');
  assert.equal(audit[0].chose, 'Ship it', 'the audit should record the LABEL a person would recognise');
  assert.equal(seen[0].data?.type, 'workflow_auto_resolved');
});

test('at full, a gate with NO configured default holds and asks — it never invents a branch', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'full', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedDecisionGate(null);
  const seen = collector();

  await sweepAttention();

  const step = db.prepare("SELECT status FROM workflow_steps WHERE id='d1'").get() as { status: string };
  assert.equal(step.status, 'running', 'a gate with no default was decided anyway');
  assert.equal(seen[0].data?.type, 'workflow_attention', 'it should ASK, not announce');
  assert.deepEqual(listAutoResolutions('wf1'), []);
});

test('at advance, a decision gate is never touched', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedDecisionGate('ship');
  const seen = collector();

  await sweepAttention();
  const step = db.prepare("SELECT status FROM workflow_steps WHERE id='d1'").get() as { status: string };
  assert.equal(step.status, 'running', 'advance decided something');
  assert.equal(seen[0].data?.type, 'workflow_attention');
});

// ── the override window ──────────────────────────────────────────────────────

test('every auto-resolution carries an Override button', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedHeldStep();
  const seen = collector();

  await sweepAttention();
  const actions = seen[0].actions ?? [];
  assert.equal(actions.length, 1, 'an auto-resolution shipped with no way to take it back');
  assert.match(actions[0].id, /^wfundo:/);
  assert.equal(actions[0].label, 'Override');
  assert.ok(seen[0].data?.resolutionId, 'the notice must carry the audit row id the button acts on');
});

test('an override inside the window reverses the action and marks the audit row', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedHeldStep();
  collector();
  await sweepAttention();

  const id = listAutoResolutions('wf1').length ? getAutoResolution(
    (db.prepare('SELECT id FROM workflow_auto_resolutions LIMIT 1').get() as { id: string }).id,
  ) : null;
  assert.ok(id, 'no audit row to override');
  assert.equal(isOverridable(id!), true, 'a fresh resolution should be overridable');
});

test('the window CLOSES — an old resolution is not reversible from a notification', () => {
  // Past the window the run has built on the decision, so reversing one step in isolation is a
  // repair rather than an undo. The button must say so instead of half-working.
  const stale = {
    id: 'r1', workflowId: 'wf1', stepId: 's1', reason: 'manual-advance' as const,
    chose: 'advance', autonomy: 'advance' as const, overridden: 0,
    createdAt: new Date(Date.now() - OVERRIDE_WINDOW_MS - 1000).toISOString(),
  };
  assert.equal(isOverridable(stale), false, 'an expired resolution was still overridable');

  const fresh = { ...stale, createdAt: new Date().toISOString() };
  assert.equal(isOverridable(fresh), true);

  const already = { ...fresh, overridden: 1 };
  assert.equal(isOverridable(already), false, 'an already-reversed resolution was overridable twice');
});

// ── the stall, and answering ─────────────────────────────────────────────────

/** A step dispatched to a cartridge that then went quiet without reporting. */
function seedStalledStep(quietMinutes: number, agentStatus = 'idle'): void {
  const now = new Date().toISOString();
  const lastSeen = new Date(Date.now() - quietMinutes * 60_000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO agents
      (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
      VALUES ('cart1','box/repo','box','/tmp/repo','repo',?,?,'sess','claude')`)
    .run(agentStatus, lastSeen);
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, status, executor_type, executor_id, executor_config,
       auto_advance, position_y, created_at, dispatched_prompt, result)
      VALUES ('st1','wf1','Load Epic','running','claude-code','cart1','{}',1,0,?,'do the thing','')`)
    .run(now);
}

test('a dispatched step whose cartridge went quiet is DETECTED — it used to be invisible', async () => {
  const { workflowNeedsAttention } = await import('../src/lib/workflow-attention.ts');
  __resetAttentionStateForTest();
  seedRun();
  seedStalledStep(30);

  const a = workflowNeedsAttention('wf1');
  assert.equal(a?.reason, 'agent-idle',
    'a run with a dispatched-and-abandoned step reported ' + (a?.reason ?? 'nothing') +
    ' — this is the failure that looks exactly like health');
});

test('a cartridge that is merely between tool calls is NOT accused of stalling', async () => {
  const { workflowNeedsAttention } = await import('../src/lib/workflow-attention.ts');
  // `blocked on a question` needs an ACTUAL question. Without one, `waiting` is a stale flag and
  // being called a stall is now the correct answer — this case asserted the opposite until the
  // rule changed, which is the test doing its job rather than the code being wrong.
  const CASES = [
    { label: 'quiet for only a minute', minutes: 1, status: 'idle', question: '' },
    { label: 'actively working', minutes: 60, status: 'working', question: '' },
    { label: 'blocked on a real question', minutes: 60, status: 'waiting', question: 'Which approach?' },
  ];
  const failures: string[] = [];
  for (const c of CASES) {
    __resetAttentionStateForTest();
    seedRun();
    seedStalledStep(c.minutes, c.status);
    db.prepare("UPDATE agents SET pending_question = ? WHERE id = 'cart1'").run(c.question);
    const a = workflowNeedsAttention('wf1');
    if (a?.reason === 'agent-idle') failures.push(`${c.label}: wrongly called a stall`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('at advance, a stalled step is nudged once and never again', async () => {
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedStalledStep(30);
  const seen = collector();

  await sweepAttention();
  const after = db.prepare("SELECT recovery_attempts FROM workflow_steps WHERE id='st1'").get() as { recovery_attempts: number };
  assert.equal(after.recovery_attempts, 1, 'the stalled cartridge was not nudged');
  assert.equal(seen[0]?.data?.type, 'workflow_auto_resolved');
  assert.equal(listAutoResolutions('wf1')[0]?.chose, 'nudged');

  // A cartridge that ignores the first nudge must not be pestered every sweep forever.
  __resetAttentionStateForTest();
  await sweepAttention();
  const twice = db.prepare("SELECT recovery_attempts FROM workflow_steps WHERE id='st1'").get() as { recovery_attempts: number };
  assert.equal(twice.recovery_attempts, 1, 'it nudged a second time — a stall that survives a nudge is a person\'s problem');
});

test('at manual, a stalled step is reported and NOT touched', async () => {
  __resetAttentionStateForTest();
  seedRun();
  seedStalledStep(30);
  const seen = collector();

  await sweepAttention();
  const after = db.prepare("SELECT recovery_attempts FROM workflow_steps WHERE id='st1'").get() as { recovery_attempts: number };
  assert.equal(after.recovery_attempts, 0, 'manual nudged something');
  assert.equal(seen[0]?.data?.type, 'workflow_attention');
  assert.ok(seen[0]?.detail?.Resolve, 'no buttons and no hint — the reader is told nothing');
});

/**
 * THE SET: a cartridge's status crossed with whether anything is genuinely outstanding.
 *
 * `waiting` with nothing pending is the case that cost a whole run. Claude Code fires a
 * `notification` hook when a turn simply ends, which sets `waiting` with no question attached —
 * so the run reported "the cartridge is waiting for your input" while there was nothing to
 * input, `full` correctly refused to invent an answer, and it sat there. queue-runner.ts had
 * already written the rule down for the queue; this applies it to attention.
 */
const WAITING_CASES: { label: string; status: string; question: string; perm: boolean; want: string | null }[] = [
  { label: 'waiting WITH a question banner', status: 'waiting', question: 'Which approach?', perm: false, want: 'agent-waiting' },
  { label: 'waiting WITH a pending permission', status: 'waiting', question: '', perm: true, want: 'agent-waiting' },
  { label: 'waiting with NOTHING outstanding', status: 'waiting', question: '', perm: false, want: 'agent-idle' },
  { label: 'idle with nothing outstanding', status: 'idle', question: '', perm: false, want: 'agent-idle' },
  { label: 'working', status: 'working', question: '', perm: false, want: null },
];

test('a cartridge is only WAITING when something is actually outstanding', async () => {
  const { workflowNeedsAttention } = await import('../src/lib/workflow-attention.ts');
  const failures: string[] = [];

  for (const c of WAITING_CASES) {
    __resetAttentionStateForTest();
    seedRun();
    seedStalledStep(30, c.status);
    db.prepare("UPDATE agents SET pending_question = ? WHERE id = 'cart1'").run(c.question);
    db.prepare('DELETE FROM permissions').run();
    if (c.perm) {
      db.prepare(`INSERT INTO permissions (id, agent_id, tool_name, tool_input, description, status, created_at)
                  VALUES ('p1','cart1','AskUserQuestion','{}','','pending',?)`).run(new Date().toISOString());
    }

    const got = workflowNeedsAttention('wf1')?.reason ?? null;
    if (got !== c.want) failures.push(`${c.label}: got ${got}, expected ${c.want}`);
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('a stale waiting flag is nudged by advance, exactly like an idle one', async () => {
  // The whole point: the two are the same abandonment wearing different labels, so the level
  // that fixes one must fix the other.
  __resetAttentionStateForTest();
  seedRun({ autonomy: 'advance', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  seedStalledStep(30, 'waiting');
  db.prepare("UPDATE agents SET pending_question = '' WHERE id = 'cart1'").run();
  db.prepare('DELETE FROM permissions').run();
  collector();

  await sweepAttention();
  const after = db.prepare("SELECT recovery_attempts FROM workflow_steps WHERE id='st1'").get() as { recovery_attempts: number };
  assert.equal(after.recovery_attempts, 1, 'a stale waiting flag was not nudged — the run would sit');
});
