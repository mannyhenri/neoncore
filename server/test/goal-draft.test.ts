/**
 * A DRAFT IS A PROPOSAL. IT IS NEVER A GOAL UNTIL A PERSON SAYS SO.
 *
 * Phase 4 (GOAL-030/033). The user asked for a tool that fleshes out goal intent, and the
 * intent fields are not decoration: `goal-brief.ts` injects them into every dispatched prompt,
 * so anything written here becomes an instruction that working cartridges act on. Generated
 * text reaching a goal without a person reading it would mean invented acceptance criteria
 * silently steering real work.
 *
 * So the invariant under test is not "the accept button works". It is the NEGATIVE: that no
 * other path — creating a draft, a cartridge submitting one, a second submission, a replay of
 * an old draft — can move a single character into `goals`. Tests are set-based over the field
 * registry and over the mutating operations, because the failure mode is one path that forgets
 * the rule while the others keep it.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  DRAFTABLE_FIELDS, createDraft, getDraft, submitDraft, applyDraft, failDraft,
  normalizeDraftFields, buildDraftPrompt, DraftApplyError,
} from '../src/lib/goal-draft.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function goal(overrides: Partial<Record<string, string>> = {}): string {
  const id = `g-${++n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, budget_usd, status,
              created_at, updated_at, acceptance_criteria, no_gos, rabbit_holes, invariants, key_results)
              VALUES (?,?,?,?,NULL,'active',?,?,?,?,?,?,'[]')`)
    .run(id, `goal ${id}`, overrides.description ?? '', overrides.success_metric ?? '', ISO, ISO,
         overrides.acceptance_criteria ?? '', overrides.no_gos ?? '', overrides.rabbit_holes ?? '',
         overrides.invariants ?? '');
  return id;
}
const readGoal = (id: string) =>
  db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown>;

/** Every drafted field, in the shape the registry declares. */
const FULL_FIELDS: Record<string, unknown> = {
  description: 'Cut context assembly latency so answers arrive before attention drifts.',
  successMetric: 'p95 context build under 400ms with no drop in answer accuracy.',
  acceptanceCriteria: 'When a query is issued, the system shall assemble context in under 400ms.',
  invariants: 'Answer accuracy must not regress.',
  noGos: 'Do not add another vector database.',
  rabbitHoles: 'Tuning the existing RAG parameters — already tried, did not hold.',
  keyResults: [{ metric: 'p95 context build', baseline: '1.9s', target: '400ms', measure: 'trace timings' }],
};

// ── the negative space: nothing reaches a goal on its own ─────────────────────

test('creating a draft does not touch the goal', () => {
  const g = goal();
  const before = JSON.stringify(readGoal(g));
  createDraft({ goalId: g, seed: 'make RAG faster', agentId: 'a1', source: 'test' });
  assert.equal(JSON.stringify(readGoal(g)), before, 'requesting help mutated the goal');
});

test('a cartridge submitting a full draft still does not touch the goal', () => {
  // The load-bearing one. Everything the model produced is stored, and the goal is untouched.
  const g = goal();
  const before = JSON.stringify(readGoal(g));
  const d = createDraft({ goalId: g, seed: 's', agentId: 'a1', source: 'test' });
  const ready = submitDraft(d.id, FULL_FIELDS);

  assert.equal(ready?.status, 'ready');
  assert.ok(Object.keys(ready!.fields).length >= 6, 'setup: the draft should carry real content');
  assert.equal(JSON.stringify(readGoal(g)), before, 'a submitted draft leaked into the goal');
  assert.equal(ready?.appliedAt, null, 'applied_at was set without a user accepting');
});

/**
 * SET-BASED OVER EVERY MUTATING OPERATION. A single one of these forgetting the rule is the
 * whole bug, and it would be invisible next to the others behaving.
 */
const NON_APPLYING_OPS: { label: string; run: (goalId: string) => void }[] = [
  { label: 'createDraft', run: (g) => { createDraft({ goalId: g, seed: 'x', agentId: 'a', source: 't' }); } },
  {
    label: 'submitDraft',
    run: (g) => {
      const d = createDraft({ goalId: g, seed: 'x', agentId: 'a', source: 't' });
      submitDraft(d.id, FULL_FIELDS);
    },
  },
  {
    label: 'submitDraft twice (a re-run reporting again)',
    run: (g) => {
      const d = createDraft({ goalId: g, seed: 'x', agentId: 'a', source: 't' });
      submitDraft(d.id, FULL_FIELDS);
      submitDraft(d.id, FULL_FIELDS);
    },
  },
  {
    label: 'failDraft',
    run: (g) => {
      const d = createDraft({ goalId: g, seed: 'x', agentId: 'a', source: 't' });
      failDraft(d.id, 'the cartridge died');
    },
  },
  {
    label: 'submitting garbage',
    run: (g) => {
      const d = createDraft({ goalId: g, seed: 'x', agentId: 'a', source: 't' });
      submitDraft(d.id, 'not an object at all');
    },
  },
];

test('EVERY operation except an explicit accept leaves the goal byte-identical', () => {
  const wrong: string[] = [];
  for (const op of NON_APPLYING_OPS) {
    const g = goal();
    const before = JSON.stringify(readGoal(g));
    op.run(g);
    if (JSON.stringify(readGoal(g)) !== before) wrong.push(op.label);
  }
  assert.deepEqual(wrong, [], `these wrote generated text into a goal with no user action:\n  ${wrong.join('\n  ')}`);
});

test('a draft with no goal attached cannot be applied at all', () => {
  // Drafting a brand-new goal produces a proposal with nowhere to land until the goal exists.
  const d = createDraft({ goalId: null, seed: 'a new idea', agentId: 'a1', source: 'test' });
  submitDraft(d.id, FULL_FIELDS);
  assert.throws(() => applyDraft(d.id, ['description']), DraftApplyError);
});

test('an applied draft cannot be replayed', () => {
  // Otherwise a stale browser tab re-applies week-old generated text over edited fields.
  const g = goal();
  const d = createDraft({ goalId: g, seed: 's', agentId: 'a', source: 't' });
  submitDraft(d.id, FULL_FIELDS);
  applyDraft(d.id, ['description']);

  db.prepare("UPDATE goals SET description = 'the user rewrote this by hand' WHERE id = ?").run(g);
  assert.throws(() => applyDraft(d.id, ['description']), DraftApplyError);
  assert.equal(readGoal(g).description, 'the user rewrote this by hand', 'a replay overwrote a human edit');
});

test('a draft that never became ready cannot be applied', () => {
  const wrong: string[] = [];
  for (const state of ['pending', 'failed'] as const) {
    const g = goal();
    const d = createDraft({ goalId: g, seed: 's', agentId: 'a', source: 't' });
    if (state === 'failed') failDraft(d.id, 'boom');
    try {
      applyDraft(d.id, ['description']);
      wrong.push(`${state}: applied anyway`);
    } catch { /* expected */ }
  }
  assert.deepEqual(wrong, []);
});

// ── accept applies exactly what was chosen ────────────────────────────────────

test('accepting ONE field writes that field and no other', () => {
  // Otherwise accepting a good acceptance-criteria block smuggles in a no-gos section the user
  // never read — which is exactly how generated text becomes an instruction nobody approved.
  const g = goal();
  const before = readGoal(g);
  const d = createDraft({ goalId: g, seed: 's', agentId: 'a', source: 't' });
  submitDraft(d.id, FULL_FIELDS);
  applyDraft(d.id, ['acceptanceCriteria']);

  const after = readGoal(g);
  assert.equal(after.acceptance_criteria, FULL_FIELDS.acceptanceCriteria);
  const leaked = DRAFTABLE_FIELDS
    .filter((f) => f.key !== 'acceptanceCriteria')
    .filter((f) => after[f.column] !== before[f.column])
    .map((f) => f.key);
  assert.deepEqual(leaked, [], `accepting one field also wrote: ${leaked.join(', ')}`);
});

test('EVERY registry field can be accepted, and lands in its own column', () => {
  // A field the prompt asks for but `applyDraft` cannot write is a field that silently never
  // arrives — the user accepts it and nothing changes.
  const wrong: string[] = [];
  for (const f of DRAFTABLE_FIELDS) {
    const g = goal();
    const d = createDraft({ goalId: g, seed: 's', agentId: 'a', source: 't' });
    submitDraft(d.id, FULL_FIELDS);
    try {
      applyDraft(d.id, [f.key]);
    } catch (e) {
      wrong.push(`${f.key}: ${(e as Error).message}`);
      continue;
    }
    const stored = readGoal(g)[f.column];
    if (!stored || stored === '' || stored === '[]') wrong.push(`${f.key}: nothing landed in ${f.column}`);
  }
  assert.deepEqual(wrong, [], `fields the assistant can propose but the user cannot accept:\n  ${wrong.join('\n  ')}`);
});

test('accepting records exactly which fields were taken', () => {
  // The audit answer to "where did this text come from" — per field, not per draft.
  const g = goal();
  const d = createDraft({ goalId: g, seed: 's', agentId: 'a', source: 't' });
  submitDraft(d.id, FULL_FIELDS);
  const applied = applyDraft(d.id, ['description', 'noGos']);
  assert.deepEqual(applied.appliedFields.sort(), ['description', 'noGos']);
  assert.ok(applied.appliedAt);
});

test('unknown field names cannot be smuggled through accept', () => {
  const g = goal();
  const d = createDraft({ goalId: g, seed: 's', agentId: 'a', source: 't' });
  submitDraft(d.id, FULL_FIELDS);
  assert.throws(() => applyDraft(d.id, ['status', 'budget_usd', 'name']), DraftApplyError);
  assert.equal(readGoal(g).status, 'active');
});

// ── what comes back from a cartridge is untrusted input ───────────────────────

test('only registry fields survive normalization', () => {
  const out = normalizeDraftFields({
    description: 'keep me',
    status: 'achieved',          // not draftable — a goal must not self-complete
    name: 'renamed',             // not draftable
    budgetUsd: 999,              // not draftable
    nonsense: { a: 1 },
  });
  assert.deepEqual(Object.keys(out), ['description']);
});

test('empty proposals are dropped, so accepting cannot blank a filled field', () => {
  // A model returning "" for a field it had nothing to say about would otherwise erase work
  // the user typed by hand.
  const out = normalizeDraftFields({ description: '   ', noGos: 'real content' });
  assert.deepEqual(Object.keys(out), ['noGos']);
});

test('key results need a metric, are capped, and tolerate partial shapes', () => {
  const out = normalizeDraftFields({
    keyResults: [
      { metric: 'latency', baseline: '2s', target: '400ms', measure: 'traces' },
      { metric: 'accuracy' },                       // partial is fine
      { baseline: 'no metric here' },               // measures nothing — dropped
      'a string',                                   // not an object — dropped
      { metric: 'a' }, { metric: 'b' }, { metric: 'c' }, { metric: 'd' },
    ],
  });
  const krs = out.keyResults as { metric: string }[];
  assert.equal(krs.length, 4, 'cap not applied, or valid entries dropped');
  assert.ok(krs.every((k) => k.metric), 'a key result with no metric survived');
});

test('malformed submissions fail the draft rather than storing junk', () => {
  const wrong: string[] = [];
  for (const junk of [null, undefined, 'a string', 42, [], { unknownOnly: 'x' }]) {
    const g = goal();
    const d = createDraft({ goalId: g, seed: 's', agentId: 'a', source: 't' });
    const after = submitDraft(d.id, junk);
    if (after?.status !== 'failed') wrong.push(`${JSON.stringify(junk)} → ${after?.status}`);
  }
  assert.deepEqual(wrong, [], `junk accepted as a ready draft:\n  ${wrong.join('\n  ')}`);
});

// ── the prompt ────────────────────────────────────────────────────────────────

test('the prompt asks for EVERY registry field by its exact key', () => {
  // A field described in prose but never named cannot come back parseable, so it silently
  // never gets drafted — the registry and the prompt must not drift.
  const p = buildDraftPrompt('d-1', 'make RAG faster');
  const missing = DRAFTABLE_FIELDS.filter((f) => !p.includes(f.key)).map((f) => f.key);
  assert.deepEqual(missing, [], `the prompt never asks for: ${missing.join(', ')}`);
});

test('the prompt carries the draft id and routes the answer through MCP', () => {
  const p = buildDraftPrompt('d-42', 'seed');
  assert.match(p, /d-42/);
  assert.match(p, /neoncore_submit_goal_draft/);
});

test('the prompt tells the cartridge NOT to save anything itself', () => {
  // The cartridge has write access to the goals API. Without this it may helpfully "finish
  // the job" and apply its own draft, bypassing the entire review step.
  const p = buildDraftPrompt('d-1', 'seed');
  assert.match(p, /do not save anything yourself|Do not save anything yourself/i);
});

test('existing goal content is shown so the assistant fills gaps instead of overwriting', () => {
  const g = goal({ no_gos: 'Do not add another vector database.' });
  const p = buildDraftPrompt('d-1', 'seed', readGoal(g));
  assert.match(p, /Do not add another vector database/);
  assert.match(p, /do NOT contradict/i);
});
