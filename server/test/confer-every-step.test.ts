/**
 * Run ANY workflow with two repos conferring on EVERY step.
 *
 * REPORTED, after two wrong shapes from me: "I want to be able to select any of the workflow
 * and have two repos confer on each step of the workflow. Like epic jira task would work
 * together on completing tasks whichever repo owns the code throughout."
 *
 * What I built before and why neither was this:
 *   Epic: Two Repos           — one owner per branch, joined at the end. They never talk.
 *   Epic: Confer Across Repos — ONE step is a confer. The rest are single-owner, and it is a
 *                               new template rather than something you can apply to the
 *                               template you already wanted to run.
 *
 * This is a RUN-LEVEL MODE, not a step type and not a template: pick Epic: Task by Task, or
 * anything else, name the cartridges, and every step that would have gone to one of them goes
 * to all of them as a confer instead. "Whichever repo owns the code" is then decided by the
 * participants at each step, which is the only place it can be decided — the template author
 * does not know, and a scoping step guessing up front is what made the first attempt wrong.
 *
 * ── WHY THIS IS SET-BASED OVER EXECUTOR TYPES ───────────────────────────────────────────
 * The conversion happens at launch, over whatever steps the chosen template happens to have.
 * A conversion that handles claude-code and silently ignores the rest turns a mixed workflow
 * into a half-confer: some steps collaborative, some not, no error anywhere. Every type in
 * the union must therefore be a stated decision — converted, already multi-agent, or exempt
 * with a reason — and a type added later must fail this until someone decides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every executor type, read from the union rather than remembered. */
function executorTypes(): string[] {
  const src = read('server/src/types.ts');
  const line = src.slice(src.indexOf('export type StepExecutorType'));
  return [...line.slice(0, line.indexOf(';')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

test('the executor-type set is read from the union, not remembered', () => {
  const types = executorTypes();
  assert.ok(types.length >= 8, `expected the executor union, parsed ${types.length}`);
  for (const t of ['claude-code', 'confer', 'decision', 'connector']) {
    assert.ok(types.includes(t), `union parse missed ${t} — the scanner is broken`);
  }
});

test('the launch path offers a run-level confer mode', () => {
  const routes = read('server/src/routes/workflows.ts');
  assert.match(routes, /conferAllSteps/,
    'no run-level option to make every step a confer — this is the ask: pick ANY workflow, ' +
    'name the cartridges, and have them work it together throughout');
});

test('EVERY executor type is a stated decision in the conversion', () => {
  // The conversion must name every type: which it rewrites, which are already multi-agent,
  // and which are deliberately left alone. Silence for a type is a half-converted run.
  const routes = read('server/src/routes/workflows.ts');
  const block = routes.slice(routes.indexOf('conferAllSteps'));
  const scope = block.slice(0, 4000);
  const unstated = executorTypes().filter((t) => !scope.includes(`'${t}'`));
  assert.deepEqual(unstated, [],
    `the run-level confer conversion says nothing about: ${unstated.join(', ')} — ` +
    'a type it ignores stays single-owner and the run is silently half collaborative');
});

test('gates and human steps are NOT converted', () => {
  // Structural, not a word-match. The first version only asserted the words "verdict" or
  // "judgement" appeared somewhere in the block, and passed a mutation that reclassified
  // review-gate as 'convert' — the exact breakage it was written to prevent.
  //
  // A gate reads PASS/FAIL out of a step result. A confer produces WORK, not a judgement, so
  // converting one breaks it as a gate that never passes — which reads as the agents being
  // bad at their job rather than as a wiring mistake. A decision step waits for a HUMAN;
  // converting it would quietly replace your judgement with the agents' own.
  const routes = read('server/src/routes/workflows.ts');
  const table = routes.slice(routes.indexOf('const CONFER_CONVERSION'));
  const body = table.slice(0, table.indexOf('};'));
  assert.ok(body.length > 40, 'could not read the conversion table — scanner broken');

  for (const [type, forbidden] of [
    ['review-gate', 'convert'], ['quality-gate', 'convert'], ['decision', 'convert'],
  ] as const) {
    const m = body.match(new RegExp(`'${type}':\\s*'([a-z-]+)'`));
    assert.ok(m, `${type} is missing from the conversion table`);
    assert.notEqual(m![1], forbidden,
      `${type} is set to '${forbidden}' — a gate is a judgement and a decision is yours; ` +
      'neither survives being turned into collaborative work');
  }
  // And the one that MUST convert, or the mode does nothing at all.
  const cc = body.match(/'claude-code':\s*'([a-z-]+)'/);
  assert.equal(cc?.[1], 'convert', "claude-code must convert — it is the mode's entire point");
});

/**
 * ── EVERY SURFACE THAT LETS A HUMAN PICK CARTRIDGES MUST OFFER CONFER ───────────────────
 *
 * Caught by the stop hook asking whether the SET was complete. It was not: I wired the two
 * launchers I happened to be looking at — the workflow panel and the phone — and left the
 * canvas editor and the goals page, both of which present a cartridge picker of their own.
 *
 * That is the exact failure this standard exists to prevent. A mode reachable from two of four
 * launchers is not a mode; it is a feature that works depending on which button you pressed,
 * and nothing anywhere reports the difference.
 *
 * The set is derived from the CALL SITES of the launch client function, filtered to the ones
 * where a human chooses cartridges — a launcher that assigns none has nothing to offer.
 */
const LAUNCH_SURFACES = [
  { file: 'dashboard/src/components/WorkflowPanel.tsx',         picks: 'runAgentId + per-step' },
  { file: 'dashboard/src/components/WorkflowCanvasEditor.tsx',  picks: 'deferredAssignments' },
  { file: 'dashboard/src/components/GoalsPage.tsx',             picks: 'agentId' },
  { file: 'mobile/src/screens/WorkflowsScreen.tsx',             picks: 'agentId + per-step' },
] as const;

test('the launch-surface set is real — each one does let a human pick cartridges', () => {
  // Self-checking: a surface listed here that assigns no cartridge would be a stale entry,
  // and demanding confer of it would be noise.
  const notPickers = LAUNCH_SURFACES
    .filter((s) => !/agentId|deferredAssignments/.test(read(s.file)))
    .map((s) => s.file);
  assert.deepEqual(notPickers, [],
    `listed as cartridge pickers but assign none: ${notPickers.join(', ')}`);
  assert.equal(LAUNCH_SURFACES.length, 4, 'the launcher set changed — update it deliberately');
});

test('EVERY launch surface can start a run-level confer', () => {
  const missing = LAUNCH_SURFACES
    .filter((s) => !/conferAllSteps|conferAgents/.test(read(s.file)))
    .map((s) => `${s.file} (picks ${s.picks})`);
  assert.deepEqual(missing, [],
    `these let you choose cartridges but not to confer, so the mode depends on which button ` +
    `you pressed:\n  ${missing.join('\n  ')}`);
});
