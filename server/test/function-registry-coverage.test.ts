import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * The routing design is only as good as its coverage of what agents ACTUALLY do.
 *
 * This derives the function set from SOURCE — the tool registry, the executor-type
 * union, the confer milestone definitions, the MCP tool list — and asserts that
 * docs/local-model-routing.md assigns every member a capability tier. It does NOT
 * read the expected set from the document, because a document that lists its own
 * expectations can never be found incomplete.
 *
 * This is the anti-drift property we paid for three times in this codebase:
 * KNOWN_ENGINES was a hand-maintained copy of AgentType, the escalation ladder was a
 * hand-maintained copy of rollup(), and a citation drifted inside one milestone. A
 * routing table hand-maintained against the tool registry would rot the same way —
 * silently, while still reading as authoritative.
 *
 * Add a tool or an executor type and this test fails until the routing table covers it.
 */

const NEONCORE = path.resolve(import.meta.dirname, '../..');
const GRIDLIGHT = path.resolve(NEONCORE, '../vscode-extension');
const DOC = path.join(NEONCORE, 'docs/local-model-routing.md');

const read = (p: string) => fs.readFileSync(p, 'utf8');
const exists = (p: string) => fs.existsSync(p);

/** Gridlight's agent tools — what the model can actually invoke. */
function gridlightTools(): string[] {
  const f = path.join(GRIDLIGHT, 'packages/core/src/agent/agentTools.ts');
  if (!exists(f)) return [];
  return [...new Set([...read(f).matchAll(/^\s+name: '([a-z_]+)'/gm)].map((m) => m[1]))];
}

/** Workflow step executor types — what a workflow node can be. */
function executorTypes(): string[] {
  const m = read(path.join(NEONCORE, 'server/src/types.ts')).match(/export type StepExecutorType\s*=\s*([^;]+);/);
  return m ? [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]) : [];
}

/** Confer milestone roles — what a participating agent is asked to do. */
function conferMilestones(): string[] {
  const f = path.join(NEONCORE, 'server/src/lib/confer-conductor.ts');
  return [...new Set([...read(f).matchAll(/key:\s*'([a-z-]+)'/g)].map((m) => m[1]))];
}

/** NeonCore MCP tools — the coordination surface an agent must drive. */
function mcpTools(): string[] {
  const f = path.join(NEONCORE, 'server/src/mcp-server.ts');
  return [...new Set([...read(f).matchAll(/name: '(neoncore_[a-z_]+)'/g)].map((m) => m[1]))];
}

/**
 * Engine-lifecycle and developer-facing functions. These are NOT auto-derived, and that
 * is the point: they have no enum to derive from, and the first version of this checker
 * therefore could not see that they were missing. It reported 38/38 green while the
 * registry omitted developer interaction, test authoring and test-failure interpretation
 * entirely — found by a human reading the request, not by this test.
 *
 * WHAT THIS CHECKER ACTUALLY GUARANTEES: internal consistency, not completeness.
 * It is structurally blind to a missing category — it finds omissions only WITHIN
 * categories it already knows. Completeness against the world needs an external oracle.
 * Read a green number as evidence about drift, never as evidence about scope.
 */
const LIFECYCLE: string[] = [
  'task_planning',
  'developer_question',
  'test_case_authoring',
  'test_authoring',
  'test_failure_interpretation',
  'result_summarization',
];

interface Fn { id: string; source: string }

function registry(): Fn[] {
  return [
    ...gridlightTools().map((id) => ({ id, source: 'agentTools.ts' })),
    ...executorTypes().map((id) => ({ id, source: 'types.ts StepExecutorType' })),
    ...conferMilestones().map((id) => ({ id, source: 'confer-conductor.ts' })),
    ...mcpTools().map((id) => ({ id, source: 'mcp-server.ts' })),
    ...LIFECYCLE.map((id) => ({ id, source: 'lifecycle (hand-listed, not derivable)' })),
  ];
}

/**
 * A function is covered when the doc contains a table row naming it in backticks and
 * assigning a tier (T0-T5). Requiring the tier — not merely a mention — is the point:
 * prose can name something without deciding anything about it.
 */
function coveredTier(doc: string, id: string): string | null {
  const rowRe = new RegExp(`^\\|[^\\n]*\`${id}\`[^\\n]*$`, 'm');
  const row = doc.match(rowRe);
  if (!row) return null;
  // T1 is split by blast radius: T1-READ (non-mutating, fails loudly) vs T1-WRITE
  // (mutating, can fail silently). Match the qualified forms first.
  const tier = row[0].match(/\bT1-(READ|WRITE)\b/) || row[0].match(/\bT([0-5])\b/);
  return tier ? tier[0] : null;
}

test('the function registry is non-empty and derived from source', () => {
  const r = registry();
  assert.ok(gridlightTools().length >= 10, `expected gridlight tools, got ${gridlightTools().length}`);
  assert.ok(executorTypes().length >= 5, `expected executor types, got ${executorTypes().length}`);
  assert.ok(conferMilestones().length >= 5, `expected confer milestones, got ${conferMilestones().length}`);
  assert.ok(mcpTools().length >= 5, `expected mcp tools, got ${mcpTools().length}`);
  console.log(`\nfunction registry: ${r.length} functions from 4 source registries`);
});

test('every function in the registry has a capability tier in the routing table', () => {
  assert.ok(exists(DOC), `${DOC} does not exist`);
  const doc = read(DOC);
  const r = registry();

  const missing: string[] = [];
  const byTier: Record<string, number> = {};
  for (const fn of r) {
    const tier = coveredTier(doc, fn.id);
    if (!tier) missing.push(`${fn.id}  (${fn.source})`);
    else byTier[tier] = (byTier[tier] || 0) + 1;
  }

  const covered = r.length - missing.length;
  console.log(`routing coverage: ${covered}/${r.length}`);
  console.log(`  by tier: ${Object.keys(byTier).sort().map((t) => `${t}=${byTier[t]}`).join(' ')}`);
  if (missing.length) console.log(`  MISSING:\n    ${missing.join('\n    ')}`);

  assert.deepEqual(missing, [], `${missing.length} functions have no capability tier`);
});

test('the tier scale is defined before it is used', () => {
  const doc = read(DOC);
  // T1 is split by blast radius; a bare T1 is no longer a valid tier.
  for (const t of ['T0', 'T1-READ', 'T1-WRITE', 'T2', 'T3', 'T4', 'T5']) {
    assert.ok(new RegExp(`\\*\\*${t}\\*\\*`).test(doc), `tier ${t} is used but never defined`);
  }
});

test('no function is left on a bare T1 after the blast-radius split', () => {
  const doc = read(DOC);
  const stale = registry()
    .map((fn) => ({ fn, tier: coveredTier(doc, fn.id) }))
    .filter((x) => x.tier === 'T1')
    .map((x) => x.fn.id);
  assert.deepEqual(stale, [], `these still carry a bare T1 and must be READ or WRITE: ${stale.join(', ')}`);
});
