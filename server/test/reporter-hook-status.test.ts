import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WORKING_EVENTS, FINISHED_EVENTS } from '../src/lib/activity-status.ts';

/**
 * ONLY AN EVENT THAT MEANS "WORKING" MAY SAY "WORKING" — in the hook too.
 *
 * REPORTED: "the busy not busy is still an issue… the terminal wasn't busy, and NeonCore considered
 * it busy… so another delay was added there." FacetDB's planner, 2026-11-23: its turn ended at
 * 12:21:43; a background subagent finished at 12:24:47; the next planner request (12:26:50) was
 * queued as "busy" and sent only at 12:27:18 when the staleness sweep let it go.
 *
 * The server already knew a SubagentStop means nothing about availability (activity-status.ts
 * FINISHED_EVENTS). But the reporter hook re-registers the cartridge on EVERY event with
 * `status: 'working'` hardcoded — so the register call undid what the activity route got right.
 *
 * THE SET: every hook event the reporter can receive, run through the real script against a
 * stand-in server. Its register says `working` exactly for the events the server counts as working
 * (WORKING_EVENTS, in the hook's names); for the rest it says nothing, so the status stands.
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
/** Hook names → the event names the server classifies (the reporter renames UserPromptSubmit). */
const AS_SERVER: Record<string, string> = { UserPromptSubmit: 'user_prompt' };
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification', 'PreCompact'];

/** Run the real hook (async: a blocking spawn would freeze the stand-in server it posts to). */
function fire(event: string): Promise<{ status: number | null; stderr: string }> {
  seen.length = 0;
  return new Promise((resolve) => {
    const child = spawn('python3', [HOOK], {
      env: { ...process.env, NEONCORE_URL: `http://127.0.0.1:${port}`, NEONCORE_FLEET_TOKEN: 'test-token', NEONCORE_TRUST: '' },
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const kill = setTimeout(() => child.kill(), 20_000);
    child.on('close', (status) => { clearTimeout(kill); resolve({ status, stderr }); });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'sess-hook-test', cwd: '/tmp/hook-repo', tool_name: event.includes('Tool') ? 'Bash' : '', tool_input: {} }));
  });
}

for (const event of HOOK_EVENTS) {
  test(`reporter hook × ${event}: register says "working" only if the server counts ${event} as working`, async () => {
    const r = await fire(event);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.status, 0, r.stderr);
    const reg = seen.find((s) => s.url === '/api/agents/register');
    assert.ok(reg, `no register for ${event}: ${JSON.stringify(seen.map((s) => s.url))}`);
    const serverName = AS_SERVER[event] ?? event;
    const working = WORKING_EVENTS.has(serverName) && !FINISHED_EVENTS.has(serverName);
    assert.equal(reg!.body.status, working ? 'working' : undefined, `${event}: register status ${JSON.stringify(reg!.body.status)}`);
  });
}
