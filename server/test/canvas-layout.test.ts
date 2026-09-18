/**
 * STEPS ON THE CANVAS ARE EVENLY SPACED, EVERYWHERE, BY ONE NUMBER.
 *
 * "All the steps are close together instead of having a bit of space between each one."
 *
 * There were FOUR spacings, because every place that positions a step invented its own:
 *   · seedDefaultTemplates (db.ts)              — y += 175, typed as a literal into ~150 steps
 *   · the run clone (routes/workflows.ts)       — STEP_SPACING = 230
 *   · withStandardGate                          — positionY: 0  (every gate stacked at the top)
 *   · withReportStep / ensureReportStepOnTemplates — lastY + 175
 *   · the canvas's own "auto layout" button     — 50 + i * 280
 * The node is 300px wide with content-driven height, so 175 overlaps and 280 is the value
 * someone actually tuned by looking at it. Opening a template showed the 175 version; pressing
 * auto-layout showed the 280 version; they were the same workflow.
 *
 * SET-BASED OVER EVERY TEMPLATE, not a sample, because the old values were literals spread
 * across 26 template definitions — a fix applied to the ones someone opened looks identical
 * from the ones they did not.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { STEP_SPACING_Y, STEP_START_Y, STEP_X, layoutSteps } from '../src/lib/workflow-layout.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

type Row = { id: string; name: string; position_x: number; position_y: number; depends_on: string };

const stepsOf = (id: string) =>
  db.prepare(
    'SELECT id, name, position_x, position_y, depends_on FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(id) as Row[];

test('the spacing is big enough for a node that is 300px wide with a real body', () => {
  // Not an arbitrary number: it is the value the canvas auto-layout already used, which is the
  // one that was tuned against the rendered node rather than guessed.
  assert.ok(STEP_SPACING_Y >= 240, `${STEP_SPACING_Y}px will crowd or overlap the nodes`);
  assert.ok(STEP_SPACING_Y <= 400, `${STEP_SPACING_Y}px wastes the canvas`);
});

test('EVERY template lays its steps out evenly, in dependency order', () => {
  const templates = db.prepare(
    'SELECT id, name FROM workflows WHERE template_id IS NULL ORDER BY name',
  ).all() as { id: string; name: string }[];
  assert.ok(templates.length > 0);

  const bad: string[] = [];
  for (const t of templates) {
    const steps = stepsOf(t.id);
    if (steps.length < 2) continue;

    // Evenly spaced, starting where every other template starts.
    if (steps[0].position_y !== STEP_START_Y) {
      bad.push(`${t.name}: first step at y=${steps[0].position_y}, expected ${STEP_START_Y}`);
    }
    for (let i = 1; i < steps.length; i++) {
      const gap = steps[i].position_y - steps[i - 1].position_y;
      if (gap !== STEP_SPACING_Y) {
        bad.push(`${t.name}: "${steps[i - 1].name}" → "${steps[i].name}" gap is ${gap}, expected ${STEP_SPACING_Y}`);
        break;
      }
    }
    // One column. A stray x turns a linear workflow into a diagonal.
    const strayX = steps.find((s) => s.position_x !== STEP_X);
    if (strayX) bad.push(`${t.name}: "${strayX.name}" sits at x=${strayX.position_x}, expected ${STEP_X}`);

    // A step must never be drawn ABOVE something it depends on.
    const yOf = new Map(steps.map((s) => [s.id, s.position_y]));
    for (const s of steps) {
      let deps: string[] = [];
      try { deps = JSON.parse(s.depends_on || '[]'); } catch { deps = []; }
      for (const d of deps) {
        const dy = yOf.get(d);
        if (dy !== undefined && dy >= s.position_y) {
          bad.push(`${t.name}: "${s.name}" is drawn above/level with its own dependency`);
          break;
        }
      }
    }
  }

  assert.deepEqual(bad, [],
    `${bad.length} layout problem(s):\n  ${bad.slice(0, 12).join('\n  ')}`);
  console.log(`[set] ${templates.length}/${templates.length} templates evenly spaced at ${STEP_SPACING_Y}px`);
});

test('layoutSteps is idempotent — running it twice changes nothing', () => {
  const t = db.prepare("SELECT id FROM workflows WHERE template_id IS NULL LIMIT 1").get() as { id: string };
  const before = stepsOf(t.id).map((s) => `${s.id}:${s.position_y}`);
  layoutSteps(db, t.id);
  layoutSteps(db, t.id);
  assert.deepEqual(stepsOf(t.id).map((s) => `${s.id}:${s.position_y}`), before);
});

test('a branching workflow still draws every step below its dependencies', () => {
  // Parallel branches share a level in dependency order; what must never happen is a step
  // appearing above something it waits on.
  const wfId = 'layout-branch-wf';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at)
              VALUES (?,'Branchy','','pending','[]',?,'')`).run(wfId, now);
  const ins = db.prepare(`INSERT INTO workflow_steps
    (id,workflow_id,name,description,position_x,position_y,executor_type,executor_id,executor_config,auto_advance,depends_on,created_at)
    VALUES (?,?,?,'',0,0,'claude-code','a','{}',1,?,?)`);
  ins.run('b-root', wfId, 'root', '[]', now);
  ins.run('b-l', wfId, 'left', JSON.stringify(['b-root']), now);
  ins.run('b-r', wfId, 'right', JSON.stringify(['b-root']), now);
  ins.run('b-join', wfId, 'join', JSON.stringify(['b-l', 'b-r']), now);

  layoutSteps(db, wfId);
  const y = new Map(stepsOf(wfId).map((s) => [s.id, s.position_y]));
  assert.ok(y.get('b-l')! > y.get('b-root')!, 'left branch drawn above its root');
  assert.ok(y.get('b-r')! > y.get('b-root')!, 'right branch drawn above its root');
  assert.ok(y.get('b-join')! > y.get('b-l')!, 'join drawn above its left input');
  assert.ok(y.get('b-join')! > y.get('b-r')!, 'join drawn above its right input');

  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(wfId);
  db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);
});

test('NO site invents its own spacing any more', () => {
  // The four values were spread across five files. Each one that keeps its own literal is a
  // surface that will drift away from the others again.
  const SITES = [
    'server/src/routes/workflows.ts',
    'server/src/lib/workflow-report.ts',
    'server/src/lib/workflow-from-template.ts',
  ];
  const offenders: string[] = [];
  for (const f of SITES) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/position_?Y?\s*[:=]\s*[^,;)\n]*?\b(175|230)\b/gi)) {
      offenders.push(`${f}: ${m[0].trim()}`);
    }
    if (/const STEP_SPACING\s*=\s*\d+/.test(src)) offenders.push(`${f}: declares its own STEP_SPACING`);
  }
  assert.deepEqual(offenders, [],
    `these still carry a private spacing literal:\n  ${offenders.join('\n  ')}`);
});

test('the canvas auto-layout agrees with the server — one workflow, one look', () => {
  // The server positions steps; the canvas button re-positions them. Two numbers meant pressing
  // "auto layout" visibly rearranged a workflow that was already laid out.
  const canvas = read('dashboard/src/components/WorkflowCanvasEditor.tsx');
  const m = canvas.match(/positionY:\s*\d+\s*\+\s*\(indexMap\.get\(s\.id\)\s*\?\?\s*0\)\s*\*\s*(\d+)/);
  assert.ok(m, 'the canvas auto-layout no longer matches the scanned shape — update this test');
  assert.equal(Number(m[1]), STEP_SPACING_Y,
    `the canvas lays out at ${m[1]}px while the server uses ${STEP_SPACING_Y}px — pressing ` +
    'auto-layout would visibly move a workflow that was already positioned');
});
