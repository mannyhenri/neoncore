/**
 * THE PROJECT CHANGELOG — what shipped, in Keep-a-Changelog form.
 *
 * An entry is written by NeonCore the moment a feature is marked done, from that feature's own
 * records: its name, the kind of work (a bug fix is "Fixed", a new feature "Added", an improvement
 * "Changed"), the report's summary and what its stages changed, and how it measured up against its
 * acceptance criteria. Nobody has to remember to write it, and it says only what the records say.
 *
 * A person edits, adds or removes entries, and CUTS A RELEASE: every unreleased entry is stamped with
 * a version and a date. The rendered CHANGELOG.md lists "Unreleased" first, then each release, newest
 * first. Published into the repo with the rest of the docs (lib/project-docs.ts).
 */
import { randomUUID } from 'crypto';
import db from '../db.js';
import { buildProjectSpec, GENERATED_NOTE } from './project-spec.js';
import { pilotsForGoal } from './goal-pilot.js';

export const CHANGE_KINDS = ['added', 'changed', 'fixed', 'removed', 'security'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
const KIND_HEADING: Record<ChangeKind, string> = { added: 'Added', changed: 'Changed', fixed: 'Fixed', removed: 'Removed', security: 'Security' };

export interface ChangelogEntry {
  id: string;
  projectId: string;
  goalId: string;
  kind: ChangeKind;
  title: string;
  body: string;
  release: string;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const now = () => new Date().toISOString();

function row(r: Record<string, unknown>): ChangelogEntry {
  return {
    id: r.id as string, projectId: r.project_id as string, goalId: (r.goal_id as string) || '',
    kind: (CHANGE_KINDS as readonly string[]).includes(r.kind as string) ? r.kind as ChangeKind : 'changed',
    title: r.title as string, body: (r.body as string) || '', release: (r.release as string) || '',
    releasedAt: (r.released_at as string) ?? null, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

export function normalizeKind(v: unknown): ChangeKind {
  return (CHANGE_KINDS as readonly string[]).includes(String(v)) ? v as ChangeKind : 'changed';
}

export function changelogFor(projectId: string): ChangelogEntry[] {
  return (db.prepare(
    `SELECT * FROM project_changelog WHERE project_id = ?
      ORDER BY CASE WHEN release = '' THEN 0 ELSE 1 END, released_at DESC, created_at DESC`,
  ).all(projectId) as Record<string, unknown>[]).map(row);
}

export function getEntry(id: string): ChangelogEntry | null {
  const r = db.prepare('SELECT * FROM project_changelog WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? row(r) : null;
}

export function addEntry(projectId: string, input: { kind?: unknown; title?: unknown; body?: unknown; goalId?: string }): ChangelogEntry {
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('a changelog entry needs a title');
  const id = randomUUID();
  const t = now();
  db.prepare(`INSERT INTO project_changelog (id, project_id, goal_id, kind, title, body, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, projectId, input.goalId ?? '', normalizeKind(input.kind), title.slice(0, 300), String(input.body ?? '').trim(), t, t);
  return getEntry(id)!;
}

export function updateEntry(id: string, input: { kind?: unknown; title?: unknown; body?: unknown }): ChangelogEntry | null {
  const e = getEntry(id);
  if (!e) return null;
  db.prepare('UPDATE project_changelog SET kind = ?, title = ?, body = ?, updated_at = ? WHERE id = ?').run(
    input.kind !== undefined ? normalizeKind(input.kind) : e.kind,
    input.title !== undefined && String(input.title).trim() ? String(input.title).trim().slice(0, 300) : e.title,
    input.body !== undefined ? String(input.body).trim() : e.body,
    now(), id,
  );
  return getEntry(id);
}

export function deleteEntry(id: string): void {
  db.prepare('DELETE FROM project_changelog WHERE id = ?').run(id);
}

/** Stamp every unreleased entry with `version`. Returns how many shipped in it. */
export function cutRelease(projectId: string, version: string): number {
  const v = version.trim().slice(0, 60);
  if (!v) throw new Error('name the release (a version like 1.4.0, or a date)');
  if (db.prepare('SELECT 1 FROM project_changelog WHERE project_id = ? AND release = ?').get(projectId, v)) {
    throw new Error(`there is already a release called "${v}"`);
  }
  return db.prepare("UPDATE project_changelog SET release = ?, released_at = ?, updated_at = ? WHERE project_id = ? AND release = ''")
    .run(v, now(), now(), projectId).changes;
}

/** The kind of change a feature makes, from what it was scoped as. */
function kindForFeature(goalId: string): ChangeKind {
  const workType = pilotsForGoal(goalId).find((p) => p.intake?.workType)?.intake.workType ?? '';
  if (workType === 'bug') return 'fixed';
  if (workType === 'improvement' || workType === 'performance' || workType === 'docs' || workType === 'quality') return 'changed';
  return 'added';
}

/**
 * The entry for a feature that was just marked done — written once per feature (an entry that survived a
 * reopen, because a person edited it or it was released, is kept as it is). Returns null for a feature
 * outside a project, or one that already has its entry.
 */
export function entryForDoneFeature(goalId: string): ChangelogEntry | null {
  const g = db.prepare('SELECT id, project_id, name, origin FROM goals WHERE id = ?').get(goalId) as
    { id: string; project_id: string; name: string; origin: string } | undefined;
  if (!g?.project_id || g.origin === 'imported') return null;
  if (db.prepare('SELECT 1 FROM project_changelog WHERE goal_id = ?').get(goalId)) return null;
  const spec = buildProjectSpec(g.project_id);
  const f = spec?.features.find((x) => x.id === goalId);
  // One lead sentence (what it is, and how it measured up), then what changed as bullets — a plain line
  // after a list would read as part of its last item.
  const summary = (f?.intent.summary || f?.delivery?.summary || '').replace(/\s+/g, ' ').trim();
  const measured = f && f.criteria.length
    ? (f.criteriaMet === f.criteria.length
      ? `Meets all ${f.criteria.length} acceptance criteria (checked by NeonCore).`
      : `Meets ${f.criteriaMet} of ${f.criteria.length} acceptance criteria — see the feature's spec for what is open.`)
    : '';
  const lines = [[summary, measured].filter(Boolean).join(' ')].filter(Boolean);
  for (const w of (f?.delivery?.whatChanged ?? []).slice(0, 5)) lines.push(`- ${w.replace(/\s+/g, ' ').trim()}`);
  return addEntry(g.project_id, { kind: kindForFeature(goalId), title: g.name, body: lines.join('\n'), goalId });
}

/**
 * A done feature reopened has not shipped after all: its entry comes out again — but only while it is
 * unreleased and exactly as NeonCore wrote it. One a person edited, or that shipped in a release, stays.
 */
export function retractEntryForReopenedFeature(goalId: string): boolean {
  const r = db.prepare(`DELETE FROM project_changelog WHERE goal_id = ? AND release = '' AND updated_at = created_at`).run(goalId);
  return r.changes > 0;
}

/** CHANGELOG.md — Unreleased first, then every release, newest first. */
export function renderChangelogMarkdown(projectName: string, entries: ChangelogEntry[]): string {
  const out: string[] = [`# ${projectName} — changelog`, '', `> ${GENERATED_NOTE}`, ''];
  const groups = new Map<string, ChangelogEntry[]>();
  for (const e of entries) {
    const k = e.release || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  const order = [...groups.keys()].sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return String(groups.get(b)![0].releasedAt).localeCompare(String(groups.get(a)![0].releasedAt));
  });
  if (order.length === 0) out.push('_Nothing yet — an entry is written here when a feature is marked done._', '');
  for (const rel of order) {
    const list = groups.get(rel)!;
    out.push(rel ? `## ${rel} — ${String(list[0].releasedAt ?? '').slice(0, 10)}` : '## Unreleased', '');
    for (const kind of CHANGE_KINDS) {
      const items = list.filter((e) => e.kind === kind);
      if (!items.length) continue;
      out.push(`### ${KIND_HEADING[kind]}`, '');
      for (const e of items) {
        // The first prose line reads after the title; bullets and further lines nest under it.
        const lines = e.body.split('\n').map((l) => l.trim()).filter(Boolean);
        const lead = lines[0] && !lines[0].startsWith('- ') ? lines.shift() : '';
        out.push(`- **${e.title}**${lead ? ` — ${lead}` : ''}`);
        for (const l of lines) out.push(`  ${l}`);
      }
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
