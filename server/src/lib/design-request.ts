/**
 * THE DESIGNER IS CLAUDE'S /design, RUN IN THE PROJECT'S MAIN REPO.
 *
 * "Design four directions" is a request to the Claude cartridge that is open on the project's
 * primary repo. The request it is sent BEGINS with `/design`, so Claude Code's own design command
 * does the work there — it sees the repo, reads the inspiration pictures, and publishes a canvas of
 * four artboards. Then it tells NeonCore what it made (neoncore_submit_design): for each direction
 * a name, why it looks that way, and its tokens. Those four become the round the person compares,
 * comments on and selects from; the round keeps the link to the canvas.
 *
 * Nothing here designs. With no Claude cartridge on the main repo there is no round — the page is
 * told why, and what to do.
 *
 * Delivery follows the QA and Goal Pilot requests (qa/dispatch.ts): the prompt is stored on the
 * request; a busy cartridge is not typed into mid-turn (the request waits, `queued`, and the sweep
 * sends it when the cartridge is free); a request whose cartridge ended its turn without
 * submitting, or that ran past its time, fails with the reason.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../db.js';
import { sendCommandToAgent, noChannel } from './send-command.js';
import { isCartridgeBusy } from './queue-runner.js';
import { PLANNER_SILENT_MS, TURN_END_ENGINES } from './goal-pilot-runner.js';
import { getServerBaseUrl, AUTH_CURL_HEADER } from './server-url.js';
import { getDesignSystem, appendRound, DesignSystemError, LIMITS } from './design-system.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS design_requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    queued INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    based_on TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_design_requests_project ON design_requests(project_id, created_at);
`);

/** How long a design may take before it is given up on. */
export const DESIGN_BUDGET_MS = 30 * 60_000;
export const DENSITIES = ['compact', 'cozy', 'roomy'] as const;
export const SURFACES = ['flat', 'soft', 'outline', 'glass'] as const;
export const COLOR_KEYS = ['bg', 'surface', 'text', 'muted', 'primary', 'onPrimary', 'accent', 'border'] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;
const nowIso = () => new Date().toISOString();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

export interface DesignRequest {
  id: string; projectId: string; agentId: string; status: 'pending' | 'ready' | 'failed'; queued: boolean;
  note: string; basedOn: { roundId: string; variationId: string } | null; prompt: string; error: string;
  createdAt: string; dispatchedAt: string | null; completedAt: string | null;
}
/** What the page is told about a request: enough to say who is designing and how it is going. */
export interface DesignRequestState {
  id: string; status: DesignRequest['status']; queued: boolean; error: string; agentName: string; createdAt: string; dispatchedAt: string | null;
}
/** Who would design for this project right now — or why nobody can. */
export interface Designer { ok: boolean; agentId: string; agentName: string; repoPath: string; error: string }

function toRequest(r: Record<string, unknown>): DesignRequest {
  let basedOn: DesignRequest['basedOn'] = null;
  try { basedOn = r.based_on ? JSON.parse(String(r.based_on)) : null; } catch { basedOn = null; }
  return {
    id: String(r.id), projectId: String(r.project_id), agentId: String(r.agent_id ?? ''), status: String(r.status) as DesignRequest['status'],
    queued: Number(r.queued) === 1, note: String(r.note ?? ''), basedOn, prompt: String(r.prompt ?? ''), error: String(r.error ?? ''),
    createdAt: String(r.created_at), dispatchedAt: (r.dispatched_at as string | null) ?? null, completedAt: (r.completed_at as string | null) ?? null,
  };
}
export function getDesignRequest(id: string): DesignRequest | null {
  const r = db.prepare('SELECT * FROM design_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toRequest(r) : null;
}
const agentName = (id: string) => (db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name?: string } | undefined)?.name ?? '';

/** The project's latest request, as the page is told it (null when it never asked). */
export function designRequestState(projectId: string): DesignRequestState | null {
  const r = db.prepare('SELECT * FROM design_requests WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId) as Record<string, unknown> | undefined;
  if (!r) return null;
  const q = toRequest(r);
  return { id: q.id, status: q.status, queued: q.queued, error: q.error, agentName: agentName(q.agentId), createdAt: q.createdAt, dispatchedAt: q.dispatchedAt };
}

/**
 * The Claude cartridge on the project's MAIN repo. /design is a Claude Code command, so a Codex
 * cartridge there cannot do it; one that is online is preferred, then the one seen last.
 */
export function designerFor(projectId: string): Designer {
  const none = (error: string, repoPath = ''): Designer => ({ ok: false, agentId: '', agentName: '', repoPath, error });
  const project = db.prepare('SELECT primary_repo FROM projects WHERE id = ?').get(projectId) as { primary_repo?: string } | undefined;
  if (!project) return none('Project not found');
  const repo = (project.primary_repo ?? '').trim();
  if (!repo) return none('This project has no main repo yet. Give it one, and Claude designs there.');
  const rows = (db.prepare(`SELECT id, name, status, agent_type, repo_path, last_seen FROM agents WHERE repo_path != ''`).all() as
    { id: string; name: string; status: string; agent_type?: string; repo_path: string; last_seen: string }[])
    .filter((a) => samePath(a.repo_path, repo) && (a.agent_type || 'claude') === 'claude');
  if (rows.length === 0) return none(`No Claude cartridge is open on ${repo}. Open one there — /design runs in the project's main repo — then ask again.`, repo);
  const online = rows.filter((a) => a.status !== 'offline').sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  if (online.length === 0) return none(`The Claude cartridge on ${repo} is offline. Start it, then ask again.`, repo);
  return { ok: true, agentId: online[0].id, agentName: online[0].name, repoPath: repo, error: '' };
}

/** Where the inspiration pictures are written so the cartridge can read them. Not in the repo. */
export const designDir = (projectId: string) => path.join(process.env.NEONCORE_DESIGN_DIR || path.join(os.homedir(), '.neoncore', 'design'), projectId.replace(/[^\w.-]/g, '_'));

/** Write the pictures as files; answers their paths, in order. */
export function writeInspirations(projectId: string, inspirations: unknown[]): string[] {
  const dir = designDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  inspirations.forEach((pic, i) => {
    const m = isObject(pic) && typeof pic.dataUrl === 'string' ? /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(pic.dataUrl) : null;
    if (!m) return;
    const file = path.join(dir, `inspiration-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    paths.push(file);
  });
  return paths;
}

interface RoundLike { id: string; variations: { id: string; name: string; rationale?: string; tokens: unknown; comments: { text: string }[] }[] }
const TOKENS_SHAPE = `{ "dark": true|false, "colors": { "bg", "surface", "text", "muted", "primary", "onPrimary", "accent", "border" — each "#rrggbb" }, "fontHeading": "<font family>", "fontBody": "<font family>", "radius": <corner radius in px, 0–28>, "density": "compact"|"cozy"|"roomy", "surface": "flat"|"soft"|"outline"|"glass" }`;

/** The request as the cartridge reads it. It begins with /design: that is the command that does the work. */
export function designPrompt(input: {
  requestId: string; projectName: string; pictures: string[]; note: string; comments: { on: string; text: string }[];
  base: { name: string; rationale: string; tokens: unknown } | null; earlier: string[];
}): string {
  const said = [input.note.trim() && `- Their note: ${input.note.trim()}`, ...input.comments.map((c) => `- On "${c.on}": ${c.text}`)].filter(Boolean);
  return `/design Four design-system directions for ${input.projectName} — [NeonCore design request ${input.requestId}]

Design FOUR clearly different visual directions for ${input.projectName}'s design system, as four artboards on ONE canvas — one artboard per direction. Every artboard shows the same things in its own direction, so they can be compared side by side: navigation, a primary and a secondary button, a text field, a card, a table, badges, a heading and body text. The four must differ in more than colour: type pairing, corner radius, density and how surfaces are treated.

Work from:
- The inspiration pictures the person loaded — read every one:
${input.pictures.map((p) => `  ${p}`).join('\n')}
- This repo: what ${input.projectName} is, and the interface it already has.${input.base ? `
- MORE LIKE THIS: all four are takes on "${input.base.name}" (${input.base.rationale}). Its tokens: ${JSON.stringify(input.base.tokens)}` : ''}${said.length ? `
- What the person said about the last round — act on all of it:
${said.join('\n')}` : ''}${input.earlier.length ? `
- Already shown, do not repeat: ${input.earlier.join(', ')}.` : ''}

When the canvas is published, tell NeonCore what you made — the person compares, comments and selects there.
SUBMIT with the neoncore_submit_design tool: { "requestId": "${input.requestId}", "result": { "canvasUrl": "<the link /design printed>", "variations": [ exactly 4 × { "name": "<two or three words>", "rationale": "<one or two sentences: why it looks this way>", "tokens": ${TOKENS_SHAPE} } ] } }
(No MCP? curl -s -X POST ${getServerBaseUrl()}/api/design-system/requests/${input.requestId}/submit ${AUTH_CURL_HEADER} -H 'Content-Type: application/json' -d '{"result": …}')
The tokens are the values each artboard is actually drawn with, in the artboards' order. If the submission is rejected, the reply says why — fix it and submit again.
This is design only: change, commit and push nothing in this repo.`;
}

/** Sends a prompt to a cartridge. Injectable for tests; an error string when it could not. */
export type DesignSender = (agentId: string, prompt: string) => { ok: true } | { ok: false; error: string };
export const sendToCartridge: DesignSender = (agentId, prompt) => {
  const cmd = sendCommandToAgent(agentId, prompt, false, undefined, { standard: false });
  if (!cmd) return { ok: false, error: 'the cartridge no longer exists' };
  if (noChannel(cmd)) return { ok: false, error: 'the cartridge did not receive the request — is it connected?' };
  return { ok: true };
};
let sender: DesignSender = sendToCartridge;
export function setDesignSender(s: DesignSender | null): void { sender = s ?? sendToCartridge; }

function fail(id: string, error: string): void {
  db.prepare(`UPDATE design_requests SET status = 'failed', error = ?, queued = 0, completed_at = ? WHERE id = ? AND status = 'pending'`).run(error, nowIso(), id);
}
function deliver(id: string): void {
  const req = getDesignRequest(id);
  if (!req || req.status !== 'pending') return;
  const sent = sender(req.agentId, req.prompt);
  if (!sent.ok) { fail(id, sent.error); return; }
  db.prepare('UPDATE design_requests SET dispatched_at = ?, queued = 0 WHERE id = ?').run(nowIso(), id);
}

/**
 * Ask Claude for a round of four. Refused — with the reason — when there is no picture, no Claude
 * cartridge on the main repo, or a round already being designed.
 */
export function requestDesign(projectId: string, input: { note?: unknown; basedOn?: unknown } = {}): DesignRequestState {
  const exploration = getDesignSystem(projectId);
  if (!exploration) throw new DesignSystemError('Project not found', 404);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string };
  if (exploration.inspirations.length === 0) throw new DesignSystemError('Add at least one inspiration picture first');
  if (exploration.rounds.length >= LIMITS.rounds) throw new DesignSystemError(`at most ${LIMITS.rounds} rounds`);
  const current = designRequestState(projectId);
  if (current?.status === 'pending') throw new DesignSystemError('A round is already being designed', 409);
  const designer = designerFor(projectId);
  if (!designer.ok) throw new DesignSystemError(designer.error, 409);

  const rounds = exploration.rounds as RoundLike[];
  const note = typeof input.note === 'string' ? input.note.slice(0, 4000) : '';
  let basedOn: DesignRequest['basedOn'] = null;
  let base: { name: string; rationale: string; tokens: unknown } | null = null;
  if (isObject(input.basedOn) && typeof input.basedOn.roundId === 'string' && typeof input.basedOn.variationId === 'string') {
    const v = rounds.find((r) => r.id === (input.basedOn as { roundId: string }).roundId)?.variations.find((x) => x.id === (input.basedOn as { variationId: string }).variationId);
    if (!v) throw new DesignSystemError('the direction to base the round on is not one of the variations');
    basedOn = { roundId: input.basedOn.roundId, variationId: input.basedOn.variationId };
    base = { name: v.name, rationale: v.rationale ?? '', tokens: v.tokens };
  }
  const latest = rounds[rounds.length - 1];
  const comments = latest ? latest.variations.flatMap((v) => v.comments.map((c) => ({ on: v.name, text: String(c.text ?? '') }))) : [];

  const id = randomUUID();
  const prompt = designPrompt({
    requestId: id, projectName: project.name, pictures: writeInspirations(projectId, exploration.inspirations), note, comments, base,
    earlier: rounds.flatMap((r) => r.variations.map((v) => v.name)),
  });
  db.prepare(`INSERT INTO design_requests (id, project_id, agent_id, note, based_on, prompt, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, projectId, designer.agentId, note, basedOn ? JSON.stringify(basedOn) : '', prompt, nowIso());
  if (isCartridgeBusy(designer.agentId)) db.prepare('UPDATE design_requests SET queued = 1 WHERE id = ?').run(id);
  else deliver(id);
  ensureSweep();
  return designRequestState(projectId)!;
}

/** Stop waiting for the round being designed (the cartridge is not interrupted; a late answer is refused). */
export function cancelDesign(projectId: string): DesignRequestState | null {
  const cur = designRequestState(projectId);
  if (cur?.status === 'pending') fail(cur.id, 'Cancelled');
  return designRequestState(projectId);
}

/** Check what the cartridge submitted, and say exactly what is wrong when it is not four directions. */
export function validateSubmission(result: unknown): { canvasUrl: string; variations: { name: string; rationale: string; tokens: Record<string, unknown> }[] } {
  if (!isObject(result)) throw new DesignSystemError('result is an object: { canvasUrl, variations }');
  const { canvasUrl, variations } = result;
  if (canvasUrl !== undefined && canvasUrl !== '' && (typeof canvasUrl !== 'string' || !/^https?:\/\/\S+$/.test(canvasUrl) || canvasUrl.length > 2000)) throw new DesignSystemError('canvasUrl is the http(s) link /design printed');
  if (!Array.isArray(variations) || variations.length !== LIMITS.variationsPerRound) throw new DesignSystemError(`variations is a list of exactly ${LIMITS.variationsPerRound} directions`);
  const names = new Set<string>();
  const out = variations.map((v, i) => {
    const at = `variation ${i + 1}`;
    if (!isObject(v)) throw new DesignSystemError(`${at} is an object: { name, rationale, tokens }`);
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    const rationale = typeof v.rationale === 'string' ? v.rationale.trim() : '';
    if (!name || name.length > 60) throw new DesignSystemError(`${at} needs a name (at most 60 characters)`);
    if (!rationale || rationale.length > 600) throw new DesignSystemError(`${at} needs a rationale (at most 600 characters)`);
    if (names.has(name.toLowerCase())) throw new DesignSystemError(`two directions are both named "${name}"`);
    names.add(name.toLowerCase());
    const t = v.tokens;
    if (!isObject(t)) throw new DesignSystemError(`${at} needs its tokens`);
    if (typeof t.dark !== 'boolean') throw new DesignSystemError(`${at}: tokens.dark is true or false`);
    if (!isObject(t.colors)) throw new DesignSystemError(`${at}: tokens.colors is an object`);
    const colors: Record<string, string> = {};
    for (const k of COLOR_KEYS) {
      const c = (t.colors as Record<string, unknown>)[k];
      if (typeof c !== 'string' || !HEX.test(c)) throw new DesignSystemError(`${at}: tokens.colors.${k} is "#rrggbb"`);
      colors[k] = c.toLowerCase();
    }
    for (const k of ['fontHeading', 'fontBody'] as const) {
      if (typeof t[k] !== 'string' || !(t[k] as string).trim() || (t[k] as string).length > 60) throw new DesignSystemError(`${at}: tokens.${k} is a font family name`);
    }
    if (typeof t.radius !== 'number' || !Number.isFinite(t.radius) || t.radius < 0 || t.radius > 28) throw new DesignSystemError(`${at}: tokens.radius is a number of px from 0 to 28`);
    if (!DENSITIES.includes(t.density as never)) throw new DesignSystemError(`${at}: tokens.density is one of ${DENSITIES.join(', ')}`);
    if (!SURFACES.includes(t.surface as never)) throw new DesignSystemError(`${at}: tokens.surface is one of ${SURFACES.join(', ')}`);
    return { name, rationale, tokens: { dark: t.dark, colors, fontHeading: (t.fontHeading as string).trim(), fontBody: (t.fontBody as string).trim(), radius: Math.round(t.radius), density: t.density, surface: t.surface } };
  });
  return { canvasUrl: typeof canvasUrl === 'string' ? canvasUrl : '', variations: out };
}

/** The cartridge's answer: four directions become the project's next round. */
export function submitDesign(requestId: string, result: unknown, now = nowIso()): { message: string } {
  const req = getDesignRequest(requestId);
  if (!req) throw new DesignSystemError('No such design request', 404);
  if (req.status === 'ready') throw new DesignSystemError('This design request was already answered', 409);
  if (req.status === 'failed') throw new DesignSystemError(`This design request is closed (${req.error || 'failed'}) — nothing was kept`, 409);
  const clean = validateSubmission(result);
  const comments = (getDesignSystem(req.projectId)?.rounds as RoundLike[] | undefined)?.slice(-1)[0]?.variations.flatMap((v) => v.comments.map((c) => String(c.text ?? ''))) ?? [];
  appendRound(req.projectId, {
    id: randomUUID(), at: now, brief: [req.note, ...comments].filter(Boolean).join(' · '), basedOn: req.basedOn, canvasUrl: clean.canvasUrl,
    by: agentName(req.agentId) || 'Claude',
    variations: clean.variations.map((v) => ({ id: randomUUID(), ...v, comments: [] })),
  }, now);
  db.prepare(`UPDATE design_requests SET status = 'ready', completed_at = ? WHERE id = ?`).run(now, requestId);
  return { message: 'The four directions are on the project\'s Design system page.' };
}

/** Has a delivered request's cartridge finished without submitting? The same rule as qaRequestWentSilent. */
export function designRequestWentSilent(req: DesignRequest, now = Date.now()): boolean {
  if (req.status !== 'pending' || !req.dispatchedAt) return false;
  if (now - Date.parse(req.dispatchedAt) < PLANNER_SILENT_MS) return false;
  const agent = db.prepare('SELECT status, agent_type, turn_ended_at FROM agents WHERE id = ?').get(req.agentId) as
    { status?: string; agent_type?: string; turn_ended_at?: string } | undefined;
  // background: its turn paused on its own running work — not silent (lib/background-tasks.ts).
  if (agent?.status === 'working' || agent?.status === 'waiting' || agent?.status === 'background') return false;
  if (agent && agent.status !== 'offline' && TURN_END_ENGINES.has(agent.agent_type || 'claude')) {
    const ended = Date.parse(agent.turn_ended_at || '');
    if (!(ended >= Date.parse(req.dispatchedAt))) return false;
  }
  const last = (db.prepare('SELECT MAX(timestamp) AS t FROM activity WHERE agent_id = ?').get(req.agentId) as { t?: string | null }).t;
  if (last && now - Date.parse(last) < PLANNER_SILENT_MS) return false;
  return true;
}

/** One pass: send queued requests whose cartridge is free; fail the silent and the overdue. */
export function sweepDesignRequests(now = Date.now()): void {
  const pending = (db.prepare(`SELECT * FROM design_requests WHERE status = 'pending'`).all() as Record<string, unknown>[]).map(toRequest);
  for (const req of pending) {
    const exists = !!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(req.agentId);
    if (!exists) { fail(req.id, 'The cartridge no longer exists'); continue; }
    if (req.queued) {
      if (now - Date.parse(req.createdAt) > DESIGN_BUDGET_MS) fail(req.id, 'The cartridge stayed busy — the request was never sent. Ask again when it is free.');
      else if (!isCartridgeBusy(req.agentId)) deliver(req.id);
      continue;
    }
    if (designRequestWentSilent(req, now)) { fail(req.id, 'Claude finished without submitting its directions. Look at the cartridge to see why, then ask again.'); continue; }
    if (req.dispatchedAt && now - Date.parse(req.dispatchedAt) > DESIGN_BUDGET_MS) fail(req.id, `No directions after ${DESIGN_BUDGET_MS / 60_000} minutes. Look at the cartridge, then ask again.`);
  }
}

let timer: NodeJS.Timeout | null = null;
/** The sweep runs while the server does (never under test, where a test calls it itself). */
export function ensureSweep(intervalMs = 10_000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => { try { sweepDesignRequests(); } catch (err) { console.error('[design] sweep failed:', err); } }, intervalMs);
  timer.unref?.();
}
