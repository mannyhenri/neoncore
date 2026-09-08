/**
 * NO REGISTERED QUEUE KIND MAY NAME ITS ITEM WITH A UUID FRAGMENT.
 *
 * REPORTED: "Can we not list the tasks/workflows/confer with codenames/ids and the actual name
 * of the prompt and workflow used."
 *
 * All four kinds did exactly that — `workflow 4a2f1b0c`, `task 9c3e0d51`, `confer with 3
 * participants`, `prompt -> 2 cartridge(s)` — and those strings are what `[queue] started …`
 * writes to the log a person reads when a lane has drained overnight.
 *
 * ── DRIVEN OVER THE REGISTRY, NOT A LIST OF FOUR ─────────────────────────────────────
 * The set is `QUEUE_KINDS` itself, so a fifth kind added tomorrow is tested the day it is
 * registered rather than the day someone remembers this file. Each kind gets a REAL row in the
 * database and a REAL item pointing at it, because the failure being prevented is precisely a
 * `describe` that reports an id instead of reading through to the name.
 *
 * ── DEGRADING TO AN ID IS CORRECT, AND IS ALSO TESTED ────────────────────────────────
 * A workflow whose template was deleted has no name to find. Returning the fragment there is
 * honest; returning the bare word "workflow" would be a label that identifies nothing. Both
 * directions are pinned, so a future "always show something friendly" change cannot quietly
 * make two different deleted items describe identically.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { QUEUE_KINDS, type QueueItem } from '../src/lib/queue-kinds.ts';

installStubIO();

const iso = () => new Date().toISOString();

/** A uuid fragment as `.slice(0, 8)` leaves it: 8 hex characters standing alone as a word. */
const UUID_FRAGMENT = /\b[0-9a-f]{8}\b/;

// ── Real rows for the describers to read through to ─────────────────────────
db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen)
            VALUES ('ag-name-1','mac/gl-dev','mac','/r/gl-dev','gl-dev','claude','working',?)`).run(iso());
db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen)
            VALUES ('ag-name-2','mac/baseback','mac','/r/baseback','baseback','codex','working',?)`).run(iso());
db.prepare(`INSERT INTO workflows (id,name,status,created_at,template_id,run_number,initial_context,context_label)
            VALUES ('wf-name-1','Epic: Task by Task','running',?,'tpl-1',11,'GRD-3665','GRD-3665')`).run(iso());
// A TEMPLATE is a workflows row with run_number 0 — the same table, not a separate one.
db.prepare(`INSERT INTO workflows (id,name,status,created_at,run_number)
            VALUES ('tpl-1','Epic: Task by Task','pending',?,0)`).run(iso());
db.prepare(`INSERT INTO tasks (id,title,prompt,status,created_at)
            VALUES ('tk-name-1','Fix the photo gallery paging','do it','pending',?)`).run(iso());

function item(kind: string, payload: Record<string, unknown>, targets: string[]): QueueItem {
  return {
    id: 'q-0000aaaa-1111', kind, payload, targets, lane: 'l', status: 'queued', position: 0,
    handle: '', result: '', error: '', createdAt: iso(), startedAt: null, finishedAt: null,
    attempts: 0, stallTicks: 0, paused: false, corrupt: false,
  } as QueueItem;
}

/**
 * One representative item per kind, keyed by kind name so the coverage assertion below can prove
 * the table and the registry are the same set.
 */
const SPECIMENS: Record<string, QueueItem> = {
  prompt: item('prompt', { text: 'Fix the memory button in the iOS app' }, ['ag-name-1', 'ag-name-2']),
  workflow: item('workflow', { workflowId: 'wf-name-1' }, ['/r/gl-dev']),
  confer: item('confer', { task: 'Decide the schema for revisions', participantIds: ['ag-name-1', 'ag-name-2'] }, []),
  task: item('task', { taskId: 'tk-name-1', agentId: 'ag-name-1' }, ['ag-name-1']),
};

test('the specimen table covers EVERY registered kind', () => {
  // Without this the table falls behind the registry and every assertion below keeps passing
  // while a new kind goes unchecked — a green number pointed at a shrinking scope.
  const registered = QUEUE_KINDS.map((k) => k.kind).sort();
  assert.deepEqual(Object.keys(SPECIMENS).sort(), registered);
});

test('EVERY kind describes its item by name, never by a uuid fragment', () => {
  const wrong: string[] = [];
  for (const def of QUEUE_KINDS) {
    const got = def.describe(SPECIMENS[def.kind]);
    if (!got.trim()) { wrong.push(`${def.kind}: described as nothing at all`); continue; }
    if (UUID_FRAGMENT.test(got)) wrong.push(`${def.kind}: "${got}" still contains a uuid fragment`);
    if (got.includes(SPECIMENS[def.kind].id)) wrong.push(`${def.kind}: "${got}" names the queue row, not the work`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('each description carries the words a person would search for', () => {
  const byKind = Object.fromEntries(QUEUE_KINDS.map((k) => [k.kind, k.describe(SPECIMENS[k.kind])]));
  assert.match(byKind.prompt, /memory button/i, 'the prompt text is the prompt\'s name');
  assert.match(byKind.prompt, /gl-dev/, 'and the cartridges are named, not counted');
  assert.match(byKind.workflow, /Epic: Task by Task/, 'the template name');
  assert.match(byKind.workflow, /GRD-3665/, 'and the subject, which is what the run is ABOUT');
  assert.match(byKind.confer, /revisions/i, 'the confer subject');
  assert.match(byKind.confer, /gl-dev.*baseback|baseback.*gl-dev/, 'and who is in it');
  assert.match(byKind.task, /photo gallery/i, 'the task title');
});

test('a TEMPLATE id names the template, with no run number invented for it', () => {
  const got = QUEUE_KINDS.find((k) => k.kind === 'workflow')!.describe(item('workflow', { workflowId: 'tpl-1' }, []));
  assert.equal(got, 'Epic: Task by Task', 'a template has not run yet, so "#0" would be a lie');
});

test('a target that no longer exists degrades to its id rather than to a lie', () => {
  // Two deleted workflows must not describe identically — that is the failure mode of replacing
  // an unknown id with a friendly constant.
  const a = QUEUE_KINDS.find((k) => k.kind === 'workflow')!.describe(item('workflow', { workflowId: 'deadbeef-gone-1' }, []));
  const b = QUEUE_KINDS.find((k) => k.kind === 'workflow')!.describe(item('workflow', { workflowId: 'cafebabe-gone-2' }, []));
  assert.notEqual(a, b, 'two different missing workflows describe the same — the id was thrown away');
  assert.match(a, /deadbeef/, 'the id is all that is known, so it is what gets reported');
});

test('a fan-out prompt does not print a name per cartridge', () => {
  const many = ['ag-name-1', 'ag-name-2', 'ag-name-1', 'ag-name-2', 'ag-name-1'];
  const got = QUEUE_KINDS.find((k) => k.kind === 'prompt')!.describe(item('prompt', { text: 'sweep' }, many));
  assert.match(got, /\+2\b/, 'a nine-cartridge fan-out must not produce a nine-name log line');
});
