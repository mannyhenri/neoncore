/**
 * A HAND-OFF TO THE INBOX IS IN FLIGHT, NOT LOST.
 *
 * Reported as "make sure run 81 runs on gl-dev". Its first step failed in 4ms with "no command
 * channel": gl-dev had just been relaunched, its relay was not up, and the dispatch went to the
 * cartridge's addressed inbox. For that transport `sendCommandToAgent` returns
 * `delivered: false` because the result is not known yet (ADX-005). The row became `delivered`
 * 48s later, but the executor had already read `delivered === false` as "nothing is listening"
 * and failed the step. ADX-005 meant to rescue dispatches that would otherwise be lost. Every
 * caller that failed on `delivered === false` undid that rescue.
 *
 * SET 1 checks every call site in src: none may judge delivery with a raw
 * `delivered === false` / `!== false`. They all go through `noChannel`, which fails only
 * when nothing could carry the command.
 * SET 2 drives the executor: an inbox hand-off leaves the step running, a hand-off the inbox
 * refuses fails the step once that is known, and no channel at all still fails at once.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'crypto';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { deliverToAgent } from '../src/lib/peer-forward.ts';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { inboxPathFor } from '../src/lib/inbox-client.ts';

installStubIO();
const iso = () => new Date().toISOString();
const SRC_DIR = path.join(import.meta.dirname, '..', 'src');

// ── SET 1: every call site ─────────────────────────────────────────────────────────────

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

test('no call site judges delivery with a raw delivered === false', () => {
  const RAW = /\.delivered\s*[!=]==\s*false/;
  const offenders: string[] = [];
  for (const file of srcFiles(SRC_DIR)) {
    if (file.endsWith(path.join('lib', 'delivery.ts'))) continue;   // the one place the rule lives
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (RAW.test(line)) offenders.push(`${path.relative(SRC_DIR, file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `these read an in-flight inbox hand-off as "nothing listening" — use noChannel():\n${offenders.join('\n')}`);
});

// ── SET 2: behaviour against a real socket ──────────────────────────────────────────────

const SOCK = inboxPathFor(process.pid);
let server: net.Server | null = null;
test.before(async () => {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch { /* not there */ }
  server = net.createServer((s) => { s.on('data', () => {}); s.on('error', () => {}); });
  await new Promise<void>((r) => server!.listen(SOCK, () => r()));
});
test.after(() => {
  try { server?.close(); } catch { /* closed */ }
  try { fs.unlinkSync(SOCK); } catch { /* gone */ }
});

/** A cartridge with no relay socket. `inboxPid` 0 = no inbox at all. */
function cartridge(inboxPid: number): string {
  const id = `idn-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,
                         pending_question,inbox_pid,inbox_token,active_queue_item_id)
     VALUES (?,?,?,?,?,'claude','idle',?,?,'',?,'tok','')`,
  ).run(id, id, 'm', `/tmp/${id}`, `repo-${id}`, iso(), `s-${id}`, inboxPid);
  return id;
}

function runWithStep(agentId: string): string {
  const runId = randomUUID();
  const stepId = randomUUID();
  db.prepare(`INSERT INTO workflows (id,name,status,run_number,template_id,created_at,started_at)
              VALUES (?, 'idn', 'running', 1, 'tpl', ?, ?)`).run(runId, iso(), iso());
  db.prepare(`INSERT INTO workflow_steps (id,workflow_id,name,position_y,status,executor_type,executor_id,executor_config,depends_on,created_at)
              VALUES (?,?, 'Load Epic', 0, 'pending', 'claude-code', ?, '{"prompt":"load it"}', '[]', ?)`)
    .run(stepId, runId, agentId, iso());
  return stepId;
}

const step = (id: string) =>
  db.prepare('SELECT status, error FROM workflow_steps WHERE id = ?').get(id) as { status: string; error: string };
const settle = () => new Promise((r) => setTimeout(r, 400));

const CASES: { name: string; inboxPid: () => number; expect: string; errorLike?: RegExp }[] = [
  { name: 'live inbox, no relay', inboxPid: () => process.pid, expect: 'running' },
  // A pid no process holds: the inbox refuses it (stale-pid), so the hand-off failed.
  { name: 'inbox that refuses the hand-off', inboxPid: () => 2 ** 22 + 7, expect: 'failed', errorLike: /inbox/i },
  { name: 'no inbox, no relay', inboxPid: () => 0, expect: 'failed', errorLike: /no command channel/ },
];

for (const c of CASES) {
  test(`executor step, ${c.name} → ${c.expect}`, async () => {
    const stepId = runWithStep(cartridge(c.inboxPid()));
    tickWorkflowsOnce();
    await settle();
    const s = step(stepId);
    assert.equal(s.status, c.expect, `step is ${s.status} (${s.error})`);
    if (c.errorLike) assert.match(s.error, c.errorLike);
  });
}

test('deliverToAgent counts a live-inbox hand-off as delivered', async () => {
  const out = await deliverToAgent(cartridge(process.pid), 'milestone',
    (id, body) => sendCommandToAgent(id, body, false));
  assert.equal(out.delivered, true, `reported undelivered: ${out.reason}`);
});
