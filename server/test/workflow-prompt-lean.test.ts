/**
 * TEMPLATE PROMPTS CARRY NO FLUFF — every standard template, every step, every role preamble.
 *
 * What was cut, and why it must not come back (docs/analysis/workflow-prompt-review.md):
 * - a second report: every run already ends with the engine's Workflow Completion Report;
 * - the same question asked twice (two security reviews, reproduce + root cause, "why now" ×3);
 * - role preambles that contradict their step ("[PLAN MODE]" on the step that opens a PR);
 * - filler: "do NOT advance" (the engine already holds manual steps), Claude tool-name lists
 *   (meaningless to Codex), parallel sub-agents the engine never spawns, "You are running /x"
 *   openers, pep lines.
 * SET-BASED: iterates the seeded registry, so a new template is checked the day it is added.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db, { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';
import { ROLE_PROMPTS } from '../src/lib/workflow-executor-v2.ts';
import { REPORT_STEP_NAME } from '../src/lib/workflow-report.ts';

type Row = { wf: string; name: string; description: string; type: string; cfg: string };

const rows = db.prepare(`
  SELECT w.name wf, s.name, s.description, s.executor_type type, s.executor_config cfg
    FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
   WHERE w.template_id IS NULL ORDER BY w.name, s.position_y`).all() as Row[];

const steps = rows.map((r) => {
  const cfg = JSON.parse(r.cfg || '{}') as Record<string, unknown>;
  const text = [cfg.prompt, cfg.customPrompt, cfg.loopPrompt, cfg.message, cfg.title]
    .filter((v): v is string => typeof v === 'string').join('\n');
  return { ...r, cfg, text };
});

const promptOf = (wf: string, step: string) => steps.find((s) => s.wf === wf && s.name === step)?.text;

/**
 * Stays under this many characters across every template (128,578 before the cut). The engine's
 * Workflow Completion Report step is the same in every template and is not counted.
 */
const TOTAL_BUDGET = 113_000;

const FILLER: [string, RegExp][] = [
  ['manual-advance instruction', /do not (auto-?)?advance|must not auto-advance|advance (this step )?manually|manual advance|advance to close/i],
  ['"You are running" opener', /\byou are running\b/i],
  ['Claude tool-name list', /\b(Read, Grep|Grep, and Glob|Grep\/Glob|WebSearch and WebFetch)\b/],
  ['made-up parallel agents', /parallel (sub-?agents|research tasks|research tracks)|spawn \d+ parallel/i],
  ['pep line', /\bsmarter\b/i],
];

test('the registry is the one being checked', () => {
  const seeded = new Set(steps.map((s) => s.wf));
  for (const name of STANDARD_TEMPLATE_NAMES) assert.ok(seeded.has(name), `${name} not seeded`);
});

test('NO template step carries filler', () => {
  const hits: string[] = [];
  for (const s of steps) {
    for (const [label, re] of FILLER) {
      if (re.test(s.text)) hits.push(`${s.wf} / ${s.name}: ${label}`);
    }
    if (/runs in parallel|parallel subagents/i.test(s.description)) hits.push(`${s.wf} / ${s.name}: description claims parallel runs`);
  }
  assert.deepEqual(hits, []);
});

test('NO template writes its own report beside the engine\'s Completion Report', () => {
  const dupes = steps.filter((s) => /^(final|summary) report$/i.test(s.name)).map((s) => `${s.wf} / ${s.name}`);
  assert.deepEqual(dupes, []);
});

test('NO template asks the same question in two steps', () => {
  const by = (wf: string) => steps.filter((s) => s.wf === wf).map((s) => s.name);
  const problems: string[] = [];
  const security = by('CE: Phase 4 — Review').filter((n) => /security|stride|cso/i.test(n));
  if (security.length > 1) problems.push(`CE Phase 4 has ${security.length} security reviews: ${security.join(', ')}`);
  const bug = by('Bug Investigation');
  if (bug.some((n) => /reproduce/i.test(n)) && bug.some((n) => /^root cause/i.test(n))) problems.push('Bug Investigation: Reproduce and Root Cause are separate steps');
  if (by('Product Strategy Session').includes('Dream State')) problems.push('Product Strategy: Dream State re-asks the action plan');
  const strategy = steps.filter((s) => s.wf === 'Product Strategy Session');
  for (const [topic, re] of [['why now', /why now/i], ['smallest version', /smallest (version|wedge)/i]] as const) {
    const asked = strategy.filter((s) => re.test(s.text)).map((s) => s.name);
    if (asked.length > 1) problems.push(`Product Strategy asks "${topic}" in ${asked.join(', ')}`);
  }
  const migration = steps.filter((s) => s.wf === 'Engineering Architecture Review' && /migration path/i.test(s.text)).map((s) => s.name);
  if (migration.length > 1) problems.push(`Architecture Review writes the migration path in ${migration.join(', ')}`);
  const claudeMd = steps.filter((s) => s.wf === 'CE: Phase 7 — Compound' && /CLAUDE\.md/.test(s.text) && s.type === 'claude-code').map((s) => s.name);
  if (claudeMd.length > 1) problems.push(`CE Phase 7 checks CLAUDE.md in ${claudeMd.join(', ')}`);
  assert.deepEqual(problems, []);
});

test('EVERY role preamble is one short clause that cannot contradict its step', () => {
  const bad = Object.entries(ROLE_PROMPTS).filter(([, p]) =>
    p.length > 90 || /plan mode|up to \d|comprehensive tests/i.test(p)).map(([r, p]) => `${r} (${p.length})`);
  assert.deepEqual(bad, []);
  const openPr = steps.find((s) => s.wf === 'CE: Phase 4 — Review' && s.name === 'Open PR');
  assert.notEqual(openPr?.cfg.role, 'planner', 'the step that opens a PR is not a planning step');
});

test('the long loop prompts are cut to the level of Epic: Task by Task', () => {
  const caps: [string, string, number][] = [
    ['Epic: Two Repos', 'Work Repo A', 2800],
    ['Epic: Two Repos', 'Work Repo B', 2800],
    ['CE Develop and Optimize', 'Develop and Optimize Every Task', 4500],
  ];
  const over = caps.map(([t, s, max]) => [t, s, max, (promptOf(t, s) ?? '').length] as const)
    .filter(([, , max, len]) => len > max || len === 0).map(([t, s, max, len]) => `${t} / ${s}: ${len} > ${max}`);
  assert.deepEqual(over, []);
});

test('the template text as a whole stays under budget', () => {
  const total = steps.filter((s) => s.name !== REPORT_STEP_NAME).reduce((n, s) => n + s.text.length, 0);
  assert.ok(total <= TOTAL_BUDGET, `${total} > ${TOTAL_BUDGET}`);
});
