// FIRST import — the queue reaches db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { enqueue, tickQueue, reconcileQueue } from '../src/lib/queue-runner.ts';

/** laneState is module-private, so read the row the same way it does. */
function lanePaused(lane: string): boolean {
  const r = db.prepare('SELECT paused FROM queue_lanes WHERE lane = ?').get(lane) as { paused?: number } | undefined;
  return Boolean(r?.paused);
}

installStubIO();

/**
 * Work queued for an IDLE cartridge must eventually run.
 *
 * REPORTED: "neoncore had a task assigned for a cartridge and the agent was idled and it didn't
 * execute it". It is a real bug, and the mechanism is the lane halt.
 *
 * `haltLane` takes a `kind`, and tickQueue auto-resumes exactly ONE kind — HALT_BLOCKED, the
 * "waited too long for a wedged blocker" case. Its comment states the principle exactly right:
 *
 *     "A halt for 'the cartridge was busy' is transient by definition. If it outlives its cause
 *      the lane sits stopped with work queued behind a cartridge that is free again — the exact
 *      overnight failure the halt existed to prevent."
 *
 * That reasoning applies just as well to `reconcileQueue`, which halts a lane on every server
 * restart that interrupts a running prompt — "may still be mid-prompt". That cause is equally
 * transient: the cartridge either is still working or it is not, and the auto-resume path
 * already asks precisely that question before releasing a lane. But reconcile passes no kind,
 * so the halt is permanent until a person clicks resume. Restart the server a few times in a
 * day — a deploy, a crash — and lanes accumulate stopped, each with work behind a cartridge
 * that has been idle for hours.
 *
 * SET-BASED over the haltLane CALL SITES parsed out of the source, because the question is not
 * "does reconcile do this" but "which halts can outlive their cause" — and the next halt added
 * will default to permanent by simply omitting an argument.
 */

const SRC = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'lib', 'queue-runner.ts'), 'utf8',
);

/** Every haltLane(...) call in the runner, and whether it names a self-clearing kind. */
function haltSites(): { line: number; text: string; transient: boolean }[] {
  const out: { line: number; text: string; transient: boolean }[] = [];
  const lines = SRC.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*haltLane\(/.test(lines[i])) continue;
    // A call can span lines; take enough to see its arguments.
    const text = lines.slice(i, i + 7).join(' ');
    const call = text.slice(0, text.indexOf(');') + 2);
    out.push({ line: i + 1, text: call.replace(/\s+/g, ' ').slice(0, 110), transient: /HALT_BLOCKED|HALT_TRANSIENT/.test(call) });
  }
  return out;
}

test('the halt-site scan is real — an empty scan would pass vacuously', () => {
  assert.ok(haltSites().length >= 6, `expected several haltLane call sites, found ${haltSites().length}`);
});

/**
 * THE SET: which halts have a TRANSIENT cause — one that resolves itself when the cartridge
 * becomes healthy — and therefore must not need a human to clear.
 *
 * A halt for a corrupt row or a thrown detector is a real fault: it should wait for a person.
 * A halt because a machine was busy, or because this process restarted, is not.
 */
const TRANSIENT_CAUSES = [/restarted while/, /stayed offline/, /waited \$\{?/, /waited /];

test('a halt whose cause clears itself must not need a human to clear it', () => {
  const failures: string[] = [];
  for (const site of haltSites()) {
    const transientCause = TRANSIENT_CAUSES.some((p) => p.test(site.text));
    if (transientCause && !site.transient) {
      failures.push(`queue-runner.ts:${site.line} halts for a cause that resolves itself but passes no self-clearing kind — ${site.text}`);
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

// ── The behaviour that report describes ──────────────────────────────────────

const AGENT = 'agent-under-test';

function seedIdleAgent(status = 'idle'): void {
  db.prepare('DELETE FROM agents').run();
  db.prepare('DELETE FROM queue_items').run();
  db.prepare('DELETE FROM queue_lanes').run();
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id)
              VALUES (?, 'test/repo', 'testbox', '/tmp/repo', 'repo', ?, ?, 's1')`)
    .run(AGENT, status, new Date().toISOString());
}

test('BASELINE: an idle cartridge with an open lane gets its queued work dispatched', () => {
  seedIdleAgent('idle');
  const r = enqueue({ kind: 'prompt', payload: { text: 'do the thing' }, targets: [AGENT] });
  assert.ok(r.ok, 'enqueue failed');

  tickQueue();

  const item = db.prepare('SELECT status FROM queue_items LIMIT 1').get() as { status: string };
  assert.notEqual(item.status, 'queued',
    'an idle cartridge with an open lane did not get its work — the queue is broken at its simplest case');
});

test('THE BUG: after a restart halt, an idle cartridge never gets the work behind it', () => {
  // The cartridge must be FREE to be dispatched to, and working when the restart lands. Seeding
  // it 'working' produced no running item at all — reconcile then had nothing to halt, and the
  // test passed through the interesting code without touching it. The fixture assertion below
  // is what caught that.
  seedIdleAgent('idle');
  const r = enqueue({ kind: 'prompt', payload: { text: 'first' }, targets: [AGENT] });
  assert.ok(r.ok);
  tickQueue();                        // dispatches it — the lane now has a running item
  db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);

  const running = db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE status = 'running'").get() as { n: number };
  assert.equal(running.n, 1, 'fixture did not produce a running item');

  // A second piece of work arrives behind it — the "task assigned to a cartridge".
  assert.ok(enqueue({ kind: 'prompt', payload: { text: 'second' }, targets: [AGENT] }).ok);

  // The server restarts. reconcile fails the running prompt and halts the lane.
  reconcileQueue();
  assert.equal(lanePaused(`agent:${AGENT}`), true, 'reconcile did not halt the lane');

  // The cartridge finishes whatever it was doing and goes idle. Hours pass.
  db.prepare("UPDATE agents SET status = 'idle', active_queue_item_id = '' WHERE id = ?").run(AGENT);
  for (let i = 0; i < 300; i++) tickQueue();   // 300 ticks = 75 minutes

  const second = db.prepare("SELECT status FROM queue_items WHERE payload_json LIKE '%second%'").get() as { status: string };
  assert.notEqual(second.status, 'queued',
    'the cartridge has been idle for 75 minutes of ticks and its queued work never ran — '
    + 'the restart halt outlived its cause, which is the reported bug');
});
