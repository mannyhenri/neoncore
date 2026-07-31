import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * Every claim these plans make about THIS codebase must resolve.
 *
 * A plan is only as good as its grounding. Citing a file or symbol that does not exist is
 * how a plan quietly becomes fiction — and the reader cannot tell, because prose reads the
 * same either way. This iterates every code citation in the Gridlight docs and fails on any
 * that no longer resolves, so the plans rot loudly rather than silently.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const DOCS = [
  'docs/research/local-vs-frontier.md',
  'docs/plans/gridlight-integration.md',
  // The consolidated explainer. Held to the same standard as the plans it summarises — a
  // summary that outlives its own citations is worse than a stale plan, not better,
  // because it is the document someone reads first.
  'docs/gridlight-strategy.md',
  'docs/local-model-routing.md',
];

/**
 * Files the plan proposes to CREATE. Excluded from the existence check by name, not by
 * guessing from surrounding prose: a plan must be free to name its own future files, but
 * every OTHER citation is evidence and has to resolve today. When one of these is built,
 * delete it from this list and the checker starts holding it to the same standard.
 */
const PROPOSED = new Set(['server/src/lib/engine-router.ts', 'server/src/lib/engine-signals.ts']);

/**
 * `path/to/file.ts` or `path/to/file.ts:123` inside backticks, repo-relative to THIS repo.
 *
 * packages/core, packages/cli and packages/vscode are deliberately excluded: those live in
 * the peer's gridlight-monorepo, and the plans cite them on purpose. Checking them here
 * would fail on correct references and teach us to ignore this test.
 */
const CITATION = /`((?:server|agent|dashboard|packages\/client)\/[A-Za-z0-9_./-]+\.(?:ts|js|py|sh))(?::(\d+))?`/g;

test('every file cited in the Gridlight docs exists', () => {
  const missing: string[] = [];
  for (const doc of DOCS) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const m of text.matchAll(CITATION)) {
      if (PROPOSED.has(m[1])) continue;
      if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(`${doc} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `plans cite files that do not exist:\n  ${missing.join('\n  ')}`);
});

test('every cited line number is within the file', () => {
  const bad: string[] = [];
  for (const doc of DOCS) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const m of text.matchAll(CITATION)) {
      if (!m[2]) continue;
      const full = path.join(ROOT, m[1]);
      if (!fs.existsSync(full)) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n').length;
      if (Number(m[2]) > lines) bad.push(`${doc} → ${m[1]}:${m[2]} (file has ${lines} lines)`);
    }
  }
  assert.deepEqual(bad, [], `citations point past the end of the file:\n  ${bad.join('\n  ')}`);
});

test('every symbol the plan claims exists is really there', () => {
  // The load-bearing claims of the plan: if any of these are gone, the sequencing is wrong.
  const CLAIMS: { file: string; symbol: string }[] = [
    { file: 'server/src/lib/resolve-agent.ts', symbol: 'agentIdForRepoAndType' },
    { file: 'server/src/stuck-detector.ts', symbol: 'ERROR_PATTERNS' },
    { file: 'server/src/stuck-detector.ts', symbol: 'analyzeAgent' },
    { file: 'server/src/lib/workflow-executor-v2.ts', symbol: 'review-gate' },
    { file: 'server/src/lib/workflow-executor-v2.ts', symbol: 'quality-gate' },
    { file: 'server/src/lib/workflow-executor-v2.ts', symbol: 'deliberation' },
    { file: 'server/src/lib/workflow-executor-v2.ts', symbol: 'maxRetries' },
    { file: 'server/src/lib/confer-conductor.ts', symbol: 'dispatchMilestone' },
    { file: 'server/src/lib/work-standard.ts', symbol: 'COMPLETION_MARKER' },
    { file: 'server/src/lib/pricing.ts', symbol: 'export' },
    { file: 'server/src/lib/goal-cost.ts', symbol: 'export' },
    { file: 'server/src/types.ts', symbol: "'gridlight'" },
  ];
  const broken = CLAIMS.filter(({ file, symbol }) => {
    const full = path.join(ROOT, file);
    return !fs.existsSync(full) || !fs.readFileSync(full, 'utf8').includes(symbol);
  }).map(({ file, symbol }) => `${symbol} not found in ${file}`);

  assert.deepEqual(broken, [], `the plan rests on symbols that do not exist:\n  ${broken.join('\n  ')}`);
});
