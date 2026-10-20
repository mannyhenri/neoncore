/**
 * PHASE 2 — WHAT THE SERVER ADDS TO A STEP PROMPT HAS A BUDGET, PER KIND OF DISPATCH.
 *
 * Phases 0 and 1 cut the fixed text NeonCore wraps around a step's own prompt (a first work step
 * went from ~4,000 to 2,499 chars). Nothing stopped it growing back: every fix that added a
 * sentence to a builder was reasonable on its own, and that is how a 1,000-char completion
 * instruction and an 8,800-char report spec happened. These budgets make growth a deliberate
 * edit to lib/prompt-budget.ts instead of a side effect.
 *
 * OVERHEAD = the text an agent actually received (the `commands` row, so memory, goal brief,
 * the work-standard block and the worktree prefix all count) MINUS the content the run supplied
 * (the step prompt, the confer task). SET-BASED: every DISPATCH_KINDS entry is dispatched for
 * real, and every variant that changes the fixed text (each role, output format, gate preset,
 * confer mode and milestone) is measured — a budget only for the default would miss the rest.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import {
  tickWorkflowsOnce, recordPanelResult,
  __promptVariantsForTests as variants,
} from '../src/lib/workflow-executor-v2.ts';
import { reportStepConfig } from '../src/lib/workflow-report.ts';
import { startConfer, recordMilestoneDone, conferPlan } from '../src/lib/confer-conductor.ts';
import { DISPATCH_KINDS, OVERHEAD_BUDGET, type DispatchKind } from '../src/lib/prompt-budget.ts';

const io = installStubIO();
const CONTENT = 'Do the one thing this step exists for.';
let n = 0;

function agent(): string {
  const id = `pob-${++n}`;
  io.connect(id);
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, 'box', ?, 'repo', 'idle', ?, ?, 'claude')`)
    .run(id, `box/${id}`, `/tmp/${id}`, new Date().toISOString(), `sess-${id}`);
  return id;
}

/** Every command an agent has received, oldest first. */
const received = (agentId: string): string[] =>
  (db.prepare('SELECT text FROM commands WHERE agent_id = ? ORDER BY created_at, rowid').all(agentId) as { text: string }[])
    .map((r) => r.text);

/** A running one-step run (no description, no launch context: overhead only). */
function runOneStep(type: string, executorId: string, config: Record<string, unknown>): string {
  const wf = randomUUID(), step = randomUUID(), now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, description, status, created_at) VALUES (?, 'budget', '', 'running', ?)`).run(wf, now);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, depends_on, position_x, position_y, created_at)
              VALUES (?, ?, 'S', 'pending', ?, ?, ?, '[]', 0, 0, ?)`).run(step, wf, type, executorId, JSON.stringify(config), now);
  tickWorkflowsOnce();
  return step;
}

/** kind → [variant label, overhead] for every dispatch measured. */
const measured = new Map<DispatchKind, [string, number][]>();
const record = (kind: DispatchKind, label: string, text: string | undefined, content: string) => {
  assert.ok(text, `${kind} / ${label}: nothing was dispatched`);
  assert.ok(text!.includes(content), `${kind} / ${label}: the step's own content is missing`);
  if (!measured.has(kind)) measured.set(kind, []);
  measured.get(kind)!.push([label, text!.length - content.length]);
};

const v = variants();

test('measure: work steps — every role × every output format', () => {
  for (const role of v.roles) for (const format of ['', ...v.formats]) {
    const a = agent();
    runOneStep('claude-code', a, { prompt: CONTENT, role, ...(format ? { outputSchema: format } : {}) });
    record('work', `${role}/${format || 'plain'}`, received(a)[0], CONTENT);
  }
});

test('measure: command template steps', () => {
  const a = agent(), tpl = randomUUID(), now = new Date().toISOString();
  db.prepare(`INSERT INTO command_templates (id, name, content, created_at, updated_at) VALUES (?, 't', ?, ?, ?)`).run(tpl, CONTENT, now, now);
  runOneStep('command', a, { commandTemplateId: tpl });
  record('command', 'template', received(a)[0], CONTENT);
});

test('measure: the completion-report step, as every template appends it', () => {
  // Its prompt is the report spec — server text, so all of it is overhead. No prior steps, so
  // the run record is only its scaffold; real runs add each step's result (budgeted elsewhere).
  const a = agent();
  runOneStep('claude-code', a, reportStepConfig());
  record('report', 'report', received(a)[0], '');
});

test('measure: review gate', () => {
  const a = agent();
  runOneStep('review-gate', a, { criteria: CONTENT });
  record('review-gate', 'review', received(a)[0], CONTENT);
});

test('measure: quality gate — every preset', () => {
  for (const gateType of v.gatePresets) {
    const a = agent();
    runOneStep('quality-gate', a, { gateType });
    const text = received(a)[0];
    // A preset is server text, not the run's content: all of it counts.
    assert.ok(text?.includes(v.gatePrompt(gateType)), `${gateType}: preset not sent`);
    record('quality-gate', gateType, text, '');
  }
});

test('measure: deliberation panel members and the synthesis', () => {
  const [p1, p2, synth] = [agent(), agent(), agent()];
  const step = runOneStep('deliberation', '', { prompt: CONTENT, panelAgentIds: [p1, p2], synthesisAgentId: synth });
  record('panel', 'member', received(p1)[0], CONTENT);
  recordPanelResult(step, p1, CONTENT);
  recordPanelResult(step, p2, CONTENT);
  // Both members' answers are its content.
  const s = received(synth)[0];
  record('synthesis', 'synthesis', s?.replace(CONTENT, ''), CONTENT);
});

test('measure: confer milestones — every milestone of every mode', async () => {
  for (const mode of ['divide', 'collaborate'] as const) {
    const [a, b] = [agent(), agent()];
    const session = startConfer({ repoName: 'repo', repoPath: `/tmp/${a}`, participantIds: [a, b], task: CONTENT, mode });
    const plan = conferPlan(mode, 1);
    for (let i = 0; i < plan.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      record('confer-milestone', `${mode}/${plan[i].key}`, received(a)[i], CONTENT);
      recordMilestoneDone(session.id, a, 'ok');
      recordMilestoneDone(session.id, b, 'ok');
    }
  }
});

test('EVERY dispatch kind was measured, and every kind has a budget', () => {
  assert.deepEqual([...measured.keys()].sort(), [...DISPATCH_KINDS].sort(), 'a kind was never dispatched');
  assert.deepEqual(Object.keys(OVERHEAD_BUDGET).sort(), [...DISPATCH_KINDS].sort(), 'budgets and kinds differ');
});

test('EVERY dispatch fits its kind\'s overhead budget', () => {
  const over: string[] = [];
  const table: string[] = [];
  for (const [kind, rows] of measured) {
    const max = Math.max(...rows.map(([, c]) => c));
    table.push(`${kind.padEnd(17)} max ${String(max).padStart(5)} / budget ${OVERHEAD_BUDGET[kind]} (${rows.length} variants)`);
    for (const [label, chars] of rows) {
      if (chars > OVERHEAD_BUDGET[kind]) over.push(`${kind} / ${label}: ${chars} > ${OVERHEAD_BUDGET[kind]}`);
    }
  }
  console.log(table.join('\n'));
  assert.deepEqual(over, [], `over budget — trim the text, or raise the budget in lib/prompt-budget.ts on purpose:\n  ${over.join('\n  ')}`);
});
