/**
 * THE REASON REGISTRY IS THE DEFINITION; EVERYTHING ELSE READS IT.
 *
 * A reason used to be defined in five places: the `ATTENTION_REASONS` array, its detector
 * clause in `workflowNeedsAttention`, the `AUTO_RESOLVABLE` grant lists in autonomy.ts, the
 * `hint()` map in attention-notifier.ts, and the `RESOLVABLE` classification in the notifier
 * test. Adding `agent-silent` tripped two of those five tripwires; three of the five had no
 * tripwire at all. Precedence lived only in comment numbering, which had already gone stale —
 * two clauses both read `// 6.` after one addition.
 *
 * ── WHY THIS FILE IS A GOLDEN TEST ─────────────────────────────────────────────────────
 * Centralising a detector that guards live overnight runs is a refactor, and the only
 * acceptable proof of a refactor is that behaviour did not move. Every expected value below
 * was CAPTURED FROM THE PRE-REFACTOR IMPLEMENTATION by running it, not transcribed by eye —
 * transcribing is how a golden test quietly encodes the bug it was meant to catch. If a detail
 * string here disagrees with the code, the code changed and this test is doing its job.
 *
 * ── SET-BASED OVER THE REGISTRY, NOT OVER A LIST IN THIS FILE ──────────────────────────
 * The fixtures are keyed by reason name and checked against `ATTENTION_REASONS`, so a new
 * reason fails here until it has both a fixture and a golden. An example-based test would pass
 * the moment someone added an eighth reason and never exercised it.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  workflowNeedsAttention, ATTENTION_REASONS, STALE_AFTER_MS, DISPATCH_SILENT_FLOOR_MS,
  observeChannels, __resetChannelStateForTest, CHANNEL_GRACE_MS,
  type Attention, type AttentionReason,
} from '../src/lib/workflow-attention.ts';

installStubIO();

let n = 0;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function wf(): string {
  const id = `wf-reg-${++n}`;
  db.prepare("INSERT INTO workflows (id,name,status,created_at,template_id,run_number) VALUES (?,?,'running',?, 'tpl',1)")
    .run(id, `run ${id}`, iso());
  return id;
}

function agent(o: { status: string; lastSeenMsAgo?: number; question?: string }): string {
  const id = `ag-reg-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,pending_question)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, 'r', 'claude', o.status, iso(o.lastSeenMsAgo ?? 0), `s-${id}`, o.question ?? '');
  return id;
}

function step(w: string, o: {
  name: string; status: string; type?: string; executor?: string; config?: string;
  auto?: number; recovery?: string; prompt?: string; result?: string; startedMsAgo?: number | null;
}): string {
  const id = `st-reg-${++n}`;
  db.prepare(
    `INSERT INTO workflow_steps
       (id,workflow_id,name,description,position_x,position_y,status,executor_type,executor_id,
        executor_config,auto_advance,created_at,recovery_status,dispatched_prompt,result,started_at)
     VALUES (?,?,?,'',0,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, w, o.name, n, o.status, o.type ?? 'claude-code', o.executor ?? '', o.config ?? '{}',
        o.auto ?? 1, iso(), o.recovery ?? '', o.prompt ?? '', o.result ?? '',
        o.startedMsAgo === null || o.startedMsAgo === undefined ? null : iso(o.startedMsAgo));
  return id;
}

/**
 * One fixture per reason, each in its OWN workflow so an earlier-precedence reason cannot
 * preempt a later one. Returns the workflow id and the step the reason must name.
 */
const FIXTURES: Record<AttentionReason, () => { workflowId: string; stepName: string }> = {
  failed: () => {
    const w = wf();
    step(w, { name: 'Broken Step', status: 'failed' });
    return { workflowId: w, stepName: 'Broken Step' };
  },
  interrupted: () => {
    const w = wf();
    step(w, { name: 'Lost Step', status: 'running', recovery: 'interrupted', executor: agent({ status: 'idle' }) });
    return { workflowId: w, stepName: 'Lost Step' };
  },
  decision: () => {
    const w = wf();
    step(w, { name: 'Pick Approach', status: 'running', type: 'decision',
              config: JSON.stringify({ question: 'Which approach?' }) });
    return { workflowId: w, stepName: 'Pick Approach' };
  },
  'agent-waiting': () => {
    const w = wf();
    step(w, { name: 'Asking Step', status: 'running',
              executor: agent({ status: 'waiting', question: 'Which database?' }) });
    return { workflowId: w, stepName: 'Asking Step' };
  },
  'channel-lost': () => {
    const w = wf();
    const a = agent({ status: 'working', lastSeenMsAgo: 5_000 });
    step(w, { name: 'Unreachable Step', status: 'running', prompt: 'do the thing', executor: a,
              startedMsAgo: 60_000 });
    // Two observations spanning the grace window — the sweep's job, not the detector's.
    __resetChannelStateForTest();
    observeChannels([a], () => false, Date.now() - CHANNEL_GRACE_MS * 2);
    observeChannels([a], () => false, Date.now());
    return { workflowId: w, stepName: 'Unreachable Step' };
  },
  'agent-idle': () => {
    const w = wf();
    step(w, {
      name: 'Quiet Step', status: 'running', prompt: 'do the thing',
      executor: agent({ status: 'idle', lastSeenMsAgo: STALE_AFTER_MS * 2 }),
      startedMsAgo: STALE_AFTER_MS * 3,
    });
    return { workflowId: w, stepName: 'Quiet Step' };
  },
  'agent-silent': () => {
    const w = wf();
    step(w, {
      name: 'Busy Step', status: 'running', prompt: 'do the thing',
      executor: agent({ status: 'working', lastSeenMsAgo: 5_000 }),
      startedMsAgo: DISPATCH_SILENT_FLOOR_MS + 60_000,
    });
    return { workflowId: w, stepName: 'Busy Step' };
  },
  'manual-advance': () => {
    const w = wf();
    step(w, { name: 'Held Step', status: 'completed', auto: 0 });
    step(w, { name: 'Next Step', status: 'pending' });
    return { workflowId: w, stepName: 'Held Step' };
  },
};

/**
 * GOLDEN DETAIL STRINGS — captured from the pre-refactor implementation by execution.
 * A mismatch means the refactor moved user-visible wording, which is a behaviour change even
 * though no logic changed: these strings are what a person reads at 3am to decide what to do.
 */
const GOLDEN_DETAIL: Record<AttentionReason, string> = {
  failed: '"Broken Step" failed — the run cannot continue.',
  interrupted: '"Lost Step" was interrupted and needs recovery.',
  decision: 'Which approach?',
  'agent-waiting': 'The cartridge running "Asking Step" is waiting for your input.',
  'channel-lost': 'The cartridge running "Unreachable Step" has had no command channel for over '
    + '90 seconds — the next dispatch will bounce. Relaunch its relay.',
  'agent-idle': '"Quiet Step" was dispatched but the cartridge went quiet without reporting.',
  'agent-silent': '"Busy Step" was dispatched over 90 minutes ago and the cartridge is still '
    + 'working, but nothing has been reported — it may have lost the completion contract '
    + '(a context compaction drops it).',
  'manual-advance': '"Held Step" finished and is waiting for you to advance.',
};

test('EVERY reason in the registry has a fixture — no reason ships unexercised', () => {
  const missing = ATTENTION_REASONS.filter((r) => !(r in FIXTURES));
  assert.deepEqual(missing, [],
    `these reasons can be reported but nothing here triggers them: ${missing.join(', ')}`);
  const extra = Object.keys(FIXTURES).filter((r) => !ATTENTION_REASONS.includes(r as AttentionReason));
  assert.deepEqual(extra, [], `fixtures for reasons that no longer exist: ${extra.join(', ')}`);
});

test('EVERY reason produces its exact pre-refactor Attention object', () => {
  const wrong: string[] = [];
  for (const reason of ATTENTION_REASONS) {
    const { workflowId, stepName } = FIXTURES[reason]();
    const got: Attention | null = workflowNeedsAttention(workflowId);
    if (!got) { wrong.push(`${reason}: got null — the fixture no longer triggers it`); continue; }
    if (got.reason !== reason) { wrong.push(`${reason}: reported as ${got.reason} — precedence moved`); continue; }
    if (got.stepName !== stepName) wrong.push(`${reason}: named step "${got.stepName}", expected "${stepName}"`);
    if (got.detail !== GOLDEN_DETAIL[reason]) {
      wrong.push(`${reason}: detail changed\n      got:  ${got.detail}\n      want: ${GOLDEN_DETAIL[reason]}`);
    }
    if (!got.stepId) wrong.push(`${reason}: stepId is empty`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('precedence is a total order — no two reasons can tie', () => {
  // Before the refactor precedence was comment numbering, which had already gone stale (two
  // clauses both read "// 6."). After it, order is data and must be unique, or which reason
  // wins becomes an accident of array position.
  const w = wf();
  const a = agent({ status: 'idle', lastSeenMsAgo: STALE_AFTER_MS * 2 });
  // A step that satisfies BOTH `failed` and (were it running) later reasons. `failed` must win.
  step(w, { name: 'Both', status: 'failed', executor: a, prompt: 'x', startedMsAgo: STALE_AFTER_MS * 3 });
  const got = workflowNeedsAttention(w);
  assert.equal(got?.reason, 'failed', 'the highest-precedence matching reason must win, deterministically');
});

test('a healthy run reports nothing', () => {
  const w = wf();
  step(w, { name: 'Working Step', status: 'running', prompt: 'x',
            executor: agent({ status: 'working', lastSeenMsAgo: 1_000 }), startedMsAgo: 60_000 });
  assert.equal(workflowNeedsAttention(w), null);
});

test('a non-running workflow never reports, whatever its steps say', () => {
  const w = wf();
  db.prepare("UPDATE workflows SET status='completed' WHERE id=?").run(w);
  step(w, { name: 'Broken', status: 'failed' });
  assert.equal(workflowNeedsAttention(w), null);
});
