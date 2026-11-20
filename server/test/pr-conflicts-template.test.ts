// FIRST import — db.ts seeds on load, and this must not touch the real database.
import './helpers/isolated-db.ts';
/**
 * A workflow to run on its own at the end: resolve the conflicts between a feature's PR and its base.
 *
 * REQUESTED: "We could have a PR conflict workflow I could run on its own at the end." Features now
 * run side by side on their own branches, so the second one to merge can conflict with the first.
 * The template brings the base in, resolves keeping both sides' intent, re-runs the tests (looping
 * back to the resolution while they fail), and pushes — never force-pushing, never merging the PR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';

const NAME = 'Resolve PR Conflicts';
type Step = { name: string; type: string; config: Record<string, unknown> };
const steps = (): Step[] => (db.prepare(`
  SELECT s.name, s.executor_type AS type, s.executor_config AS config FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id
  WHERE w.name = ? AND w.template_id IS NULL ORDER BY s.position_y`).all(NAME) as { name: string; type: string; config: string }[])
  .map((s) => ({ ...s, config: JSON.parse(s.config || '{}') }));

test('it is a standard template, seeded on every boot', () => {
  assert.ok((STANDARD_TEMPLATE_NAMES as readonly string[]).includes(NAME));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE name = ? AND template_id IS NULL').get(NAME) as { n: number }).n, 1);
});

test('brings the base in, resolves keeping both sides, re-tests (looping back on failure), then pushes without force', () => {
  const s = steps();
  const prompts = s.map((x) => String(x.config.prompt ?? '')).join('\n');
  assert.match(prompts, /git (fetch|merge)/, 'it must bring the base branch in');
  assert.match(prompts, /both/i, 'the resolution must keep both sides\' intent');
  assert.match(prompts, /never force-push|do not force-push|NOT force-push/i);
  assert.match(prompts, /do not merge the PR|never merge the PR|NOT merge the PR/i);
  const gate = s.find((x) => x.type === 'quality-gate');
  assert.ok(gate, 'there is no test gate');
  const loops = (gate!.config.routingRules as { nextStepId: string }[] | undefined) ?? [];
  assert.ok(loops.length > 0, 'a failing test gate must send the work back to the resolution');
});
