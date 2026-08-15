/**
 * A run that cannot advance without a human must SAY SO.
 *
 * WHAT HAPPENED. `[P1] Pick Approach` is a `decision` step. It sat `running` with
 * `dispatched_prompt` empty — nothing was ever sent to an agent, because decision steps wait
 * for a person to choose. From every surface it looked identical to a step doing work: the run
 * said "1 running", the bell said nothing. gridlight spent a turn investigating, correctly
 * reported that its queue was empty and no step had been dispatched to it, and refused to
 * invent a step id. The agent behaved perfectly; the system told nobody.
 *
 * WHY A DERIVED FLAG AND NOT JUST A NOTIFICATION. `workflow_notification` fires exactly twice
 * in the executor — manual-advance, and the `system-notify` connector. Decision gates send a
 * phone push and nothing to the dashboard; failed and interrupted steps send neither. But even
 * fixing the emissions is not enough: a notification is a one-shot event that can be missed,
 * dismissed, or fired while nobody was looking. The question "is this run waiting on me right
 * now?" must be answerable from state at any moment, so it is DERIVED rather than remembered.
 *
 * The set is every state in which a running workflow is blocked on a person. Covering four of
 * five leaves one shape of stall silently indistinguishable from work — which is the exact bug
 * being fixed, one state narrower.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { workflowNeedsAttention, ATTENTION_REASONS } from '../src/lib/workflow-attention.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function run(): string {
  const id = `wf-att-${++n}`;
  db.prepare("INSERT INTO workflows (id, name, status, created_at, template_id, run_number) VALUES (?,?,'running',?, 'tpl', 1)")
    .run(id, `run ${id}`, ISO);
  return id;
}

function step(wf: string, over: {
  status?: string; type?: string; auto?: number; recovery?: string; executor?: string; config?: string;
} = {}): string {
  const id = `st-att-${++n}`;
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, position_y, status, executor_type, executor_id, executor_config,
       auto_advance, created_at, recovery_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, wf, `step ${n}`, n, over.status ?? 'running', over.type ?? 'claude-code',
         over.executor ?? '', over.config ?? '{}', over.auto ?? 1, ISO, over.recovery ?? '');
  return id;
}

function agent(status: string): string {
  const id = `ag-att-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/r', 'r', 'claude', status, ISO);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SET: every way a running workflow ends up waiting on a person.
// ─────────────────────────────────────────────────────────────────────────────

test('the reason registry is non-empty and every reason is reachable', () => {
  // A reason nothing can produce is dead code that reads as coverage.
  assert.ok(ATTENTION_REASONS.length >= 4,
    `expected the human-blocking states, found ${ATTENTION_REASONS.length}`);
});

test('EVERY human-blocking state is detected', () => {
  const CASES: { label: string; reason: string; build: () => string }[] = [
    {
      label: 'a decision step awaiting a choice — the reported bug',
      reason: 'decision',
      build: () => {
        const wf = run();
        step(wf, { status: 'completed' });
        step(wf, { status: 'running', type: 'decision', config: JSON.stringify({ question: 'Which approach?' }) });
        return wf;
      },
    },
    {
      label: 'a step completed but held for manual advance',
      reason: 'manual-advance',
      build: () => {
        const wf = run();
        step(wf, { status: 'completed', auto: 0 });
        step(wf, { status: 'pending' });
        return wf;
      },
    },
    {
      label: 'a failed step — the run cannot continue itself',
      reason: 'failed',
      build: () => {
        const wf = run();
        step(wf, { status: 'failed' });
        return wf;
      },
    },
    {
      label: 'an interrupted step awaiting recovery',
      reason: 'interrupted',
      build: () => {
        const wf = run();
        step(wf, { status: 'running', recovery: 'interrupted' });
        return wf;
      },
    },
    {
      label: 'the executing agent is waiting on your input',
      reason: 'agent-waiting',
      build: () => {
        const wf = run();
        step(wf, { status: 'running', executor: agent('waiting') });
        return wf;
      },
    },
  ];

  const missed: string[] = [];
  for (const c of CASES) {
    const got = workflowNeedsAttention(c.build());
    if (!got) { missed.push(`${c.label}: reported as healthy`); continue; }
    if (got.reason !== c.reason) missed.push(`${c.label}: reason "${got.reason}", expected "${c.reason}"`);
    if (!got.stepName) missed.push(`${c.label}: no step named, so the badge cannot say WHICH step`);
  }
  assert.deepEqual(missed, [],
    `these stalls are indistinguishable from work in progress:\n  ${missed.join('\n  ')}`);
});

test('a healthy running workflow is NOT flagged', () => {
  // The other direction matters as much. A badge that is always on is a badge nobody reads,
  // and it would make the genuine stalls invisible again.
  const wf = run();
  step(wf, { status: 'completed' });
  step(wf, { status: 'running', executor: agent('working') });
  step(wf, { status: 'pending' });
  assert.equal(workflowNeedsAttention(wf), null);
});

test('a finished or cancelled run is never flagged', () => {
  // Recovery state on a stopped run is history, not a call to action.
  for (const status of ['completed', 'cancelled', 'failed']) {
    const wf = run();
    db.prepare('UPDATE workflows SET status = ? WHERE id = ?').run(status, wf);
    step(wf, { status: 'failed' });
    assert.equal(workflowNeedsAttention(wf), null, `a ${status} run was flagged as needing attention`);
  }
});

test('the most URGENT reason wins when several apply at once', () => {
  // A run can hold a failure and a decision simultaneously (parallel branches). Reporting the
  // decision would send you to answer a question on a run that is already broken.
  const wf = run();
  step(wf, { status: 'failed' });
  step(wf, { status: 'running', type: 'decision', config: JSON.stringify({ question: 'Which?' }) });
  assert.equal(workflowNeedsAttention(wf)?.reason, 'failed');
});

test('the flag carries what a human needs to act — step id, name, and a question', () => {
  // "Needs attention" with no target sends you hunting through 47 steps.
  const wf = run();
  const sid = step(wf, {
    status: 'running', type: 'decision',
    config: JSON.stringify({ question: 'Which implementation approach should we pursue?' }),
  });
  const got = workflowNeedsAttention(wf)!;
  assert.equal(got.stepId, sid);
  assert.match(got.detail, /approach/i, 'the decision question should reach the badge');
});
