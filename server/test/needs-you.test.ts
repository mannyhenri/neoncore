import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { needsYou, ASKS_AS_ITEMS, type NeedsYouKind } from '../src/lib/needs-you.ts';
import { createFeature } from '../src/routes/goals.ts';
import { createPilotRow } from '../src/lib/goal-pilot.ts';

/**
 * NEEDS YOU, FROM STATE — "sometimes I need to be notified to act on something and have no
 * warnings." The bell held the last 20 events of the open tab; an ask sent while it was closed,
 * or pushed out by routine notices, was never seen. lib/needs-you.ts answers "what is waiting on
 * me?" from the rows instead.
 *
 * THE SETS:
 *   every announcePilot(…, 'action') in the code — each ask has an item kind, so none exists only
 *     as an event that can be missed;
 *   every state a feature can wait on the person in (and the ones it must NOT list), and a run that
 *     is no feature's.
 */
installStubIO();
const ISO = new Date().toISOString();

/** Every announcePilot call in src/, with its event and urgency, read from the source. */
function announcements(): { file: string; event: string; urgency: string }[] {
  const out: { file: string; event: string; urgency: string }[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!/\.ts$/.test(f.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      let i = 0;
      while ((i = src.indexOf('announcePilot(', i)) >= 0) {
        if (/function\s+$/.test(src.slice(Math.max(0, i - 12), i))) { i += 14; continue; }
        let depth = 0, j = i + 'announcePilot'.length;
        for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; }
        const call = src.slice(i, j + 1);
        const ev = call.match(/^announcePilot\(\s*[\w.!]+,\s*'([^']+)'/);
        const urg = call.match(/'(action|info)'\s*,?\s*\)$/);
        if (ev && urg) out.push({ file: path.relative('src', p), event: ev[1], urgency: urg[1] });
        i = j;
      }
    }
  };
  walk('src');
  return out;
}

test('every feature announcement that asks you to act has an item on the list — none is only an event', () => {
  const asks = announcements().filter((a) => a.urgency === 'action');
  assert.ok(asks.length >= 12, `found only ${asks.length} — the source scan is broken`);
  for (const a of asks) assert.ok(ASKS_AS_ITEMS[a.event], `${a.file}: "${a.event}" asks the person to act but has no needs-you item`);
});

// ── the states ──────────────────────────────────────────────────────────────

let k = 0;
function feature(phase: string, opts: { attention?: string; involvement?: string; workspace?: unknown; goalStatus?: string } = {}) {
  const id = ++k;
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at) VALUES (?, NULL, ?, '', '/tmp/r', '#fff', ?, ?)`).run(`np${id}`, `P${id}`, ISO, ISO);
  const goalId = createFeature({ projectId: `np${id}`, name: `Feature ${id}` });
  if (opts.goalStatus) db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(opts.goalStatus, goalId);
  const pilot = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: 'x', involvement: opts.involvement ?? 'balanced' } });
  db.prepare('UPDATE goal_pilots SET phase = ?, attention = ?, workspace = ? WHERE id = ?')
    .run(phase, opts.attention ?? '', opts.workspace ? JSON.stringify(opts.workspace) : '', pilot.id);
  return { pilotId: pilot.id, goalId };
}
let st = 0;
function stage(pilotId: string, kind: string, status: string, extra: { wait?: string; runId?: string } = {}) {
  db.prepare(`INSERT INTO goal_pilot_stages (id, pilot_id, position, kind, stage_key, template_id, template_name, title, why, focus, repo_path, agent_type, project_id, run_id, agent_id, status, wait_reason)
              VALUES (?, ?, ?, ?, ?, '', '', ?, '', '', '/tmp/r', 'claude', '', ?, '', ?, ?)`)
    .run(`st${++st}`, pilotId, st, kind, `k${st}`, `Stage ${st}`, extra.runId ?? '', status, extra.wait ?? '');
}
let rn = 0;
function run(goalId: string | null, step: { type: string; config: Record<string, unknown>; status?: string; result?: string }, autonomy = 'advance') {
  const id = `nrun${++rn}`;
  db.prepare(`INSERT INTO workflows (id, name, description, status, created_at, run_number, goal_id, autonomy) VALUES (?, 'CE Develop and Optimize', '', 'running', ?, 1, ?, ?)`).run(id, ISO, goalId ?? '', autonomy);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, auto_advance, position_y, created_at, result, completed_at)
              VALUES (?, ?, 'Gate', ?, ?, '', ?, 1, 0, ?, ?, ?)`).run(`${id}-s`, id, step.status ?? 'running', step.type, JSON.stringify(step.config), ISO, step.result ?? '', step.status === 'completed' ? ISO : null);
  return id;
}
const itemsFor = (pilotId: string) => needsYou().filter((i) => i.pilotId === pilotId);
const kinds = (pilotId: string) => itemsFor(pilotId).map((i) => i.kind).sort();
const OPTIONS = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];

const PHASES: { phase: string; want: NeedsYouKind[] }[] = [
  { phase: 'scoping', want: [] }, { phase: 'planning', want: [] },
  { phase: 'clarifying', want: ['questions'] }, { phase: 'proposed', want: ['plan'] }, { phase: 'staffing', want: ['start'] },
  { phase: 'running', want: [] }, { phase: 'cancelled', want: [] },
];
for (const p of PHASES) {
  test(`a feature ${p.phase}: ${p.want.join(', ') || 'nothing'} on the list`, () => {
    assert.deepEqual(kinds(feature(p.phase).pilotId), p.want);
  });
}

test('stopped: the reason it stopped is what to do', () => {
  const { pilotId } = feature('paused', { attention: 'Stage 3 (Live eval) failed. Open its run to see why, then retry or skip it.' });
  const [i] = itemsFor(pilotId);
  assert.equal(i.kind, 'stopped');
  assert.match(i.what, /Live eval\) failed/);
});

test('stages waiting on the person: tests to approve, checklist to confirm, a cartridge to start', () => {
  const a = feature('running'); stage(a.pilotId, 'acceptance', 'review');
  assert.deepEqual(kinds(a.pilotId), ['tests']);
  const b = feature('running'); stage(b.pilotId, 'review', 'review');
  assert.deepEqual(kinds(b.pilotId), ['checklist']);
  const c = feature('running'); stage(c.pilotId, 'workflow', 'waiting', { wait: 'Start a Claude Code cartridge in /code/gl-dev — the stage starts when it connects.' });
  assert.deepEqual(kinds(c.pilotId), ['cartridge']);
  assert.match(itemsFor(c.pilotId)[0].what, /Start a Claude Code cartridge/);
});

test('a running stage whose run waits on the person is listed with the agent\'s own ask', () => {
  const f = feature('running');
  const r = run(f.goalId, { type: 'claude-code', status: 'completed',
    config: { _coverageHold: { detail: '3 of 10 task(s) are still open after "Verify Coverage and Evidence".' } },
    result: 'NEXT: Person: lock docs/pipeline-shard-72b/prompts.proposed-v2.json as contract v2 and lift the pause.\n\nPass 2: no task workable. 3 remaining.' });
  stage(f.pilotId, 'workflow', 'running', { runId: r });
  const [i] = itemsFor(f.pilotId);
  assert.equal(i?.kind, 'run');
  assert.match(i.what, /3 of 10 task\(s\) are still open/);
  assert.match(i.what, /The agent asks: Person: lock docs\/pipeline-shard-72b/);
});

test('a feature\'s template decision with a recommendation is NOT listed (it is taken); without one, or hands-on, it is', () => {
  const taken = feature('running'); stage(taken.pilotId, 'workflow', 'running', { runId: run(taken.goalId, { type: 'decision', config: { question: 'Triage complete?', options: OPTIONS, recommendation: 'a' } }) });
  assert.deepEqual(kinds(taken.pilotId), []);
  const open = feature('running'); stage(open.pilotId, 'workflow', 'running', { runId: run(open.goalId, { type: 'decision', config: { question: 'Which?', options: OPTIONS } }) });
  assert.deepEqual(kinds(open.pilotId), ['run']);
  const handsOn = feature('running', { involvement: 'hands-on' }); stage(handsOn.pilotId, 'workflow', 'running', { runId: run(handsOn.goalId, { type: 'decision', config: { question: 'Triage complete?', options: OPTIONS, recommendation: 'a' } }, 'manual') });
  assert.deepEqual(kinds(handsOn.pilotId), ['run']);
});

test('finished: mark it done; merge blocked; left for you to merge — and nothing once it has landed', () => {
  const repo = (extra: Record<string, unknown>) => ({ repoPath: '/r', worktreePath: '/r-f', agentType: 'claude', base: 'main', pr: { url: 'https://x/pr/1', number: 1, state: 'open' }, error: '', removed: false, ...extra });
  assert.deepEqual(kinds(feature('completed').pilotId), ['mark-done']);
  assert.deepEqual(kinds(feature('completed', { goalStatus: 'achieved' }).pilotId), []);
  const blocked = feature('completed', { goalStatus: 'achieved', workspace: { branch: 'feature/x', prsAt: ISO, repos: [repo({ error: 'conflicts with the base branch' })] } });
  assert.deepEqual(kinds(blocked.pilotId), ['merge-blocked']);
  assert.match(itemsFor(blocked.pilotId)[0].what, /conflicts with the base branch/);
  const mine = feature('completed', { goalStatus: 'achieved', workspace: { branch: 'feature/x', prsAt: ISO, mergeMyself: true, repos: [repo({})] } });
  assert.deepEqual(kinds(mine.pilotId), ['merge-yourself']);
  const landed = feature('completed', { goalStatus: 'achieved', workspace: { branch: 'feature/x', prsAt: ISO, cleanedAt: ISO, repos: [repo({ removed: true, pr: { url: 'u', number: 1, state: 'merged' } })] } });
  assert.deepEqual(kinds(landed.pilotId), []);
});

test('a run that is no feature\'s is listed when a person must clear it, once; never when it is a feature\'s stage', () => {
  const id = run(null, { type: 'decision', config: { question: 'Ship?', options: OPTIONS, recommendation: 'a' } });
  const mine = needsYou().filter((i) => i.workflowId === id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].kind, 'run');
  assert.equal(mine[0].pilotId, '');
});
