import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One serializer for a workflow step, not two that disagree.
 *
 * `normalizeStep` existed twice, privately, in routes/workflows.ts and workflow-executor-v2.ts.
 * I found the pair during N3, reported it, and left it — describing the difference as a routing
 * field that survives in one copy and not the other. That was wrong, and the real difference is
 * worse: the executor's copy parses executor_config through a guarded helper that returns `{}`
 * and logs on bad JSON, while the routes' copy calls bare JSON.parse, which THROWS. One
 * unreadable row therefore 500s every route that serialises a step, while the executor keeps
 * running — the two halves of the product disagreeing about whether a workflow is loadable.
 *
 * SET-BASED over the CALL SITES rather than the one that crashes, because the defect is
 * duplication: a third copy would reintroduce the divergence somewhere new, and the only
 * durable assertion is that exactly one definition exists.
 */

const SRC = path.join(import.meta.dirname, '..', 'src');

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(abs));
    else if (e.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

test('exactly one module DEFINES normalizeStep', () => {
  const definers: string[] = [];
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    if (/^(export )?function normalizeStep\s*\(/m.test(src)) definers.push(path.relative(SRC, f));
  }
  assert.deepEqual(definers, ['lib/workflow-normalize.ts'],
    `normalizeStep is defined in ${definers.length} places: ${definers.join(', ')} — ` +
    'two copies drift, and the last time they did one threw where the other logged');
});

test('every consumer imports it rather than rolling its own parse of executor_config', () => {
  // The specific divergence: a bare JSON.parse of executor_config anywhere outside the
  // normalizer is a step serializer that throws on a row the executor tolerates.
  const offenders: string[] = [];
  for (const f of sourceFiles()) {
    const rel = path.relative(SRC, f);
    if (rel === 'lib/workflow-normalize.ts') continue;
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    if (/JSON\.parse\(\s*\(?\s*row\.executor_config/.test(src)) {
      offenders.push(`${rel} parses executor_config directly`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}\n`);
});

test('an unreadable executor_config yields an empty object, never a throw', async () => {
  const { normalizeStep } = await import('../src/lib/workflow-normalize.ts');

  // THE SET: every shape the column arrives in, including the ones a bare JSON.parse rejects.
  const CASES: { label: string; raw: unknown }[] = [
    { label: 'valid JSON object', raw: '{"role":"backend"}' },
    { label: 'empty string', raw: '' },
    { label: 'null', raw: null },
    { label: 'undefined', raw: undefined },
    { label: 'truncated JSON', raw: '{"role":"back' },
    { label: 'not JSON at all', raw: 'backend' },
    { label: 'a JSON array', raw: '[1,2,3]' },
    { label: 'a JSON scalar', raw: '42' },
    { label: 'the literal null', raw: 'null' },
  ];

  const failures: string[] = [];
  for (const c of CASES) {
    try {
      const step = normalizeStep({ id: 's1', workflow_id: 'w1', name: 'S', executor_config: c.raw });
      if (typeof step.executorConfig !== 'object' || step.executorConfig === null || Array.isArray(step.executorConfig)) {
        failures.push(`${c.label}: executorConfig is ${JSON.stringify(step.executorConfig)} — callers index it as an object`);
      }
    } catch (err) {
      failures.push(`${c.label}: THREW — ${err instanceof Error ? err.message : err}`);
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('a valid config still comes through untouched', async () => {
  const { normalizeStep } = await import('../src/lib/workflow-normalize.ts');
  const step = normalizeStep({
    id: 's1', workflow_id: 'w1', name: 'S',
    executor_config: '{"role":"backend","loopCount":3,"loopCountFrom":{"step":"Load Epic"}}',
  });
  assert.equal((step.executorConfig as Record<string, unknown>).role, 'backend');
  assert.equal((step.executorConfig as Record<string, unknown>).loopCount, 3);
  assert.deepEqual((step.executorConfig as Record<string, unknown>).loopCountFrom, { step: 'Load Epic' });
});
