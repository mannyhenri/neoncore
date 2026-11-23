/**
 * DESKTOP NOTIFICATIONS FROM THE SERVER — the OS notification centre, no browser tab required.
 *
 * SCOPE:
 *   · every platform with a notifier (darwin: terminal-notifier / osascript, linux: notify-send,
 *     win32: PowerShell toast) produces a command — and title/body never become code;
 *   · every notice type is classified: the ones that need a person are shown by default, the
 *     informational ones only in `all`;
 *   · the three modes, the env override, and the settings API;
 *   · Goal Pilot raises a notice at every point it needs the person.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  desktopCommand, desktopChannel, needsAction, ACTION_TYPES, DESKTOP_MODES, __setDesktopForTests, type DesktopCommand,
} from '../src/lib/channels/desktop.ts';
import { registerChannel, clearChannels, notifyAll, type Notice } from '../src/lib/channels.ts';
import pushRouter from '../src/routes/push.ts';
import goalPilotsRouter from '../src/routes/goal-pilots.ts';
import { getPilot } from '../src/lib/goal-pilot.ts';
import { sweepPilots } from '../src/lib/goal-pilot-runner.ts';

const io = installStubIO();
const app = express();
app.use(express.json());
app.use('/api/push', pushRouter);
app.use('/api/goal-pilots', goalPilotsRouter);
let server!: Server;
const base = await new Promise<string>((resolve) => {
  server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
after(() => server.close());
const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

const HOSTILE = { title: 'Step "x"; $(rm -rf ~) `id`', body: "it's \"quoted\" & $HOME \\ end" };
const everything = () => true;

test('every platform with a notifier gets a command, and the text is data, never code', () => {
  const cases: { platform: NodeJS.Platform; has: (b: string) => boolean; env?: NodeJS.ProcessEnv; cmd: string }[] = [
    { platform: 'darwin', has: (b) => b === 'terminal-notifier' || b === 'osascript', cmd: 'terminal-notifier' },
    { platform: 'darwin', has: (b) => b === 'osascript', cmd: 'osascript' },
    { platform: 'linux', has: (b) => b === 'notify-send', env: { DISPLAY: ':0' }, cmd: 'notify-send' },
    { platform: 'win32', has: (b) => b === 'powershell', cmd: 'powershell' },
  ];
  for (const c of cases) {
    const out = desktopCommand(c.platform, { ...HOSTILE, data: { type: 'permission_request' } }, { has: c.has, env: c.env, url: 'http://localhost:4040/' });
    assert.ok(out, `${c.platform}/${c.cmd}: no command`);
    assert.equal(out!.cmd, c.cmd);
    // The hostile text is passed whole as ONE argument or env value — not embedded in a script.
    const carriers = [...out!.args, ...Object.values(out!.env ?? {})];
    assert.ok(carriers.includes(HOSTILE.title), `${c.cmd}: the title is not passed as data`);
    assert.ok(carriers.includes(HOSTILE.body), `${c.cmd}: the body is not passed as data`);
    const scripts = out!.args.filter((a) => a !== HOSTILE.title && a !== HOSTILE.body);
    for (const s of scripts) assert.ok(!s.includes('rm -rf') && !s.includes('$HOME'), `${c.cmd}: notice text leaked into code: ${s}`);
  }
});

test('no notifier, no command — and Linux without a desktop session is "none", not a failing call', () => {
  assert.equal(desktopCommand('darwin', HOSTILE, { has: () => false }), null);
  assert.equal(desktopCommand('linux', HOSTILE, { has: everything, env: {} }), null);
  assert.equal(desktopCommand('win32', HOSTILE, { has: () => false }), null);
  assert.equal(desktopCommand('aix', HOSTILE, { has: everything }), null);
});

test('an action-needed notice is urgent on every platform; an informational one is not', () => {
  const urgent = { ...HOSTILE, data: { type: 'workflow_attention' } };
  const info = { ...HOSTILE, data: { type: 'workflow_finished' } };
  assert.ok(desktopCommand('linux', urgent, { has: everything, env: { DISPLAY: ':0' } })!.args.includes('--urgency=critical'));
  assert.ok(desktopCommand('linux', info, { has: everything, env: { DISPLAY: ':0' } })!.args.includes('--urgency=normal'));
  assert.ok(desktopCommand('darwin', urgent, { has: (b) => b === 'osascript' })!.args[1].includes('sound name'));
  assert.ok(!desktopCommand('darwin', info, { has: (b) => b === 'osascript' })!.args[1].includes('sound name'));
  assert.ok(desktopCommand('darwin', urgent, { has: everything, url: 'http://x/' })!.args.includes('-open'), 'terminal-notifier opens the dashboard on click');
});

test('classification: every action type needs a person; the informational types do not', () => {
  for (const type of ACTION_TYPES) assert.equal(needsAction({ title: 't', body: 'b', data: { type } }), true, type);
  for (const type of ['workflow_finished', 'workflow_auto_resolved', 'workflow_connector_notification', 'goal_pilot_info']) {
    assert.equal(needsAction({ title: 't', body: 'b', data: { type } }), false, type);
  }
  assert.equal(needsAction({ title: 't', body: 'b', actions: [{ id: 'x', label: 'Approve' }] }), true, 'buttons mean someone must press one');
  assert.equal(needsAction({ title: 't', body: 'b', urgency: 'info', data: { type: 'permission_request' } }), false, 'an explicit urgency wins');
});

test('modes: action shows only what needs you, all shows everything, off shows nothing', async () => {
  const spawned: DesktopCommand[] = [];
  __setDesktopForTests({ platform: 'linux', has: everything, spawner: async (c) => { spawned.push(c); return { ok: true }; } });
  process.env.DISPLAY = ':0';
  const action: Notice = { title: 'Needs you', body: 'b', data: { type: 'permission_request' } };
  const info: Notice = { title: 'Done', body: 'b', data: { type: 'workflow_finished' } };
  const shown: Record<string, string[]> = {};
  for (const mode of DESKTOP_MODES) {
    process.env.NEONCORE_DESKTOP_NOTIFY = mode;
    spawned.length = 0;
    await desktopChannel.send(action);
    await desktopChannel.send(info);
    shown[mode] = spawned.map((c) => c.args[c.args.length - 2]);
  }
  delete process.env.NEONCORE_DESKTOP_NOTIFY;
  assert.deepEqual(shown, { action: ['Needs you'], all: ['Needs you', 'Done'], off: [] });
});

test('it is a real channel: notifyAll reaches the desktop', async () => {
  const spawned: DesktopCommand[] = [];
  __setDesktopForTests({ platform: 'linux', has: everything, spawner: async (c) => { spawned.push(c); return { ok: true }; } });
  process.env.DISPLAY = ':0';
  clearChannels();
  registerChannel(desktopChannel);
  await notifyAll({ title: 'Approve Bash?', body: 'rm -rf build', data: { type: 'permission_request' } });
  assert.equal(spawned.length, 1);
  clearChannels();
});

test('the settings API reports what the machine can do and validates the mode', async () => {
  __setDesktopForTests({ platform: 'linux', has: () => false });
  let st = await call('GET', '/api/push/desktop');
  assert.equal(st.json.available, false);
  assert.match(st.json.reason, /notify-send/);
  __setDesktopForTests({ platform: 'linux', has: everything });
  process.env.DISPLAY = ':0';
  assert.equal((await call('PUT', '/api/push/desktop', { mode: 'loud' })).status, 400);
  st = await call('PUT', '/api/push/desktop', { mode: 'all' });
  assert.equal(st.status, 200);
  assert.deepEqual([st.json.mode, st.json.available, st.json.notifier], ['all', true, 'notify-send']);
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'desktop_notifications'`).get() as { value: string };
  assert.equal(row.value, 'all');
});

// ── Goal Pilot tells the person every time it needs them ─────────────────────

test('Goal Pilot announces: questions, plan, a stage with no cartridge, and the finish', async () => {
  const seen: Notice[] = [];
  clearChannels();
  registerChannel({ name: 'collector', isConfigured: () => true, async send(n) { seen.push(n); return { ok: true, dropped: [] }; } });
  const planner = 'notice-planner';
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, 'box/np', 'box', '/tmp/np', 'np', 'idle', ?, 's-np', 'claude')`).run(planner, new Date().toISOString());
  io.connect(planner);
  const intake = { goal: 'Add expenses', context: 'c', workType: 'feature', done: 'd', involvement: 'balanced' };
  const c = await call('POST', '/api/goal-pilots', { intake, plannerAgentId: planner });
  const pilotId = c.json.pilot.id as string;
  const rid = () => getPilot(pilotId)!.currentRequestId;
  const events = () => seen.filter((n) => n.data?.pilotId === pilotId).map((n) => `${n.data?.event}:${n.data?.type}`);

  await call('POST', `/api/goal-pilots/requests/${rid()}/submit`, { result: { status: 'questions', questions: [{ id: 'a', text: 'A?' }, { id: 'b', text: 'B?' }] } });
  await call('POST', `/api/goal-pilots/${pilotId}/answers`, { answers: { a: { value: '1' }, b: { value: '2' } } });
  await call('POST', `/api/goal-pilots/requests/${rid()}/submit`, { result: { status: 'complete', brief: { summary: 's' }, criteria: [{ text: 'When x, the system shall y.', expect: 'x → y', verify: 'checklist' }] } });
  await call('POST', `/api/goal-pilots/requests/${rid()}/submit`, { result: { stages: [{ template: 'Feature Validation' }] } });
  await call('POST', `/api/goal-pilots/${pilotId}/accept-plan`, {});
  await call('POST', `/api/goal-pilots/${pilotId}/start`, { repos: [{ repoPath: '/tmp/np-nobody-here', agentType: 'codex' }] });
  sweepPilots();                                                       // still waiting: announced ONCE
  await call('POST', `/api/goal-pilots/${pilotId}/stages/${getPilotStages(pilotId)[0]}/skip`);   // → the checklist review, nobody to do it
  sweepPilots();                                                       // still waiting: announced ONCE
  await call('POST', `/api/goal-pilots/${pilotId}/stages/${getPilotStages(pilotId)[1]}/skip`);   // → completes
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events(), [
    'questions:goal_pilot_action', 'plan:goal_pilot_action', 'stage-needs-cartridge:goal_pilot_action',
    'review-needs-cartridge:goal_pilot_action', 'completed:goal_pilot_action',
  ]);
  const q = seen.find((n) => n.data?.event === 'questions')!;
  assert.match(q.title, /Add expenses — 2 questions to answer/);
  assert.equal(q.data?.goalId, getPilot(pilotId)!.goalId, 'the click-through needs the goal');
  // The bell hears it too.
  assert.ok(io.emissions.some((e) => e.event === 'workflow_notification' && String((e.payload as { title: string }).title).includes('2 questions to answer')));
  clearChannels();
});

test('a pipeline that STOPS is announced; a pause the person pressed is not', async () => {
  const { advancePilot } = await import('../src/lib/goal-pilot-runner.ts');
  const seen: Notice[] = [];
  clearChannels();
  registerChannel({ name: 'collector', isConfigured: () => true, async send(n) { seen.push(n); return { ok: true, dropped: [] }; } });
  const repo = '/tmp/np-stop';
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES ('notice-worker', 'box/stop', 'box', ?, 'stop', 'idle', ?, 's-stop', 'claude')`).run(repo, new Date().toISOString());
  io.connect('notice-worker');
  const staged = async () => {
    const c = await call('POST', '/api/goal-pilots', { intake: { goal: 'G', context: 'c', workType: 'feature', done: 'd', involvement: 'balanced' }, plannerAgentId: 'notice-worker' });
    const id = c.json.pilot.id as string;
    const rid = () => getPilot(id)!.currentRequestId;
    await call('POST', `/api/goal-pilots/requests/${rid()}/submit`, { result: { status: 'complete', brief: { summary: 's' }, criteria: [{ text: 'When x, the system shall y.', expect: 'x → y', verify: 'checklist' }] } });
    await call('POST', `/api/goal-pilots/requests/${rid()}/submit`, { result: { stages: [{ template: 'Feature Validation' }, { template: 'Release Documentation' }] } });
    await call('POST', `/api/goal-pilots/${id}/accept-plan`, {});
    await call('POST', `/api/goal-pilots/${id}/start`, { repos: [{ repoPath: repo, agentType: 'claude' }] });
    return id;
  };
  const failing = await staged();
  const runId = (db.prepare('SELECT run_id FROM goal_pilot_stages WHERE pilot_id = ? ORDER BY position').get(failing) as { run_id: string }).run_id;
  db.prepare(`UPDATE workflows SET status = 'failed' WHERE id = ?`).run(runId);
  advancePilot(failing);
  const stop = seen.find((n) => n.data?.pilotId === failing && n.data?.event === 'paused');
  assert.ok(stop, 'a failed stage stopped the pipeline without telling anyone');
  assert.equal(stop!.data?.type, 'goal_pilot_action');
  assert.match(stop!.body, /failed/);

  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = 'notice-worker'`).run();
  const paused = await staged();
  await call('POST', `/api/goal-pilots/${paused}/pause`);
  assert.equal(getPilot(paused)!.phase, 'paused');
  assert.ok(!seen.some((n) => n.data?.pilotId === paused && n.data?.event === 'paused'), 'the person pressed Pause — telling them is noise');
  clearChannels();
});

function getPilotStages(pilotId: string): string[] {
  return (db.prepare('SELECT id FROM goal_pilot_stages WHERE pilot_id = ? ORDER BY position').all(pilotId) as { id: string }[]).map((r) => r.id);
}

test('the test button reports the channels that will really send, by name', async () => {
  clearChannels();
  registerChannel({ name: 'configured', isConfigured: () => true, async send() { return { ok: true, dropped: [] }; } });
  registerChannel({ name: 'not-configured', isConfigured: () => false, async send() { return { ok: true, dropped: [] }; } });
  const r = await call('POST', '/api/push/test', {});
  assert.deepEqual(r.json.channels, ['configured']);
  clearChannels();
  registerChannel({ name: 'not-configured', isConfigured: () => false, async send() { return { ok: true, dropped: [] }; } });
  assert.match((await call('POST', '/api/push/test', {})).json.note, /No channel is configured/);
  clearChannels();
});
