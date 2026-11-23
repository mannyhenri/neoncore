/**
 * THE DESIGNER IS CLAUDE'S /design IN THE PROJECT'S MAIN REPO. A round is a request sent to the
 * Claude cartridge open on that repo; what it submits — four directions and the canvas link —
 * becomes the round. Nothing designs when there is no such cartridge, and every way a request can
 * end is said.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'design-req-'));
process.env.NEONCORE_DESIGN_DIR = DIR;

const { default: db } = await import('../src/db.js');
const { saveDesignSystem, getDesignSystem, DesignSystemError } = await import('../src/lib/design-system.js');
const { finalizeProject } = await import('../src/lib/design-system-publish.js');
const R = await import('../src/lib/design-request.js');

let n = 0;
const sent: { agentId: string; prompt: string }[] = [];
let sendResult: { ok: true } | { ok: false; error: string } = { ok: true };
R.setDesignSender((agentId, prompt) => { sent.push({ agentId, prompt }); return sendResult; });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const picture = (id: string) => ({ id, name: `${id}.png`, dataUrl: `data:image/png;base64,${PNG}`, colors: ['#ff3b30', '#0a84ff'] });
function project(repo = `/code/atlas-${++n}`): { id: string; repo: string } {
  const id = `dr-${++n}`;
  db.prepare(`INSERT INTO projects (id, name, description, primary_repo, color, created_at, updated_at) VALUES (?,?,'',?,'#fff',?,?)`).run(id, 'Atlas', repo, '2026-01-01', '2026-01-01');
  return { id, repo };
}
function agent(repo: string, over: { type?: string; status?: string; seen?: string; name?: string } = {}): string {
  const id = `ag-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, status, last_seen, agent_type) VALUES (?,?,?,?,?,?,?)`)
    .run(id, over.name ?? `cart-${n}`, 'mac', repo, over.status ?? 'idle', over.seen ?? '2026-11-21T10:00:00Z', over.type ?? 'claude');
  return id;
}
const tokens = (over: Record<string, unknown> = {}) => ({
  dark: false, colors: { bg: '#fbfbfd', surface: '#ffffff', text: '#14161c', muted: '#5b6070', primary: '#d6412f', onPrimary: '#ffffff', accent: '#168f84', border: '#dcdfe6' },
  fontHeading: 'Didot', fontBody: 'Avenir Next', radius: 6, density: 'cozy', surface: 'flat', ...over,
});
const four = (prefix = 'Dir') => ['A', 'B', 'C', 'D'].map((x, i) => ({ name: `${prefix} ${x}`, rationale: `Why ${x}.`, tokens: tokens({ radius: i * 4 }) }));
const answer = (over: Record<string, unknown> = {}) => ({ canvasUrl: 'https://claude.ai/artifact/abc', variations: four(), ...over });
const ready = (pictures = 2) => {
  const p = project();
  const a = agent(p.repo, { name: 'atlas-main' });
  saveDesignSystem(p.id, { inspirations: Array.from({ length: pictures }, (_, i) => picture(`pic${i}`)), rounds: [], selected: null });
  return { ...p, agent: a };
};
const refused = (fn: () => unknown, status: number, message: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof DesignSystemError && e.status === status && message.test(e.message), `expected ${status} ${message}`);
const idOf = (prompt: string) => /\[NeonCore design request ([\w-]+)\]/.exec(prompt)![1];

test('the designer is the Claude cartridge on the main repo — and every reason there is none is said', () => {
  assert.match(R.designerFor('nope').error, /Project not found/);
  const none = project('');
  assert.match(R.designerFor(none.id).error, /no main repo/);
  const p = project();
  assert.match(R.designerFor(p.id).error, /No Claude cartridge is open on/);
  agent(p.repo, { type: 'codex' });
  agent('/code/somewhere-else');
  assert.equal(R.designerFor(p.id).ok, false, 'a Codex cartridge, or one on another repo, cannot run /design here');
  const off = agent(p.repo, { status: 'offline', seen: '2026-11-21T12:00:00Z' });
  assert.match(R.designerFor(p.id).error, /offline/);
  const older = agent(`${p.repo}/`, { seen: '2026-11-21T09:00:00Z' });
  const newer = agent(p.repo, { seen: '2026-11-21T11:00:00Z', name: 'the-one' });
  const d = R.designerFor(p.id);
  assert.deepEqual([d.ok, d.agentId, d.agentName, d.repoPath, d.error], [true, newer, 'the-one', p.repo, '']);
  assert.ok(off !== d.agentId && older !== d.agentId);
});

test('a request is refused, and nothing is sent, without a picture, without a designer, or while one is pending', () => {
  const before = sent.length;
  refused(() => R.requestDesign('nope'), 404, /Project not found/);
  const p = project();
  saveDesignSystem(p.id, { inspirations: [], rounds: [], selected: null });
  refused(() => R.requestDesign(p.id), 400, /inspiration picture/);
  saveDesignSystem(p.id, { inspirations: [picture('a')], rounds: [], selected: null });
  refused(() => R.requestDesign(p.id), 409, /No Claude cartridge/);
  assert.equal(R.designRequestState(p.id), null);
  agent(p.repo);
  assert.equal(R.requestDesign(p.id).status, 'pending');
  refused(() => R.requestDesign(p.id), 409, /already being designed/);
  assert.equal(sent.length, before + 1);
});

test('the request sent to the cartridge IS /design — with the pictures as files, what the person said, and how to answer', () => {
  const p = ready(3);
  const state = R.requestDesign(p.id, { note: 'Warmer, and rounder corners' });
  const { agentId, prompt } = sent[sent.length - 1];
  assert.equal(agentId, p.agent);
  assert.ok(prompt.startsWith('/design '), 'the prompt must begin with the /design command');
  assert.equal(idOf(prompt), state.id);
  assert.deepEqual([state.status, state.queued, state.agentName, state.error], ['pending', false, 'atlas-main', '']);
  assert.ok(state.dispatchedAt);
  // Every picture is a real file, outside the repo, holding the picture's bytes, and named in the prompt.
  const files = fs.readdirSync(R.designDir(p.id)).sort();
  assert.deepEqual(files, ['inspiration-1.png', 'inspiration-2.png', 'inspiration-3.png']);
  for (const f of files) {
    const full = path.join(R.designDir(p.id), f);
    assert.ok(prompt.includes(full), `${f} is not in the prompt`);
    assert.deepEqual(fs.readFileSync(full), Buffer.from(PNG, 'base64'));
    assert.equal(full.startsWith(p.repo), false);
  }
  for (const part of ['FOUR', 'Atlas', 'Warmer, and rounder corners', 'neoncore_submit_design', `/api/design-system/requests/${state.id}/submit`, 'canvasUrl', 'onPrimary', '"compact"|"cozy"|"roomy"', '"flat"|"soft"|"outline"|"glass"', 'change, commit and push nothing']) {
    assert.ok(prompt.includes(part), `the prompt does not say: ${part}`);
  }
  assert.equal(prompt.includes('MORE LIKE THIS'), false);
  assert.equal(prompt.includes('do not repeat'), false);
});

test('what Claude submits becomes the round: four directions, the canvas link, who made it — and a wrong answer is refused with its reason, nothing kept', () => {
  const p = ready();
  const id = R.requestDesign(p.id, { note: 'calm' }).id;
  const bad: [unknown, RegExp][] = [
    [null, /result is an object/],
    [{ variations: four().slice(0, 3) }, /exactly 4/],
    [answer({ canvasUrl: 'javascript:alert(1)' }), /canvasUrl/],
    [answer({ variations: four().map((v, i) => (i === 1 ? { ...v, name: '' } : v)) }), /variation 2 needs a name/],
    [answer({ variations: four().map((v, i) => (i === 2 ? { ...v, rationale: '' } : v)) }), /variation 3 needs a rationale/],
    [answer({ variations: four().map((v, i) => (i === 3 ? { ...v, name: 'dir a' } : v)) }), /both named/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: undefined } : v)) }), /variation 1 needs its tokens/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: tokens({ dark: 'no' }) } : v)) }), /tokens\.dark/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: tokens({ colors: { ...tokens().colors, accent: 'teal' } }) } : v)) }), /tokens\.colors\.accent/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: tokens({ colors: { bg: '#ffffff' } }) } : v)) }), /tokens\.colors\.surface/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: tokens({ fontBody: '' }) } : v)) }), /tokens\.fontBody/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: tokens({ radius: 90 }) } : v)) }), /tokens\.radius/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: tokens({ density: 'tight' }) } : v)) }), /tokens\.density/],
    [answer({ variations: four().map((v, i) => (i === 0 ? { ...v, tokens: tokens({ surface: 'neon' }) } : v)) }), /tokens\.surface/],
  ];
  for (const [result, why] of bad) refused(() => R.submitDesign(id, result), 400, why);
  assert.equal(getDesignSystem(p.id)!.rounds.length, 0);
  assert.equal(R.designRequestState(p.id)!.status, 'pending');
  refused(() => R.submitDesign('no-such-request', answer()), 404, /No such design request/);

  R.submitDesign(id, answer(), '2026-11-21T12:00:00Z');
  const rounds = getDesignSystem(p.id)!.rounds as { id: string; at: string; brief: string; basedOn: unknown; canvasUrl: string; by: string; variations: { id: string; name: string; rationale: string; tokens: unknown; comments: unknown[] }[] }[];
  assert.equal(rounds.length, 1);
  const r = rounds[0];
  assert.deepEqual([r.at, r.brief, r.basedOn, r.canvasUrl, r.by], ['2026-11-21T12:00:00Z', 'calm', null, 'https://claude.ai/artifact/abc', 'atlas-main']);
  assert.deepEqual(r.variations.map((v) => [v.name, v.rationale, v.comments]), four().map((v) => [v.name, v.rationale, []]));
  assert.deepEqual(r.variations.map((v) => v.tokens), four().map((v) => v.tokens));
  assert.equal(new Set(r.variations.map((v) => v.id)).size, 4);
  assert.equal(R.designRequestState(p.id)!.status, 'ready');
  refused(() => R.submitDesign(id, answer()), 409, /already answered/);
  assert.equal(getDesignSystem(p.id)!.rounds.length, 1);
  // The pictures are still there, and a direction Claude made can be selected and finalized (step 2).
  assert.equal(getDesignSystem(p.id)!.inspirations.length, 2);
  const cur = getDesignSystem(p.id)!;
  saveDesignSystem(p.id, { inspirations: cur.inspirations, rounds: cur.rounds, selected: { roundId: r.id, variationId: r.variations[2].id } });
  const system = finalizeProject(p.id).system!;
  assert.deepEqual([system.version, system.name], [1, 'Dir C']);
});

test('the next round carries the comments, "more like this" and what was already shown — and a page that has not seen a round cannot drop it', () => {
  const p = ready();
  R.submitDesign(R.requestDesign(p.id).id, answer());
  const stale = getDesignSystem(p.id)!;
  const r1 = (stale.rounds as { id: string; variations: { id: string; comments: unknown[] }[] }[])[0];
  // The person comments on two directions, and asks for more like the second.
  r1.variations[0].comments.push({ id: 'c1', text: 'too cold', at: 'x' });
  r1.variations[1].comments.push({ id: 'c2', text: 'love the type', at: 'x' });
  saveDesignSystem(p.id, { inspirations: stale.inspirations, rounds: stale.rounds, selected: null });
  refused(() => R.requestDesign(p.id, { basedOn: { roundId: r1.id, variationId: 'nope' } }), 400, /not one of the variations/);
  const id = R.requestDesign(p.id, { note: 'bolder', basedOn: { roundId: r1.id, variationId: r1.variations[1].id } }).id;
  const prompt = sent[sent.length - 1].prompt;
  for (const part of ['Their note: bolder', 'On "Dir A": too cold', 'On "Dir B": love the type', 'MORE LIKE THIS: all four are takes on "Dir B"', '"primary":"#d6412f"', 'do not repeat: Dir A, Dir B, Dir C, Dir D']) {
    assert.ok(prompt.includes(part), `the prompt does not say: ${part}`);
  }
  R.submitDesign(id, answer({ variations: four('Take') }));
  // The page still holds only round 1 (it has not polled) and saves a comment: round 2 stays.
  saveDesignSystem(p.id, { inspirations: stale.inspirations, rounds: [stale.rounds[0]], selected: null });
  const rounds = getDesignSystem(p.id)!.rounds as { basedOn: unknown; brief: string; variations: { name: string }[] }[];
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[1].variations.map((v) => v.name), ['Take A', 'Take B', 'Take C', 'Take D']);
  assert.deepEqual(rounds[1].basedOn, { roundId: r1.id, variationId: r1.variations[1].id });
  assert.equal(rounds[1].brief, 'bolder · too cold · love the type');
});

test('every way a request ends without a round is said: busy then sent, not delivered, silent, overdue, cancelled, cartridge gone', () => {
  const T0 = Date.now();
  // Busy: it waits, nothing is typed mid-turn; when the cartridge is free the sweep sends it.
  const busy = ready();
  db.prepare(`UPDATE agents SET status = 'working' WHERE id = ?`).run(busy.agent);
  let before = sent.length;
  const q = R.requestDesign(busy.id);
  assert.deepEqual([q.status, q.queued, q.dispatchedAt], ['pending', true, null]);
  R.sweepDesignRequests(T0);
  assert.equal(sent.length, before);
  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(busy.agent);
  R.sweepDesignRequests(T0);
  assert.equal(sent.length, before + 1);
  assert.deepEqual([R.designRequestState(busy.id)!.queued, !!R.designRequestState(busy.id)!.dispatchedAt], [false, true]);

  // Not delivered: the reason is the request's error.
  const undelivered = ready();
  sendResult = { ok: false, error: 'the cartridge did not receive the request — is it connected?' };
  const u = R.requestDesign(undelivered.id);
  sendResult = { ok: true };
  assert.deepEqual([u.status, u.error], ['failed', 'the cartridge did not receive the request — is it connected?']);
  // …and after a failure, asking again is allowed.
  assert.equal(R.requestDesign(undelivered.id).status, 'pending');

  // Silent: its turn ended after the request arrived, and nothing since.
  const silent = ready();
  const s = R.requestDesign(silent.id);
  const sentAt = Date.parse(R.getDesignRequest(s.id)!.dispatchedAt!);
  R.sweepDesignRequests(sentAt + 60_000);
  assert.equal(R.designRequestState(silent.id)!.status, 'pending', 'a minute of quiet is not silence');
  db.prepare(`UPDATE agents SET turn_ended_at = ? WHERE id = ?`).run(new Date(sentAt + 5_000).toISOString(), silent.agent);
  R.sweepDesignRequests(sentAt + 4 * 60_000);
  assert.deepEqual([R.designRequestState(silent.id)!.status, /finished without submitting/.test(R.designRequestState(silent.id)!.error)], ['failed', true]);
  refused(() => R.submitDesign(s.id, answer()), 409, /closed/);
  assert.equal(getDesignSystem(silent.id)!.rounds.length, 0);

  // Overdue: still working after the budget.
  const slow = ready();
  const o = R.requestDesign(slow.id);
  db.prepare(`UPDATE agents SET status = 'working' WHERE id = ?`).run(slow.agent);
  const oSent = Date.parse(R.getDesignRequest(o.id)!.dispatchedAt!);
  R.sweepDesignRequests(oSent + R.DESIGN_BUDGET_MS - 1000);
  assert.equal(R.designRequestState(slow.id)!.status, 'pending');
  R.sweepDesignRequests(oSent + R.DESIGN_BUDGET_MS + 1000);
  assert.match(R.designRequestState(slow.id)!.error, /No directions after 30 minutes/);

  // Cancelled by the person: closed, and a late answer is refused.
  const stop = ready();
  const c = R.requestDesign(stop.id);
  assert.deepEqual([R.cancelDesign(stop.id)!.status, R.cancelDesign(stop.id)!.error], ['failed', 'Cancelled']);
  refused(() => R.submitDesign(c.id, answer()), 409, /closed \(Cancelled\)/);
  assert.equal(R.cancelDesign(project().id), null);

  // The cartridge is gone.
  const gone = ready();
  R.requestDesign(gone.id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(gone.agent);
  R.sweepDesignRequests(T0);
  assert.match(R.designRequestState(gone.id)!.error, /no longer exists/);
});

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp folder */ } });
