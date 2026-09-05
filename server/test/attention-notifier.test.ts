// FIRST import — this file reaches db.ts through the notifier. See helpers/isolated-db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { ATTENTION_REASONS, type Attention } from '../src/lib/workflow-attention.ts';
import {
  actionsFor, attentionNotice, sweepAttention, registerAttentionActions,
  ACTION_PREFIX, MAX_ACTION_ID, __resetAttentionStateForTest,
} from '../src/lib/attention-notifier.ts';
import { registerChannel, clearChannels, type Notice } from '../src/lib/channels.ts';
import { listActions, clearRegistries } from '../src/lib/commands-registry.ts';

/**
 * Every reason a run can be blocked on a person must actually reach you — N3.
 *
 * SET-BASED OVER `ATTENTION_REASONS`, the registry in workflow-attention.ts, not over the
 * reasons that happened to be easy. The five were added because each one was, at some point,
 * invisible: the module's own header records a decision gate that sat `running` while "the run
 * said 1 running; the bell said nothing". A notifier that covers four of five reproduces that
 * exact bug for whichever one it missed, and looks complete in review.
 *
 * The second half is the harder half. Attention is DERIVED state, swept repeatedly; a notice is
 * one shot. Re-announcing an unresolved gate every pass would train you to ignore the channel,
 * which fails the phase more completely than sending nothing.
 */

// ── Coverage over the registry ───────────────────────────────────────────────

const WF = { id: 'wf1', name: 'CE: Full Delivery', run_number: 2 };

function attention(reason: string): Attention {
  return {
    reason: reason as Attention['reason'],
    stepId: STEP_ID,
    stepName: '[P4] Review Decision',
    detail: `"[P4] Review Decision" is blocked (${reason}).`,
  };
}

test('every reason in ATTENTION_REASONS produces a usable notice', () => {
  const failures: string[] = [];

  for (const reason of ATTENTION_REASONS) {
    const notice = attentionNotice(WF, attention(reason));

    if (!notice.title?.trim()) failures.push(`${reason}: empty title`);
    if (!notice.body?.trim()) failures.push(`${reason}: empty body`);
    // Without the reason on the payload, a channel or a later phase cannot route it.
    if (notice.data?.reason !== reason) failures.push(`${reason}: data.reason is ${notice.data?.reason}`);
    if (notice.data?.stepId !== attention(reason).stepId) failures.push(`${reason}: data.stepId missing`);
    // The step name is what tells you WHERE the run is stuck.
    if (!Object.values(notice.detail ?? {}).some((v) => v.includes('[P4] Review Decision'))) {
      failures.push(`${reason}: detail does not name the step`);
    }
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

/**
 * Which reasons resolve with a button, and which are answered another way.
 *
 * Stated as a table so that "this one has no actions" is a DECISION on the record rather than
 * an omission nobody notices — `failed` is breakage the plan says is never auto-resolved, and
 * `agent-waiting` needs free text a button cannot carry.
 */
const RESOLVABLE: Record<string, 'buttons' | 'told-how'> = {
  failed: 'told-how',
  interrupted: 'buttons',
  decision: 'buttons',        // one per option; none configured in this fixture
  'agent-waiting': 'told-how',
  'manual-advance': 'buttons',
};

test('every reason either offers a control or says how to resolve it — none is a dead end', () => {
  // A DECISION GATE WITH REAL OPTIONS must be in the database, or `decisionOptions` returns []
  // and the "has buttons" half of this test asserts nothing. The first version of this test
  // checked only the `told-how` side, and a mutation that deleted the Advance button passed it
  // — the exact partial coverage the file exists to catch, in the file itself.
  seedDecisionWithOptions();

  const failures: string[] = [];

  for (const reason of ATTENTION_REASONS) {
    const notice = attentionNotice(WF, attention(reason));
    const kind = RESOLVABLE[reason];
    if (!kind) { failures.push(`${reason}: not classified — add it to RESOLVABLE`); continue; }

    const actions = notice.actions ?? [];

    if (kind === 'buttons') {
      if (actions.length === 0) failures.push(`${reason}: classified as resolvable by button, but offers none`);
      for (const a of actions) {
        if (!a.label?.trim()) failures.push(`${reason}: a button has no label`);
        if (!a.id?.includes(':')) failures.push(`${reason}: button id "${a.id}" carries no payload`);
      }
    } else {
      if (actions.length) failures.push(`${reason}: expected no buttons, got ${actions.length}`);
      if (!notice.detail?.Resolve) failures.push(`${reason}: no buttons AND no Resolve hint — a dead end`);
    }
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('no action id can exceed the 100-character customId cap', () => {
  // Two uuids plus a prefix would overflow, which is why ids carry the step only. A silently
  // truncated customId produces a button that dispatches to nothing.
  const failures: string[] = [];
  const longStep = 'a'.repeat(36);

  for (const reason of ATTENTION_REASONS) {
    const acts = actionsFor({ ...attention(reason), stepId: longStep }) ?? [];
    for (const a of acts) {
      if (a.id.length > MAX_ACTION_ID) failures.push(`${reason}: id is ${a.id.length} chars — "${a.id}"`);
    }
  }
  // And the worst case the decide prefix can produce, with a generous option id.
  const worst = `${ACTION_PREFIX.decide}:${longStep}:${'o'.repeat(30)}`;
  if (worst.length > MAX_ACTION_ID) failures.push(`decide worst case is ${worst.length} chars`);

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('every action prefix a notice emits has a handler registered', () => {
  // A button whose prefix nobody registered replies "No handler" — indistinguishable from a
  // dead server, which is the note discord-bot.ts already makes.
  clearRegistries();
  registerAttentionActions();
  const registered = new Set(listActions());

  const missing: string[] = [];
  for (const reason of ATTENTION_REASONS) {
    for (const a of actionsFor(attention(reason)) ?? []) {
      const prefix = a.id.split(':')[0];
      if (!registered.has(prefix)) missing.push(`${reason} emits "${prefix}" with no handler`);
    }
  }
  // Cover the decide prefix too, which this fixture has no options for.
  for (const p of Object.values(ACTION_PREFIX)) {
    if (!registered.has(p)) missing.push(`${p} is never registered`);
  }

  assert.deepEqual(missing, [], `\n  ${missing.join('\n  ')}\n`);
});

// ── Not re-sending ───────────────────────────────────────────────────────────

const STEP_ID = '5b2f0f2c-8f7e-4a3f-9c1e-0a8d3b7c6e5f';

/** A decision gate carrying real options, at the id the fixtures above address. */
function seedDecisionWithOptions(): void {
  db.prepare('DELETE FROM workflow_steps').run();
  db.prepare('DELETE FROM workflows').run();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, description, status, created_at, run_number)
              VALUES ('wf1', 'CE: Full Delivery', '', 'running', ?, 2)`).run(now);
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, status, executor_type, executor_id, executor_config, auto_advance, position_y, created_at)
      VALUES (?, 'wf1', '[P4] Review Decision', 'running', 'decision', '',
              '{"question":"Ship it?","options":[{"id":"ship","label":"Ship"},{"id":"hold","label":"Hold"}]}',
              1, 0, ?)`).run(STEP_ID, now);
}

function seedBlockedRun(): void {
  db.prepare('DELETE FROM workflow_steps').run();
  db.prepare('DELETE FROM workflows').run();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, description, status, created_at, run_number)
              VALUES ('wf1', 'CE: Full Delivery', '', 'running', ?, 2)`).run(now);
  // A decision gate: running, executor_type 'decision' — reason 3 in workflow-attention.ts.
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, status, executor_type, executor_id, executor_config, auto_advance, position_y, created_at)
      VALUES ('s1', 'wf1', 'Review Decision', 'running', 'decision', '', '{"question":"Ship it?"}', 1, 0, ?)`).run(now);
}

function collector() {
  const seen: Notice[] = [];
  clearChannels();
  registerChannel({
    name: 'collector',
    isConfigured: () => true,
    async send(n) { seen.push(n); return { ok: true, dropped: [] }; },
  });
  return seen;
}

test('a run blocked on a decision notifies once, not on every sweep', async () => {
  __resetAttentionStateForTest();
  seedBlockedRun();
  const seen = collector();

  assert.equal(await sweepAttention(), 1, 'first sweep did not notify');
  assert.equal(await sweepAttention(), 0, 'second sweep re-notified the same blocker');
  assert.equal(await sweepAttention(), 0, 'third sweep re-notified the same blocker');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data?.reason, 'decision');
});

test('a run that moves to a DIFFERENT blocker notifies again', async () => {
  __resetAttentionStateForTest();
  seedBlockedRun();
  const seen = collector();
  await sweepAttention();

  // Answer the gate; break the run instead. Same workflow, new reason.
  db.prepare("UPDATE workflow_steps SET status = 'failed', executor_type = 'agent' WHERE id = 's1'").run();

  assert.equal(await sweepAttention(), 1, 'a new blocker on the same run was swallowed as a duplicate');
  assert.deepEqual(seen.map((n) => n.data?.reason), ['decision', 'failed']);
});

test('a resolved run forgets its key, so reaching the same gate again notifies again', async () => {
  __resetAttentionStateForTest();
  seedBlockedRun();
  const seen = collector();
  await sweepAttention();

  // Resolved: the gate completes, nothing is blocked.
  db.prepare("UPDATE workflow_steps SET status = 'completed' WHERE id = 's1'").run();
  assert.equal(await sweepAttention(), 0, 'an unblocked run notified');

  // Blocked again on the same step — a real thing to be told a second time.
  db.prepare("UPDATE workflow_steps SET status = 'running' WHERE id = 's1'").run();
  assert.equal(await sweepAttention(), 1, 'the same gate reached again was swallowed');
  assert.equal(seen.length, 2);
});

test('a workflow that is not running is never announced', async () => {
  __resetAttentionStateForTest();
  seedBlockedRun();
  const seen = collector();
  db.prepare("UPDATE workflows SET status = 'completed' WHERE id = 'wf1'").run();

  assert.equal(await sweepAttention(), 0);
  assert.equal(seen.length, 0);
});

test('the notifier module names no delivery app', () => {
  // N3's "Do not": "Write N3 against one app. It is written once, against Notice."
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'lib', 'attention-notifier.ts'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  for (const app of ['discord', 'slack', 'telegram', 'apns']) {
    assert.ok(!new RegExp(app, 'i').test(src), `attention-notifier.ts mentions ${app} in code`);
  }
});
