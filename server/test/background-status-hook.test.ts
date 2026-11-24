import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The reporter hook forwards the Stop / SubagentStop hook input's `background_tasks` (documented by
 * Claude Code) to /api/activity as `backgroundTasks` — the server's source of truth for "this turn
 * paused on its own running work" (server/src/lib/background-tasks.ts). See background-status.test.ts.
 *
 * THE SET: both events that carry the list × every task type the docs name that we act on, plus the
 * two edge cases that must not be confused: an EMPTY list (nothing in flight → close everything) and
 * an ABSENT field (older Claude Code → change nothing). Other events never carry it.
 */
const seen: { url: string; body: Record<string, unknown> }[] = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => { try { seen.push({ url: req.url ?? '', body: JSON.parse(b || '{}') }); } catch { /* not json */ } res.setHeader('content-type', 'application/json'); res.end('{}'); });
});
const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
after(() => server.close());

const HOOK = path.resolve('../agent/hooks/reporter.py');

function fire(input: Record<string, unknown>): Promise<number | null> {
  seen.length = 0;
  return new Promise((resolve) => {
    const child = spawn('python3', [HOOK], {
      env: { ...process.env, NEONCORE_URL: `http://127.0.0.1:${port}`, NEONCORE_FLEET_TOKEN: 'test-token', NEONCORE_TRUST: '' },
    });
    const kill = setTimeout(() => child.kill(), 20_000);
    child.on('close', (status) => { clearTimeout(kill); resolve(status); });
    child.stdin.end(JSON.stringify({ session_id: 'sess-bg-hook', cwd: '/tmp/bg-hook-repo', tool_input: {}, ...input }));
  });
}
const activityBody = () => seen.find((s) => s.url === '/api/activity')?.body;

const TYPES = ['shell', 'monitor', 'subagent', 'workflow'];

for (const event of ['Stop', 'SubagentStop']) {
  for (const type of TYPES) {
    test(`reporter × ${event} × ${type}: background_tasks reaches /api/activity`, async () => {
      const task = { id: `t-${type}`, type, status: 'running', description: `the ${type} work`, command: 'x'.repeat(900) };
      assert.equal(await fire({ hook_event_name: event, background_tasks: [task] }), 0);
      const body = activityBody();
      assert.ok(body, 'no activity posted');
      const sent = body!.backgroundTasks as Record<string, unknown>[];
      assert.equal(sent.length, 1);
      assert.equal(sent[0].id, task.id);
      assert.equal(sent[0].type, type);
      assert.equal(sent[0].description, task.description);
      assert.equal((sent[0].command as string).length, 500, 'long strings are capped');
    });
  }

  test(`reporter × ${event}: an EMPTY list is sent as empty (nothing in flight)`, async () => {
    await fire({ hook_event_name: event, background_tasks: [] });
    assert.deepEqual(activityBody()!.backgroundTasks, []);
  });

  test(`reporter × ${event}: an ABSENT field is not sent (unknown, not "nothing")`, async () => {
    await fire({ hook_event_name: event });
    assert.ok(!('backgroundTasks' in activityBody()!));
  });
}

test('reporter × PostToolUse: never carries backgroundTasks', async () => {
  await fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash', background_tasks: [{ id: 'x', type: 'shell' }] });
  assert.ok(!('backgroundTasks' in activityBody()!));
});
