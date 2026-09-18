/**
 * WHICH CARTRIDGES DOES THIS RUN DRIVE? ONE ANSWER.
 *
 * Reported as confer "still" failing after two launch fixes. Both fixes were real; this is a
 * THIRD site asking the same question and getting a different answer:
 *
 *     Cannot attach files: none of the selected cartridges has a repo path
 *
 * The cartridges had repo paths. The attachment code found the run's repos with
 * `JOIN agents a ON a.id = s.executor_id` — and the confer conversion deliberately EMPTIES
 * executor_id ("it stops meaning anything for a confer step"), putting the roster in
 * executorConfig.conferAgentIds instead. The join matched nothing, so a confer run with an
 * attachment failed on launch every time.
 *
 * THREE SITES, THREE ANSWERS:
 *   · unrunnableSteps (lib/workflow-launch.ts)  — taught about confer via CONFER_FILL
 *   · resolveWorkflowTargets (lib/queue-if-busy.ts) — never taught; a confer run looks like it
 *     drives NO cartridge, so the busy-guard would let it start on top of live work
 *   · the attachment JOIN (routes/workflows.ts)  — never taught; this failure
 *
 * workflow-launch.ts's own header already warned about it: "Deliberately mirrors
 * resolveWorkflowTargets … Two different answers would mean a launch that satisfies the busy
 * guard and fails the assignment guard, or worse, the reverse." There were three.
 *
 * SET-BASED OVER THE SOURCES a cartridge can arrive from, because the failure is always the
 * same shape — a source one site knows about and another does not.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { workflowCartridges, CARTRIDGE_SOURCES } from '../src/lib/workflow-cartridges.ts';
import { installStubIO } from './helpers/stub-io.ts';

installStubIO();
const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const iso = () => new Date().toISOString();
let n = 0;

function cartridge(): string {
  const id = `wc-cart-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id)
     VALUES (?,?,'mac',?,?,'claude','idle',?,?)`,
  ).run(id, id, `/tmp/${id}`, id, iso(), `s-${id}`);
  return id;
}

/** A one-step run whose step is shaped by `shape`. */
function runWithStep(shape: { executorType?: string; executorId?: string; config?: Record<string, unknown> }): string {
  const wfId = `wc-wf-${++n}`;
  db.prepare(`INSERT INTO workflows (id,name,description,status,target_repos,created_at,started_at,template_id,run_number)
              VALUES (?,'R','','running','[]',?,?,'t',1)`).run(wfId, iso(), iso());
  db.prepare(
    `INSERT INTO workflow_steps (id,workflow_id,name,description,position_x,position_y,
       executor_type,executor_id,executor_config,auto_advance,depends_on,created_at)
     VALUES (?,?,'step','',300,50,?,?,?,1,'[]',?)`,
  ).run(`${wfId}-s`, wfId, shape.executorType ?? 'claude-code', shape.executorId ?? '',
        JSON.stringify(shape.config ?? {}), iso());
  return wfId;
}

/**
 * THE REGISTRY: every way a cartridge can be attached to a run. Each case puts ONE cartridge
 * in play through exactly one source and expects it found.
 */
function sourceCases(): { source: string; make: () => { workflowId: string; body?: Record<string, unknown>; expect: string } }[] {
  return [
    {
      source: 'executor_id', make: () => {
        const c = cartridge();
        return { workflowId: runWithStep({ executorId: c }), expect: c };
      },
    },
    {
      source: 'body.agentId (run-level fill)', make: () => {
        const c = cartridge();
        return { workflowId: runWithStep({ executorId: '__deferred__' }), body: { agentId: c }, expect: c };
      },
    },
    {
      source: 'body.agentOverrides', make: () => {
        const c = cartridge();
        const wfId = runWithStep({ executorId: '__deferred__' });
        return { workflowId: wfId, body: { agentOverrides: { [`${wfId}-s`]: c } }, expect: c };
      },
    },
    {
      source: 'body.conferAllSteps (run-level confer at launch)', make: () => {
        const c = cartridge(); const c2 = cartridge();
        return { workflowId: runWithStep({ executorId: '__deferred__' }), body: { conferAllSteps: [c, c2] }, expect: c };
      },
    },
    {
      source: 'executorConfig.conferAgentIds (a converted confer step)', make: () => {
        // THE REPORTED BUG: executor_id is EMPTY by design here.
        const c = cartridge(); const c2 = cartridge();
        return { workflowId: runWithStep({ executorType: 'confer', executorId: '', config: { conferAgentIds: [c, c2] } }), expect: c };
      },
    },
    {
      source: 'executorConfig.panelAgentIds (deliberation)', make: () => {
        const c = cartridge(); const c2 = cartridge();
        return { workflowId: runWithStep({ executorType: 'deliberation', executorId: '', config: { panelAgentIds: [c, c2] } }), expect: c };
      },
    },
    {
      source: 'executorConfig.reviewAgentId (review gate)', make: () => {
        const c = cartridge();
        return { workflowId: runWithStep({ executorType: 'review-gate', executorId: '', config: { reviewAgentId: c } }), expect: c };
      },
    },
  ];
}

test('the source registry is declared, not remembered', () => {
  const cases = sourceCases();
  assert.equal(CARTRIDGE_SOURCES.length, cases.length,
    `CARTRIDGE_SOURCES lists ${CARTRIDGE_SOURCES.length} sources but this test exercises ${cases.length} — one of them is out of date`);
  console.log(`[set] ${CARTRIDGE_SOURCES.length} sources a cartridge can arrive from`);
});

test('EVERY source is found — including the one that only a confer step uses', () => {
  const missed: string[] = [];
  for (const c of sourceCases()) {
    const { workflowId, body, expect } = c.make();
    const found = workflowCartridges(workflowId, body);
    if (!found.includes(expect)) missed.push(`${c.source} → found [${found.join(', ')}], expected ${expect}`);
  }
  assert.deepEqual(missed, [],
    `a cartridge source was invisible:\n  ${missed.join('\n  ')}`);
  console.log(`[set] ${sourceCases().length}/${sourceCases().length} sources resolved`);
});

test('a cartridge that no longer exists is never returned', () => {
  const wfId = runWithStep({ executorId: 'ghost-cartridge' });
  assert.deepEqual(workflowCartridges(wfId), [],
    'a stale id was reported as a live target — it would queue the run behind a ghost');
});

test('__deferred__ and blank are not cartridges', () => {
  assert.deepEqual(workflowCartridges(runWithStep({ executorId: '__deferred__' })), []);
  assert.deepEqual(workflowCartridges(runWithStep({ executorId: '' })), []);
});

test('the same cartridge reached twice is returned once', () => {
  const c = cartridge();
  const wfId = runWithStep({ executorId: c });
  assert.deepEqual(workflowCartridges(wfId, { agentId: c, conferAllSteps: [c, c] }), [c]);
});

// ── The reported failure, end to end ───────────────────────────────────────────────────

test('a confer run resolves REPO PATHS — the attachment failure that was reported', () => {
  const a = cartridge(); const b = cartridge();
  const wfId = runWithStep({ executorType: 'confer', executorId: '', config: { conferAgentIds: [a, b] } });

  const repos = workflowCartridges(wfId)
    .map((id) => (db.prepare('SELECT repo_path FROM agents WHERE id = ?').get(id) as { repo_path: string }).repo_path)
    .filter(Boolean);

  assert.equal(repos.length, 2,
    'a confer run resolved no repo paths — this is exactly "Cannot attach files: none of the ' +
    'selected cartridges has a repo path", which failed every confer launch that had an attachment');
});

test('NO site still resolves a run\'s cartridges by its own query', () => {
  // Three sites asked this question and gave three answers. The attachment site's inline
  // `JOIN agents a ON a.id = s.executor_id` is the one that produced the reported failure.
  const routes = read('server/src/routes/workflows.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/JOIN agents a ON a\.id = s\.executor_id/.test(routes),
    'the attachment path still derives repos from executor_id alone — a confer step has none');

  const queue = read('server/src/lib/queue-if-busy.ts');
  assert.match(queue, /workflowCartridges\(/,
    'resolveWorkflowTargets does not use the shared resolver, so the busy guard still cannot ' +
    'see a confer run\'s cartridges and would start it on top of live work');
});
