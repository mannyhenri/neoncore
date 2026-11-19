/**
 * GENERATE WITH AI — taking stock of a codebase: its architecture, the features it already has
 * (written up as a spec), its changelog, and the backlog the code points at.
 *
 * A project started in NeonCore grows its documents feature by feature. A repo used with NeonCore for
 * the first time has none of them — or has some (a README, a docs/ folder, a CHANGELOG.md) that nobody
 * connected to a feature list. One request to a cartridge in the project's repos takes stock, for any
 * of four PARTS the person asks for:
 *
 *   architecture  markdown: components, how data flows, the stack, where the tests are
 *   features      what the product already does — each with where it lives AND a spec of its current
 *                 behaviour: a summary and acceptance criteria ("When …, the system shall …")
 *   changelog     the history of what shipped, from git (commits, tags, merges) and any existing
 *                 CHANGELOG / release notes — grouped by release, in Keep-a-Changelog kinds
 *   backlog       work the code itself points at (TODO/FIXME, half-built paths, documented-but-missing)
 *
 * The cartridge reads existing documents first and the code second, and writes what is missing.
 *
 * Same contract as every other piece of generated text in NeonCore (goal drafts, the feature
 * pipeline): the submission is a PROPOSAL, validated and stored, and only POST /apply — a person ticking
 * what to keep — changes anything. Kept features join the list as EXISTING (done, origin 'imported',
 * their criteria recorded as documented behaviour); kept backlog items join it as planned features;
 * kept changelog entries join the changelog (with their release, when they had one); the architecture is
 * written onto the project, where the planner reads it when it scopes each feature. Publishing the
 * project's docs (lib/project-docs.ts) then writes all of it into the repo as Markdown.
 *
 * Dispatch, not generation: NeonCore has no LLM client. The request goes to the cartridge like any
 * prompt (through the busy guard, so it queues behind running work), and the cartridge answers with
 * the MCP tool `neoncore_submit_project_import` or the curl fallback.
 */
import { randomUUID } from 'crypto';
import db from '../db.js';
import { AUTH_CURL_HEADER, getServerBaseUrl } from './server-url.js';
import { getProjectCartridges } from './resolve-agent.js';
import { createFeature } from '../routes/goals.js';
import { addEntry, normalizeKind, type ChangeKind } from './project-changelog.js';

export const IMPORT_TOOL = 'neoncore_submit_project_import';
export const MAX_IMPORT_FEATURES = 80;
export const MAX_IMPORT_BACKLOG = 40;
export const MAX_IMPORT_CHANGELOG = 120;
export const MAX_CRITERIA_PER_FEATURE = 8;
export const MAX_ARCHITECTURE_CHARS = 20_000;
/** The architecture page (an artifact rendered in the Architecture tab) — inline SVG adds up, so it gets room. */
export const MAX_ARCHITECTURE_HTML_CHARS = 400_000;
/**
 * How many top-level capability groups a feature list keeps. An executive reads the spec group by
 * group: a dozen is a page they can take in, thirty is the flat list again.
 */
export const MAX_FEATURE_GROUPS = 10;
export const OTHER_GROUP = 'Other';
const AREA_SEP = ' · ';

/** The top-level group of an area: "Gateway · Routing & engines" → "Gateway". */
export function groupOf(area: string): string {
  return (area || '').split(AREA_SEP)[0].trim();
}
/** The sub-area within the group: "Gateway · Routing & engines" → "Routing & engines" ('' when there is none). */
export function sectionOf(area: string): string {
  return (area || '').split(AREA_SEP).slice(1).join(AREA_SEP).trim();
}

export const IMPORT_PARTS = ['architecture', 'features', 'changelog', 'backlog'] as const;
export type ImportPart = (typeof IMPORT_PARTS)[number];

export interface ImportCriterion { text: string; expect: string }
export interface ImportFeature {
  name: string;
  description: string;
  area: string;
  evidence: string;
  /** The feature's current behaviour, as acceptance criteria — documented, not yet verified. */
  criteria: ImportCriterion[];
}
export interface ImportBacklogItem { name: string; description: string; source: string; area: string }
/** One top-level capability group and what it does, in a line an executive reads. */
export interface FeatureArea { name: string; summary: string }
export interface ImportChangelogEntry { id: string; kind: ChangeKind; title: string; body: string; release: string; date: string }
export interface ImportProposal {
  message: string;
  /** Plain-text notes — what the planner reads when it scopes each feature. */
  architecture: string;
  /** The architecture as a page: self-contained HTML with diagrams, shown in the Architecture tab. */
  architectureHtml: string;
  features: ImportFeature[];
  /** The top-level groups the features (and backlog) are filed under, each with its summary. */
  areas: FeatureArea[];
  backlog: ImportBacklogItem[];
  changelog: ImportChangelogEntry[];
}

export interface ProjectImport {
  id: string;
  projectId: string;
  agentId: string;
  parts: ImportPart[];
  status: 'pending' | 'ready' | 'failed' | 'applied' | 'superseded';
  proposal: ImportProposal | null;
  notes: string[];
  error: string;
  applied: { architecture: boolean; features: string[]; backlog: string[]; changelog: number } | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export class ImportError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

const now = () => new Date().toISOString();
const parse = <T>(s: unknown, fallback: T): T => { try { return s ? JSON.parse(s as string) as T : fallback; } catch { return fallback; } };
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The parts asked for, in registry order; nothing valid named means all of them. */
export function normalizeParts(v: unknown): ImportPart[] {
  const asked = new Set((Array.isArray(v) ? v : []).map(String));
  const parts = IMPORT_PARTS.filter((p) => asked.has(p));
  return parts.length ? parts : [...IMPORT_PARTS];
}

function row(r: Record<string, unknown>): ProjectImport {
  const proposal = parse<Partial<ImportProposal> | null>(r.proposal, null);
  return {
    id: r.id as string, projectId: r.project_id as string, agentId: (r.agent_id as string) || '',
    parts: normalizeParts(parse<string[]>(r.parts, [])),
    status: r.status as ProjectImport['status'],
    proposal: proposal ? {
      message: proposal.message ?? '', architecture: proposal.architecture ?? '', architectureHtml: proposal.architectureHtml ?? '',
      features: (proposal.features ?? []).map((f) => ({ ...f, criteria: f.criteria ?? [] })),
      areas: proposal.areas ?? [],
      backlog: (proposal.backlog ?? []).map((b) => ({ ...b, area: b.area ?? '' })), changelog: proposal.changelog ?? [],
    } : null,
    notes: parse<string[]>(r.notes, []), error: (r.error as string) || '',
    applied: parse<ProjectImport['applied']>(r.applied, null),
    createdAt: r.created_at as string, dispatchedAt: (r.dispatched_at as string) ?? null, completedAt: (r.completed_at as string) ?? null,
  };
}

export function getImport(id: string): ProjectImport | null {
  const r = db.prepare('SELECT * FROM project_imports WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? row(r) : null;
}

export function importsFor(projectId: string): ProjectImport[] {
  return (db.prepare('SELECT * FROM project_imports WHERE project_id = ? ORDER BY created_at DESC LIMIT 10').all(projectId) as Record<string, unknown>[]).map(row);
}

export function createImportRow(projectId: string, agentId: string, parts: ImportPart[]): ProjectImport {
  const id = randomUUID();
  const tx = db.transaction(() => {
    // A new request supersedes one still outstanding, so a late answer cannot land on the new one.
    db.prepare(`UPDATE project_imports SET status = 'superseded', completed_at = ? WHERE project_id = ? AND status = 'pending'`).run(now(), projectId);
    db.prepare(`INSERT INTO project_imports (id, project_id, agent_id, parts, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(id, projectId, agentId, JSON.stringify(parts), now());
  });
  tx();
  return getImport(id)!;
}

export function setImportPrompt(id: string, prompt: string, dispatched: boolean): void {
  db.prepare('UPDATE project_imports SET prompt = ?, dispatched_at = ? WHERE id = ?').run(prompt, dispatched ? now() : null, id);
}

export function failImport(id: string, error: string): void {
  db.prepare(`UPDATE project_imports SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'pending'`).run(error, now(), id);
}

export function importPrompt(id: string): string {
  return ((db.prepare('SELECT prompt FROM project_imports WHERE id = ?').get(id) as { prompt?: string } | undefined)?.prompt) || '';
}

// ── the request ───────────────────────────────────────────────────────────────

export function requestHeader(id: string): string {
  return `[NeonCore project import request ${id}]`;
}

const PART_INSTRUCTIONS: Record<ImportPart, string[]> = {
  architecture: [
    '- architectureHtml — the architecture as ONE self-contained HTML page a new engineer or an executive could start from,',
    '  shown as-is in the project\'s Architecture tab: a diagram of the components and how a request or the data flows',
    '  between them (inline <svg>, boxes and labelled arrows), then the components and what each is for, the stack and key',
    '  dependencies, where the tests are and how they run, and anything surprising. Name real paths. Inline <style> only:',
    '  NO <script>, no external fonts, images or stylesheets (they are stripped / blocked). Readable on a dark background',
    `  and a light one; at most ${MAX_ARCHITECTURE_HTML_CHARS / 1000}k characters. If docs already describe it, start from them and correct what the code contradicts.`,
    '- architecture — the same, as short plain-text notes (under 3,000 characters): what the planner reads when it scopes',
    '  each feature. Components with their paths, the data flow, the tests.',
  ],
  features: [
    '- features — what the product ALREADY DOES, named as a user or operator would ("Export invoices as CSV", not "csv.ts").',
    '  An executive reads this list group by group, so file each feature under an `area` of the form',
    `  "<group> · <sub-area>": at most ${MAX_FEATURE_GROUPS} groups, named as the business knows them (a product, or a capability`,
    '  such as "Billing & payments") — never code folders — with a few sub-areas each. Then list the groups in `areas`, each',
    '  with a `summary`: one plain-language sentence on what it gives the customer or the business. No jargon in either.',
    `  One feature per capability; \`evidence\` = the files or routes where it lives; at most ${MAX_IMPORT_FEATURES}, the`,
    '  important ones first. For EACH, write its spec as it behaves TODAY: `description` (what it does and for whom, one or two',
    `  sentences) and \`criteria\` — up to ${MAX_CRITERIA_PER_FEATURE} observable behaviours, each {"text": "When <situation>, the system shall <result>.",`,
    '  "expect": "<inputs → exact result, with real values>"}. Describe what the code does, not what it should do; where it is',
    '  ambiguous, say so in the text.',
  ],
  changelog: [
    '- changelog — the history of what shipped, from `git log` (with dates), `git tag`, merge commits and any existing',
    '  CHANGELOG / release notes. Group entries by release (a tag or version; "" for unreleased work after the last one).',
    '  Each entry: {"kind": "added|changed|fixed|removed|security", "title": "<user-facing change>", "body": "<optional detail>",',
    `  "release": "<version or ''>", "date": "YYYY-MM-DD"}. Merge trivial commits; skip chores nobody outside the team would`,
    `  notice. If an existing CHANGELOG covers a release, use it as written. At most ${MAX_IMPORT_CHANGELOG}, newest first.`,
  ],
  backlog: [
    '- backlog — work the codebase itself points at: TODO/FIXME comments, half-built paths, documented but missing',
    `  behaviour, open items in docs. \`source\`: where you saw it. \`area\`: the group it belongs to, as for features. At most ${MAX_IMPORT_BACKLOG}.`,
  ],
};

const RESULT_SHAPE: Record<ImportPart, string> = {
  architecture: '"architectureHtml": "<the page>", "architecture": "<plain-text notes>"',
  features: '"features": [ { "name", "description", "area", "evidence", "criteria": [ { "text", "expect" } ] } ], "areas": [ { "name", "summary" } ]',
  changelog: '"changelog": [ { "kind", "title", "body", "release", "date" } ]',
  backlog: '"backlog": [ { "name", "description", "source", "area" } ]',
};

export function buildImportPrompt(imp: ProjectImport): string {
  const p = db.prepare('SELECT name, description, primary_repo FROM projects WHERE id = ?').get(imp.projectId) as
    { name: string; description: string; primary_repo: string };
  const repos = [...new Set([p.primary_repo, ...getProjectCartridges(imp.projectId)].filter(Boolean))];
  const listed = (db.prepare('SELECT name FROM goals WHERE project_id = ? ORDER BY position').all(imp.projectId) as { name: string }[]).map((g) => g.name);
  const logged = (db.prepare('SELECT title FROM project_changelog WHERE project_id = ?').all(imp.projectId) as { title: string }[]).map((e) => e.title);
  const url = `"\${NEONCORE_URL:-${getServerBaseUrl()}}/api/project-imports/${imp.id}/submit"`;
  return [
    requestHeader(imp.id),
    'You are taking stock of a codebase for a NeonCore project. Read it; do not change anything — no edits, no',
    'commits, no new files. Your answer is a proposal a person reviews item by item before anything is kept.',
    '',
    `PROJECT: ${p.name}${p.description ? ` — ${p.description.replace(/\s+/g, ' ')}` : ''}`,
    `REPOS (read every one you can reach): ${repos.join(', ') || '(the repo you are in)'}`,
    ...(listed.length && imp.parts.some((x) => x === 'features' || x === 'backlog')
      ? ['ALREADY ON THE PROJECT\'S FEATURE LIST (do not propose these again):', ...listed.slice(0, 60).map((n) => `  · ${n}`)] : []),
    ...(logged.length && imp.parts.includes('changelog')
      ? ['ALREADY IN THE PROJECT\'S CHANGELOG (do not propose these again):', ...logged.slice(0, 60).map((n) => `  · ${n}`)] : []),
    '',
    'READ EXISTING DOCUMENTS FIRST: README*, docs/**, CHANGELOG*, RELEASES*, HISTORY*, ADRs, API specs (OpenAPI,',
    'GraphQL), package manifests. Where a document already says it, use it; where the code contradicts it, the code wins',
    'and you say so. Then read the code for what the documents do not cover.',
    '',
    `PRODUCE ONLY THESE PARTS (${imp.parts.join(', ')}):`,
    ...imp.parts.flatMap((x) => PART_INSTRUCTIONS[x]),
    '',
    `SUBMIT with the MCP tool \`${IMPORT_TOOL}\`, requestId "${imp.id}", result = { "message": "<one line>", ${imp.parts.map((x) => RESULT_SHAPE[x]).join(', ')} }`,
    `Fallback ONLY if that tool is unavailable: curl -s -X POST ${url} ${AUTH_CURL_HEADER} -H 'Content-Type: application/json' -d '{"result": <the result object>}'`,
    'If the submission is rejected, the reply says why — fix it and submit again.',
    '',
    'PILOT-DATA (the same information as above, machine-readable):',
    '```json',
    JSON.stringify({ requestId: imp.id, kind: 'import', parts: imp.parts, project: { id: imp.projectId, name: p.name, description: p.description, repos },
      listed, logged, maxGroups: MAX_FEATURE_GROUPS, maxFeatures: MAX_IMPORT_FEATURES, maxBacklog: MAX_IMPORT_BACKLOG, maxChangelog: MAX_IMPORT_CHANGELOG, maxCriteria: MAX_CRITERIA_PER_FEATURE }),
    '```',
  ].join('\n');
}

// ── the submission ─────────────────────────────────────────────────────────────

/**
 * Keep what is usable, say what was dropped. Only the parts that were asked for are kept — a part sent
 * anyway is dropped with a note, so a changelog request cannot quietly replace the architecture.
 */
export function normalizeImport(
  raw: unknown, ctx: { listed: string[]; logged?: string[]; parts?: ImportPart[] },
): { value: ImportProposal | null; notes: string[]; error: string } {
  const notes: string[] = [];
  const parts = new Set(ctx.parts ?? IMPORT_PARTS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: null, notes, error: 'the submission was not an object' };
  const r = raw as Record<string, unknown>;
  for (const part of IMPORT_PARTS) {
    const sent = part === 'architecture'
      ? [r.architecture, r.architectureHtml].some((v) => typeof v === 'string' && v.trim() !== '')
      : Array.isArray(r[part]) && (r[part] as unknown[]).length > 0;
    if (sent && !parts.has(part)) notes.push(`${part} was not asked for — dropped`);
  }

  let architecture = parts.has('architecture') && typeof r.architecture === 'string' ? r.architecture.trim() : '';
  if (architecture.length > MAX_ARCHITECTURE_CHARS) {
    notes.push(`the architecture was ${architecture.length} characters; kept the first ${MAX_ARCHITECTURE_CHARS}`);
    architecture = architecture.slice(0, MAX_ARCHITECTURE_CHARS);
  }
  let architectureHtml = parts.has('architecture') && typeof r.architectureHtml === 'string' ? stripActive(r.architectureHtml.trim(), notes) : '';
  if (architectureHtml.length > MAX_ARCHITECTURE_HTML_CHARS) {
    notes.push(`the architecture page was ${architectureHtml.length} characters — too long to keep; send a lighter page`);
    architectureHtml = '';
  }

  const taken = new Set(ctx.listed.map((n) => n.toLowerCase()));
  const take = <T extends { name: string }>(list: unknown, max: number, label: string, shape: (o: Record<string, unknown>) => T): T[] => {
    const out: T[] = [];
    const arr = Array.isArray(list) ? list : [];
    if (arr.length > max) notes.push(`${arr.length} ${label} proposed; kept the first ${max}`);
    for (const item of arr.slice(0, max)) {
      if (!item || typeof item !== 'object') continue;
      const v = shape(item as Record<string, unknown>);
      if (!v.name) continue;
      const key = v.name.toLowerCase();
      if (taken.has(key)) { notes.push(`"${v.name}" is already on the list — dropped`); continue; }
      taken.add(key);
      out.push(v);
    }
    return out;
  };
  const criteriaOf = (v: unknown): ImportCriterion[] => (Array.isArray(v) ? v : [])
    .map((c) => (c && typeof c === 'object' ? { text: str((c as Record<string, unknown>).text, 500), expect: str((c as Record<string, unknown>).expect, 500) }
      : typeof c === 'string' ? { text: str(c, 500), expect: '' } : { text: '', expect: '' }))
    .filter((c) => c.text).slice(0, MAX_CRITERIA_PER_FEATURE);
  const features = parts.has('features') ? take(r.features, MAX_IMPORT_FEATURES, 'features', (o) => ({
    name: str(o.name, 200), description: str(o.description, 1000), area: str(o.area, 80), evidence: str(o.evidence, 500),
    criteria: criteriaOf(o.criteria),
  })) : [];
  const backlog = parts.has('backlog') ? take(r.backlog, MAX_IMPORT_BACKLOG, 'backlog items', (o) => ({
    name: str(o.name, 200), description: str(o.description, 1000), source: str(o.source, 300), area: str(o.area, 80),
  })) : [];
  const areas = foldGroups(features, backlog, r.areas, notes);

  const changelog: ImportChangelogEntry[] = [];
  if (parts.has('changelog')) {
    const arr = Array.isArray(r.changelog) ? r.changelog : [];
    if (arr.length > MAX_IMPORT_CHANGELOG) notes.push(`${arr.length} changelog entries proposed; kept the first ${MAX_IMPORT_CHANGELOG}`);
    const logged = new Set((ctx.logged ?? []).map((t) => t.toLowerCase()));
    for (const item of arr.slice(0, MAX_IMPORT_CHANGELOG)) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const title = str(o.title, 300);
      if (!title) continue;
      if (logged.has(title.toLowerCase())) { notes.push(`changelog "${title}" is already there — dropped`); continue; }
      logged.add(title.toLowerCase());
      const date = str(o.date, 10);
      changelog.push({
        id: `c${changelog.length + 1}`, kind: normalizeKind(o.kind), title, body: str(o.body, 2000), release: str(o.release, 60),
        date: /^\d{4}-\d\d-\d\d$/.test(date) ? date : '',
      });
    }
  }

  if (!architecture && !architectureHtml && features.length === 0 && backlog.length === 0 && changelog.length === 0) {
    return { value: null, notes, error: `nothing usable: send ${[...parts].join(', ')}` };
  }
  return { value: { message: str(r.message, 300), architecture, architectureHtml, features, areas, backlog, changelog }, notes, error: '' };
}

/**
 * The page is shown sandboxed (an iframe with no script permission, and the page route sends a CSP
 * sandbox) — stripping what would run is the second lock: scripts, event handlers, javascript: URLs,
 * and anything that loads or embeds from elsewhere.
 */
export function stripActive(html: string, notes: string[]): string {
  const before = html.length;
  const out = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed|frame|frameset|base|meta\s+http-equiv)\b[^>]*>(?:[\s\S]*?<\/\1\s*>)?/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1="#"');
  if (out.length !== before) notes.push('scripts and embeds were removed from the architecture page — it is shown as a static page');
  return out;
}

/**
 * Keep the list readable at a glance: at most MAX_FEATURE_GROUPS top-level groups. The largest
 * groups keep their names; the rest fold into "Other", their own name kept as the sub-area so
 * nothing is lost. Returns the summaries of the groups that survived (and only those).
 */
function foldGroups(features: ImportFeature[], backlog: ImportBacklogItem[], rawAreas: unknown, notes: string[]): FeatureArea[] {
  const items: { area: string }[] = [...features, ...backlog];
  const size = new Map<string, number>();
  for (const it of items) { const g = groupOf(it.area); if (g) size.set(g, (size.get(g) ?? 0) + 1); }
  const ranked = [...size.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  if (ranked.length > MAX_FEATURE_GROUPS) {
    const keep = new Set(ranked.slice(0, MAX_FEATURE_GROUPS - 1));
    const folded = ranked.filter((g) => !keep.has(g));
    for (const it of items) {
      const g = groupOf(it.area);
      if (g && !keep.has(g)) it.area = `${OTHER_GROUP}${AREA_SEP}${g}`;
    }
    notes.push(`${ranked.length} groups proposed; the ${folded.length} smallest were folded into "${OTHER_GROUP}": ${folded.join(', ')}`);
  }
  const kept = new Set(items.map((it) => groupOf(it.area)).filter(Boolean));
  const seen = new Set<string>();
  const areas: FeatureArea[] = [];
  for (const a of Array.isArray(rawAreas) ? rawAreas : []) {
    if (!a || typeof a !== 'object') continue;
    const name = str((a as Record<string, unknown>).name, 80);
    if (!kept.has(name) || seen.has(name)) continue;
    seen.add(name);
    areas.push({ name, summary: str((a as Record<string, unknown>).summary, 300) });
  }
  return areas;
}

export function submitImport(id: string, raw: unknown): ProjectImport {
  const imp = getImport(id);
  if (!imp) throw new ImportError('import request not found', 404);
  if (imp.status === 'superseded') throw new ImportError('this request was superseded by a newer one — nothing was recorded');
  if (imp.status !== 'pending') throw new ImportError(`this request was already ${imp.status}`);
  const listed = (db.prepare('SELECT name FROM goals WHERE project_id = ?').all(imp.projectId) as { name: string }[]).map((g) => g.name);
  const logged = (db.prepare('SELECT title FROM project_changelog WHERE project_id = ?').all(imp.projectId) as { title: string }[]).map((e) => e.title);
  const out = normalizeImport(raw, { listed, logged, parts: imp.parts });
  if (!out.value) throw new ImportError(`submission rejected: ${out.error}`, 422);
  db.prepare(`UPDATE project_imports SET status = 'ready', proposal = ?, notes = ?, completed_at = ? WHERE id = ?`)
    .run(JSON.stringify(out.value), JSON.stringify(out.notes), now(), id);
  return getImport(id)!;
}

// ── applying what the person kept ───────────────────────────────────────────────

export interface ApplyInput {
  /** The architecture text to write onto the project — as the person edited it; '' or absent = keep the project's. */
  architecture?: unknown;
  /** true = keep the proposed architecture page. */
  architectureHtml?: unknown;
  /** Names of proposed features to add as EXISTING. */
  features?: unknown;
  /** Names of proposed backlog items to add as planned features. */
  backlog?: unknown;
  /** Ids of proposed changelog entries to add. */
  changelog?: unknown;
}

/** A feature's documented behaviour as the criteria lines the spec reads back (lib/project-spec.ts criteriaFromText). */
export function criteriaLines(criteria: ImportCriterion[]): string {
  return criteria.map((c, i) => `AC-${i + 1}: ${c.text}${c.expect ? ` Expected: ${c.expect}` : ''}`).join('\n');
}

export function applyImport(id: string, input: ApplyInput): { imp: ProjectImport; created: { existing: string[]; planned: string[]; changelog: number } } {
  const imp = getImport(id);
  if (!imp) throw new ImportError('import request not found', 404);
  if (imp.status !== 'ready' || !imp.proposal) throw new ImportError(`there is nothing to apply — the request is ${imp.status}`);
  const names = (v: unknown) => new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean));
  const pickF = names(input.features);
  const pickB = names(input.backlog);
  const pickC = names(input.changelog);
  const architecture = typeof input.architecture === 'string' ? input.architecture.trim().slice(0, MAX_ARCHITECTURE_CHARS) : '';
  const page = input.architectureHtml === true ? imp.proposal.architectureHtml : '';
  if (!architecture && !page && pickF.size === 0 && pickB.size === 0 && pickC.size === 0) throw new ImportError('tick at least one thing to keep', 400);

  const existing: string[] = [];
  const planned: string[] = [];
  const kept = { features: [] as string[], backlog: [] as string[] };
  let changelog = 0;
  const tx = db.transaction(() => {
    const t = now();
    // What the project gained since the proposal was written (another proposal applied, a feature
    // added by hand) is not added twice.
    const listed = new Set((db.prepare('SELECT name FROM goals WHERE project_id = ?').all(imp.projectId) as { name: string }[]).map((g) => g.name.trim().toLowerCase()));
    const logged = new Set((db.prepare('SELECT title FROM project_changelog WHERE project_id = ?').all(imp.projectId) as { title: string }[]).map((e) => e.title.trim().toLowerCase()));
    const fresh = (set: Set<string>, name: string) => { const k = name.trim().toLowerCase(); if (set.has(k)) return false; set.add(k); return true; };
    for (const f of imp.proposal!.features) {
      if (!pickF.has(f.name.toLowerCase()) || !fresh(listed, f.name)) continue;
      const description = [f.description, f.evidence ? `Where: ${f.evidence}` : ''].filter(Boolean).join(' ');
      const gid = createFeature({ projectId: imp.projectId, name: f.name, description, status: 'achieved' });
      db.prepare("UPDATE goals SET origin = 'imported', done_at = ?, acceptance_criteria = ?, area = ? WHERE id = ?").run(t, criteriaLines(f.criteria), f.area, gid);
      existing.push(gid);
      kept.features.push(f.name);
    }
    for (const b of imp.proposal!.backlog) {
      if (!pickB.has(b.name.toLowerCase()) || !fresh(listed, b.name)) continue;
      const gid = createFeature({ projectId: imp.projectId, name: b.name, description: [b.description, b.source ? `(Seen in ${b.source}.)` : ''].filter(Boolean).join(' ') });
      if (b.area) db.prepare('UPDATE goals SET area = ? WHERE id = ?').run(b.area, gid);
      planned.push(gid);
      kept.backlog.push(b.name);
    }
    // History keeps its own dates: an entry is dated by its change, and a release by its latest change,
    // so every entry of a release ships on the same day.
    const at = (date: string) => (date ? `${date}T12:00:00.000Z` : t);
    const shipped = new Map<string, string>();
    for (const c of imp.proposal!.changelog) {
      if (c.release && c.date > (shipped.get(c.release) ?? '')) shipped.set(c.release, c.date);
    }
    for (const c of imp.proposal!.changelog) {
      if (!pickC.has(c.id.toLowerCase()) || !fresh(logged, c.title)) continue;
      const e = addEntry(imp.projectId, { kind: c.kind, title: c.title, body: c.body });
      db.prepare('UPDATE project_changelog SET release = ?, released_at = ?, created_at = ? WHERE id = ?')
        .run(c.release, c.release ? at(shipped.get(c.release) ?? '') : null, at(c.date), e.id);
      changelog++;
    }
    if (architecture) db.prepare('UPDATE projects SET architecture = ?, updated_at = ? WHERE id = ?').run(architecture, t, imp.projectId);
    if (page) db.prepare('UPDATE projects SET architecture_html = ?, updated_at = ? WHERE id = ?').run(page, t, imp.projectId);
    if (imp.proposal!.areas.length && (kept.features.length || kept.backlog.length)) {
      // A newer summary of a group replaces the older one; groups this proposal did not mention keep theirs.
      const merged = new Map(projectAreas(imp.projectId).map((a) => [a.name, a]));
      for (const a of imp.proposal!.areas) if (a.summary) merged.set(a.name, a);
      db.prepare('UPDATE projects SET feature_areas = ? WHERE id = ?').run(JSON.stringify([...merged.values()]), imp.projectId);
    }
    db.prepare(`UPDATE project_imports SET status = 'applied', applied = ? WHERE id = ?`).run(JSON.stringify({
      architecture: !!(architecture || page), features: kept.features, backlog: kept.backlog, changelog,
    }), id);
  });
  tx();
  return { imp: getImport(id)!, created: { existing, planned, changelog } };
}

/** The summaries of a project's capability groups (projects.feature_areas). */
export function projectAreas(projectId: string): FeatureArea[] {
  const r = db.prepare('SELECT feature_areas FROM projects WHERE id = ?').get(projectId) as { feature_areas?: string } | undefined;
  return parse<FeatureArea[]>(r?.feature_areas, []).filter((a) => a && typeof a.name === 'string');
}

/**
 * Features imported before goals.area existed carry their area only as "Area: <area>." in the
 * description (how applyImport used to write it). Lift it into the field and out of the prose.
 * Idempotent: only imported features with no area yet are touched. Returns how many were.
 */
export function backfillFeatureAreas(): number {
  const rows = db.prepare(`SELECT id, description FROM goals WHERE origin = 'imported' AND area = '' AND description LIKE '%Area: %'`)
    .all() as { id: string; description: string }[];
  const set = db.prepare('UPDATE goals SET area = ?, description = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const m = r.description.match(/(?:^|\s)Area: (.+?)\.(?=\s|$)/);
      if (!m) continue;
      set.run(m[1].trim().slice(0, 80), r.description.replace(m[0], '').replace(/\s{2,}/g, ' ').trim(), r.id);
      n++;
    }
  })();
  return n;
}
