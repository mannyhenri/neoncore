/**
 * Every column the server WRITES must reach a READER.
 *
 * This test exists because the capability-routing feature produced the same defect three
 * times in a row, and each time it was caught by a human noticing rather than by a test:
 *
 *   1. `trouble_signals` events were emitted for three confers and never consumed.
 *   2. `gridlight.modelId` was read from settings and never written by anything.
 *   3. `workflow_steps.routing_note` was written on every routing substitution — the FIX for
 *      (1) and (2) — and surfaced by no serializer, no type, and no component.
 *
 * The class is "a field with a writer and no reader". Every example-based test in this
 * feature passed while all three were live, because an example-based test asserts the thing
 * you remembered; the whole failure mode is the thing you did not.
 *
 * So this iterates the SCHEMA, not a list. Add a column to `workflow_steps` or `agents` and
 * this fails until you either surface it or declare it internal WITH A REASON. That is the
 * point: the decision becomes mandatory at the moment the column is added, instead of
 * optional forever.
 *
 * It also auto-discovers serializers rather than naming them. `normalizeStep` exists TWICE —
 * routes/workflows.ts and lib/workflow-executor-v2.ts — and the second one is the copy that
 * emits during execution, which is exactly when a routing note is written. A test naming one
 * file would have passed while the live path still dropped the field.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';

const SRC = path.join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every definition of `function <name>(` in server/src, with its body.
 *
 * Brace-matched rather than regex-terminated: a serializer body contains `{}` in its own
 * object literal, so "up to the next closing brace" would truncate it and the test would
 * pass by reading only the first few fields.
 */
function findFunctions(name: string): { file: string; body: string }[] {
  const found: { file: string; body: string }[] = [];
  for (const file of tsFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const at = src.indexOf(`function ${name}(`, from);
      if (at === -1) break;
      const open = src.indexOf('{', at);
      let depth = 0;
      let end = open;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i; break; }
      }
      found.push({ file: path.relative(SRC, file), body: src.slice(open, end + 1) });
      from = end + 1;
    }
  }
  return found;
}

function columnsOf(table: string): string[] {
  return (db.prepare(`SELECT * FROM pragma_table_info(?)`).all(table) as { name: string }[])
    .map((r) => r.name);
}

/**
 * Columns a serializer deliberately does not surface. Each needs a reason, because "not
 * surfaced" and "forgotten" look identical from the outside — which is how routing_note
 * shipped write-only.
 */
const INTERNAL_STEP_COLUMNS: Record<string, string> = {
  plan_content: 'server-side prompt material; the client renders dispatched_prompt instead',
  tokens_in: 'accounting, aggregated by the pricing routes rather than per step',
  tokens_out: 'accounting, aggregated by the pricing routes rather than per step',
  native_session_id: "the engine's own session handle; meaningless to a client",
  dispatch_session_id:
    'which cartridge session this step\'s prompt was dispatched into. Compared against the ' +
    'agent\'s CURRENT session to detect a prompt delivered into a session that has since been ' +
    'replaced (see lib/step-session-guard.ts). Purely a recovery signal — a client shows the ' +
    'step status, not the plumbing that keeps it alive.',
};

const INTERNAL_AGENT_COLUMNS: Record<string, string> = {
  trust_mode: 'derived — the serializer computes trustMode from agent_mode',
  memory_enabled: 'read directly by the memory routes, never through the agent payload',
  recovery_session_id: 'internal handle for resuming; the client sees recovery_status',
  standard_armed: 'work-standard internals; standard_state is the surfaced rollup',
  standard_blocks: 'work-standard internals; standard_state is the surfaced rollup',
  standard_offered: 'work-standard internals; standard_state is the surfaced rollup',
  active_queue_item_id:
    'the queue binding stamp — read by queue-kinds.recordQueueCompletion to bind a completion ' +
    'report to the item that caused it, never by a client. Revisit when a queue UI needs to show ' +
    'which item a cartridge is on.',
};

const CASES = [
  { table: 'workflow_steps', serializer: 'normalizeStep', internal: INTERNAL_STEP_COLUMNS, minCopies: 2 },
  { table: 'agents', serializer: 'normalizeAgent', internal: INTERNAL_AGENT_COLUMNS, minCopies: 2 },
];

for (const c of CASES) {
  test(`every ${c.table} column is surfaced by EVERY ${c.serializer}, or declared internal`, () => {
    const serializers = findFunctions(c.serializer);

    // A test that finds nothing passes silently. If the serializer is renamed this must
    // fail loudly rather than quietly stop checking anything at all.
    assert.ok(
      serializers.length >= c.minCopies,
      `expected at least ${c.minCopies} ${c.serializer} definitions, found ${serializers.length} — ` +
      `if it was renamed or consolidated, update this test rather than letting it go vacuous`,
    );

    const missing: string[] = [];
    for (const col of columnsOf(c.table)) {
      if (col in c.internal) continue;
      for (const s of serializers) {
        // `row.<col>` is how every serializer in this codebase reads a column.
        if (!s.body.includes(`row.${col}`)) missing.push(`${s.file} drops ${c.table}.${col}`);
      }
    }

    assert.deepEqual(
      missing, [],
      `these columns are written but never reach a client:\n  ${missing.join('\n  ')}\n` +
      `Either surface them in the serializer, or add them to the internal map WITH a reason.`,
    );
  });
}

/**
 * The serializer tests above prove every column is MENTIONED. This one proves the value
 * actually comes back over HTTP.
 *
 * Worth the extra machinery: "the serializer reads row.routing_note" and "the API returns
 * routingNote" are different claims, and this whole feature has been a sequence of the first
 * being true while the second was not. It drives the real express route, so a wrong route
 * shape, a stale SELECT, or a serializer that is never reached all fail here.
 */
test('the API actually returns routingNote — not just a serializer that mentions it', async (t) => {
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  // The routes emit on mutation, so io must exist — but a RECORDING STUB, not a real Socket.IO
  // Server. A test must not be able to emit to anything a human is reading, and constructing a
  // real server from a test sets the same module-global that production reads. The HTTP round
  // trip below is the point of this test and is unaffected.
  (await import('./helpers/stub-io.js')).installStubIO();
  app.use('/api/workflows', (await import('../src/routes/workflows.js')).default);

  const now = new Date().toISOString();
  const NOTE = 'capability routing: claude-code -> frontier (INELIGIBLE: T4 bar unmet: judgement)';
  db.prepare('INSERT INTO workflows (id, name, created_at) VALUES (?,?,?)').run('wf-probe', 'probe', now);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, description, position_x, position_y,
    executor_type, executor_id, executor_config, auto_advance, status, depends_on, created_at, routing_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('s-probe', 'wf-probe', 'probe step', '', 0, 0, 'claude-code', '', '{}', 1, 'pending', '[]', now, NOTE);

  await new Promise<void>((r) => server.listen(0, () => r()));
  t.after(() => { server.close(); });

  const { port } = server.address() as import('node:net').AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/workflows/v2/wf-probe`);
  const body = (await res.json()) as { steps: { routingNote?: string }[] };

  assert.equal(res.status, 200);
  assert.equal(
    body.steps[0]?.routingNote, NOTE,
    'the routing decision must reach the client — a note the UI never receives is the same ' +
    'dead drop this feature has now shipped three times',
  );
});

/**
 * The register handler has two paths — UPDATE for a known cartridge, INSERT for a new one —
 * and they are separate SQL statements listing separate columns. `model` was added to the
 * UPDATE and left out of the INSERT, so a cartridge's model was persisted on every
 * registration EXCEPT the first. First registration is most launches, and an empty model
 * means no profile lookup, which means every function routes frontier: the exact bug the
 * fix was for, surviving in the path the fix did not touch.
 */
test('the register INSERT persists every column the register UPDATE writes', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'agents.ts'), 'utf8');
  const register = src.slice(src.indexOf("router.post('/register'"));

  const updateSql = register.slice(register.indexOf('UPDATE agents SET'), register.indexOf('WHERE id = ?'));
  const insertCols = register.slice(register.indexOf('INSERT INTO agents ('), register.indexOf('VALUES'));

  // Columns the UPDATE assigns: `col = ?` or `col = COALESCE(...)`.
  const updated = [...updateSql.matchAll(/(\w+)\s*=/g)].map((m) => m[1])
    .filter((c) => !['SET', 'NULLIF', 'COALESCE'].includes(c));

  // Set on creation by other means, so their absence from the INSERT is not a bug.
  const CREATION_EXEMPT = new Set(['dismissed_at']);

  const dropped = updated.filter((c) => !CREATION_EXEMPT.has(c) && !insertCols.includes(c));
  assert.deepEqual(
    dropped, [],
    `the UPDATE path persists these but the INSERT drops them, so a FIRST registration ` +
    `loses them: ${dropped.join(', ')}`,
  );
});
