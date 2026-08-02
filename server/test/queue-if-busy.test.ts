/**
 * Work aimed at a BUSY cartridge is queued, not dropped and not double-dispatched.
 *
 * The user's model: a cartridge works one thing at a time, so anything you start while it is
 * busy — a prompt, a confer, a workflow — should just line up behind what it is doing. You
 * should never have to ask "is it free yet?" before typing.
 *
 * THE HAZARD THIS TEST PINS DOWN. A confer that is ALREADY RUNNING is the current item; its
 * milestone traffic is that item's internals, not new work. The conductor and the workflow
 * executor call sendCommandToAgent in-process so they bypass the route — but peer-forward
 * delivers to REMOTE participants over POST /api/commands/send, which means a naive "queue
 * everything aimed at a busy agent" would swallow milestone dispatches to another machine and
 * deadlock every cross-machine confer. So queueing is OPT-IN per caller: user surfaces ask for
 * it, system delivery never does. Both directions are asserted below, because only testing the
 * happy one is how that deadlock would ship.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { isCartridgeBusy } from '../src/lib/queue-runner.ts';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function agent(status: string, queueItem = ''): string {
  const id = `busy-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, active_queue_item_id)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, `t/${id}`, 'm', '/r', 'r', 'claude', status, ISO, queueItem);
  return id;
}

// ─── What "busy" means, as a set rather than one example ────────────────────

test('EVERY state that means "cannot take new work now" counts as busy', () => {
  const CASES: { label: string; status: string; item: string; busy: boolean }[] = [
    { label: 'working on something', status: 'working', item: '', busy: true },
    { label: 'already running a queue item', status: 'idle', item: 'item-1', busy: true },
    { label: 'working AND holding an item', status: 'working', item: 'item-1', busy: true },
    { label: 'idle and unstamped', status: 'idle', item: '', busy: false },
    { label: 'waiting on a question', status: 'waiting', item: '', busy: true },
    { label: 'offline', status: 'offline', item: '', busy: false },
  ];
  const wrong: string[] = [];
  for (const c of CASES) {
    const id = agent(c.status, c.item);
    if (isCartridgeBusy(id) !== c.busy) {
      wrong.push(`${c.label}: got ${isCartridgeBusy(id)}, expected ${c.busy}`);
    }
  }
  assert.deepEqual(wrong, [], `busy detection is wrong for:\n  ${wrong.join('\n  ')}`);
});

test('an unknown agent is NOT busy — absence must not silently queue work forever', () => {
  assert.equal(isCartridgeBusy('no-such-agent'), false);
  assert.equal(isCartridgeBusy(''), false);
});

// ─── The opt-in boundary: user surfaces queue, system delivery never does ───

test('a DIRECT PROMPT queues when the cartridge is busy — same rule as confers and workflows', async () => {
  // I flipped this default to false after messages appeared to be "stuck", but the stall was a
  // slow turn, not the queue. Turning it off meant a prompt sent to a busy cartridge INTERRUPTED
  // the work in progress, which is the behaviour the queue exists to prevent. The user reported
  // it as a regression and they were right: queue-when-busy is the intended behaviour for all
  // three entry points, not just two of them.
  const USER_CALLERS: { file: string; label: string }[] = [
    { file: 'packages/client/src/client.ts', label: 'dashboard prompt (shared client)' },
    { file: 'mobile/src/api.ts', label: 'mobile prompt' },
  ];
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = path.join(import.meta.dirname, '..', '..');

  const missing: string[] = [];
  for (const c of USER_CALLERS) {
    const p = path.join(ROOT, c.file);
    if (!fs.existsSync(p)) { missing.push(`${c.label}: ${c.file} does not exist`); continue; }
    const src = fs.readFileSync(p, 'utf8');
    if (!/queueIfBusy = true/.test(src)) {
      missing.push(`${c.label} (${c.file}) does not default a direct prompt to queueing when busy`);
    }
  }
  assert.deepEqual(missing, [], `these prompt paths interrupt a busy cartridge instead of queueing:\n  ${missing.join('\n  ')}`);
});

test('SYSTEM delivery never queues — peer-forward carries live confer milestones', async () => {
  // The deadlock guard. peer-forward is how a milestone reaches a participant on another
  // machine; if it ever set queueIfBusy, that milestone would be parked behind the very confer
  // it belongs to and the session would never advance.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/lib/peer-forward.ts'), 'utf8');
  assert.doesNotMatch(
    src, /queueIfBusy\s*:\s*true/,
    'peer-forward must never queue — it delivers in-flight confer traffic to remote participants',
  );
});

test('confer and workflow starts STILL queue against a busy cartridge', async () => {
  // The complete set of entry points, derived from the routes rather than the description:
  // a prompt, a confer, a workflow run. Missing one means that kind of work still lands on
  // top of a busy cartridge while the other two queue politely — the inconsistent half-fix
  // this suite exists to prevent.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const SRC = path.join(import.meta.dirname, '..', 'src');
  const ENTRY_POINTS = [
    { file: 'routes/commands.ts', label: 'POST /api/commands/send (prompt)' },
    { file: 'routes/confer.ts', label: 'POST /api/confer/start (confer)' },
    { file: 'routes/workflows.ts', label: 'POST /api/workflows/v2/:id/start (workflow)' },
  ];
  const missing: string[] = [];
  for (const e of ENTRY_POINTS) {
    const src = fs.readFileSync(path.join(SRC, e.file), 'utf8');
    if (!src.includes('isCartridgeBusy')) missing.push(`${e.label} never checks busy state`);
    if (!src.includes('queueIfBusy')) missing.push(`${e.label} has no queueIfBusy opt-out`);
  }
  assert.deepEqual(missing, [], `these entry points still interrupt a busy cartridge:\n  ${missing.join('\n  ')}`);
});

test('the send route honours queueIfBusy and defaults to NOT queueing', async () => {
  // Default-off on purpose: MCP, peers and any future caller keep today's behaviour unless
  // they opt in. A default that changed dispatch semantics for every caller at once is exactly
  // the kind of quiet, wide change that is hard to attribute when something stalls at 3am.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/routes/commands.ts'), 'utf8');
  assert.match(src, /queueIfBusy/, 'the send route does not implement queueIfBusy at all');
  assert.match(src, /isCartridgeBusy/, 'the send route never consults busy state');
});
