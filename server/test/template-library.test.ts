/**
 * THE TEMPLATE LIBRARY, AS A SET.
 *
 * Reported as "the dev list gets even more convoluted, there's probably two or three doing the
 * same but one does it better" — and measuring it found something worse than duplication.
 *
 * `CI/CD Pipeline` and `New Feature` had FIVE and ONE agent steps respectively with **no prompt
 * at all** — nothing but a step name. A `claude-code` step with no prompt falls back to
 * `step.description || step.name` (workflow-executor-v2.ts), so launching one dispatched the
 * literal string "Develop" to a cartridge and called it a workflow. They were indistinguishable
 * from the real templates on the picker, which is most of why the list read as convoluted: two
 * of the entries were labels.
 *
 * THE BAR THIS FILE ENFORCES: every agent step of every standard template carries a real
 * prompt. It is set-based over STANDARD_TEMPLATE_NAMES and over each template's own steps, so a
 * template added next month is held to it without anyone remembering to add a test — which is
 * exactly how these two survived.
 *
 * Counted, not sampled: "some templates have prompts" was true before this and is the state
 * being fixed.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

type Step = { name: string; executor_type: string; executor_config: string; auto_advance: number };

const templateNamed = (name: string) =>
  db.prepare('SELECT id, name FROM workflows WHERE template_id IS NULL AND name = ?')
    .get(name) as { id: string; name: string } | undefined;

const stepsOf = (id: string) =>
  db.prepare(
    'SELECT name, executor_type, executor_config, auto_advance FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(id) as Step[];

const cfg = (s: Step): Record<string, unknown> => {
  try { return JSON.parse(s.executor_config || '{}'); } catch { return {}; }
};

/** Step types that dispatch a prompt to a model and therefore need one. */
const NEEDS_PROMPT = new Set(['claude-code', 'confer', 'deliberation']);
const isReport = (s: Step) => cfg(s).stepKind === 'workflow-report';

// ── The bar ────────────────────────────────────────────────────────────────────────────

test('EVERY agent step of EVERY standard template carries a real prompt', () => {
  let templates = 0, agentSteps = 0;
  const bare: string[] = [];

  for (const name of STANDARD_TEMPLATE_NAMES) {
    const tpl = templateNamed(name);
    assert.ok(tpl, `"${name}" is in STANDARD_TEMPLATE_NAMES but seeds no template`);
    templates++;
    for (const s of stepsOf(tpl.id)) {
      if (!NEEDS_PROMPT.has(s.executor_type) || isReport(s)) continue;
      agentSteps++;
      const prompt = String(cfg(s).prompt ?? '').trim();
      // 40 chars: shorter than any real instruction and longer than a step name, so it
      // separates "someone wrote this" from "the name leaked into the prompt slot".
      if (prompt.length < 40) bare.push(`${name} / ${s.name} (${prompt.length} chars)`);
    }
  }

  assert.deepEqual(bare, [],
    `${bare.length} agent step(s) would dispatch their own NAME to a cartridge:\n  ${bare.join('\n  ')}`);
  console.log(`[set] ${templates}/${STANDARD_TEMPLATE_NAMES.length} templates · ${agentSteps} agent steps all carry a real prompt`);
});

test('the registry and the database agree — no template seeds that nobody declared', () => {
  const inDb = (db.prepare(
    "SELECT name FROM workflows WHERE template_id IS NULL",
  ).all() as { name: string }[]).map((r) => r.name);
  const undeclared = inDb.filter((n) => !(STANDARD_TEMPLATE_NAMES as readonly string[]).includes(n));
  assert.deepEqual(undeclared, [],
    `seeded but not in STANDARD_TEMPLATE_NAMES: ${undeclared.join(', ')} — the delete loop only ` +
    'visits declared names, so these can never be updated or removed again');
});

// ── The two shells are gone, and stay gone ─────────────────────────────────────────────

const RETIRED_TEMPLATES = ['CI/CD Pipeline', 'New Feature'];

test('the promptless shells are retired AND deprecated, not merely unlisted', () => {
  for (const name of RETIRED_TEMPLATES) {
    assert.ok(!(STANDARD_TEMPLATE_NAMES as readonly string[]).includes(name),
      `"${name}" is still declared`);
    assert.equal(templateNamed(name), undefined, `"${name}" still seeds a template`);
  }
  // Unlisting alone is not removal: seedDefaultTemplates' delete loop only visits declared
  // names, so an unlisted template lingers in every EXISTING database forever. That is what
  // `deprecatedNames` is for, and forgetting it is invisible on a fresh database.
  const src = read('server/src/db.ts');
  const dep = src.slice(src.indexOf('const deprecatedNames'), src.indexOf(']', src.indexOf('const deprecatedNames')));
  for (const name of RETIRED_TEMPLATES) {
    assert.ok(dep.includes(name),
      `"${name}" is unlisted but not in deprecatedNames — it will survive in existing databases`);
  }
});

// ── The three new ones, each asserted on the thing it exists to do ─────────────────────

test('Spec Intake reads a document, CHECKS its understanding, then gates development', () => {
  const tpl = templateNamed('Spec Intake → Dev Spec');
  assert.ok(tpl, 'Spec Intake → Dev Spec does not exist');
  const steps = stepsOf(tpl.id);
  const all = steps.map((s) => `${s.name} ${JSON.stringify(cfg(s))}`).join('\n');

  // The whole point is the comprehension check: a spec parsed wrong and built anyway is worse
  // than one that was never parsed. So there is a HUMAN gate before any spec is written…
  const gates = steps.filter((s) => s.auto_advance === 0 || s.executor_type === 'decision');
  assert.ok(gates.length >= 2,
    `expected at least 2 human checkpoints (comprehension + start development), found ${gates.length}`);

  // …and a decision step that is literally "start development".
  const decisions = steps.filter((s) => s.executor_type === 'decision');
  assert.ok(decisions.length >= 1, 'no decision step — "hit start development" has nothing to hit');

  assert.match(all, /attach/i, 'never tells the agent where the uploaded document is');
  assert.match(all, /requirement/i, 'never enumerates requirements out of the document');
  assert.match(all, /docs\/specs\//, 'writes no spec document to disk');
});

test('Daily AI Research reaches the WEB and renders an HTML artifact', () => {
  const tpl = templateNamed('Daily AI Research Digest');
  assert.ok(tpl, 'Daily AI Research Digest does not exist');
  const all = stepsOf(tpl.id).map((s) => JSON.stringify(cfg(s))).join('\n');

  assert.match(all, /WebSearch/, 'no WebSearch — a research digest that cannot reach the web is a summary of nothing');
  assert.match(all, /WebFetch/, 'no WebFetch — headlines without the articles behind them');
  // Self-containment used to be a PROMISE in the prompt. It is now a property of the fixed
  // renderer (lib/digest-template.ts) and asserted directly in daily-digest-newspaper.test.ts,
  // which is a stronger check than hoping an agent honoured a sentence.
  assert.match(all, /api\/digest\/render/, 'the digest no longer goes through the fixed template, so it will look different every morning');
  assert.match(all, /\.html/, 'produces no HTML file');
  assert.match(all, /reddit/i, 'no AI noise section — the digest reports what shipped but not what people are saying');
});

test('Confer is a template — two or more cartridges on one task', () => {
  const tpl = templateNamed('Confer');
  assert.ok(tpl, 'Confer template does not exist');
  const steps = stepsOf(tpl.id);
  const confer = steps.filter((s) => s.executor_type === 'confer');
  assert.equal(confer.length, 1, `expected exactly one confer step, found ${confer.length}`);
  const c = cfg(confer[0]);
  assert.ok(Array.isArray(c.conferAgentIds), 'the confer step declares no agent roster');
  assert.ok(String(c.prompt ?? '').length > 40, 'the confer step has no prompt');
});

test('the top-menu Confer button is gone — it is a workflow now', () => {
  const app = read('dashboard/src/App.tsx');
  assert.ok(!/setConferOpen/.test(app),
    'App.tsx still opens the confer modal — the button was meant to go away, not be hidden');
  assert.ok(!/ConferModal/.test(app),
    'App.tsx still imports ConferModal');
});
