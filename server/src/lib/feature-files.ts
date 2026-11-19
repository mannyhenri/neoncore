/**
 * FEATURE FILES — what a person hands the feature itself: a mockup, a spec PDF, a CSV of examples.
 *
 * Prompt attachments (lib/attachments.ts) belong to ONE prompt. A feature is worked by many
 * cartridges over days — the planner scopes and plans it, a test writer, each stage of its
 * pipeline, a reviewer — often in different repos. So these files belong to the feature: the
 * server keeps them (beside the database, `feature-files/<goalId>/`), and every cartridge the
 * feature's pipeline talks to gets them copied into its OWN repo, under
 * `.neoncore/attachments/feature-<id>/` (gitignored), named in its prompt by an absolute path —
 * correct from a worktree too.
 *
 * Two places hand them out, and between them they cover every agent the pipeline reaches:
 *   deliverPlannerRequest (goal-pilot-runner) — every request kind, the one delivery path
 *   buildStageContext     (goal-pilot-runner) — every stage's run, for each participant's repo
 *
 * Caveat, the same as prompt attachments: the copy is made by the server onto the server's
 * filesystem, so a cartridge on another machine is named a path that exists only here.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { parseAttachmentsInput, safeFilename, ensureGitignore } from './attachments.js';

export const FEATURE_FILES_MAX = 20;
export const FEATURE_FILES_MAX_BYTES = 50 * 1024 * 1024;

export interface FeatureFile { id: string; goalId: string; name: string; mimeType: string; size: number; createdAt: string }

export class FeatureFileError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function root(): string {
  return process.env.NEONCORE_FEATURE_FILES_DIR?.trim() || path.join(path.dirname(path.resolve(db.name)), 'feature-files');
}
/** Where the server keeps a feature's files. */
export function featureFilesDir(goalId: string): string {
  return path.join(root(), path.basename(goalId));
}

const row = (r: Record<string, unknown>): FeatureFile & { storedName: string } => ({
  id: r.id as string, goalId: r.goal_id as string, name: r.name as string, mimeType: r.mime_type as string,
  size: r.size as number, createdAt: r.created_at as string, storedName: r.stored_name as string,
});

function rows(goalId: string) {
  return (db.prepare('SELECT * FROM goal_files WHERE goal_id = ? ORDER BY created_at, name').all(goalId) as Record<string, unknown>[]).map(row);
}

export function listFeatureFiles(goalId: string): FeatureFile[] {
  return rows(goalId).map(({ storedName: _s, ...f }) => f);
}

export function addFeatureFiles(goalId: string, raw: unknown): FeatureFile[] {
  if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId)) throw new FeatureFileError('feature not found', 404);
  let inputs;
  try { inputs = parseAttachmentsInput(raw); } catch (e) { throw new FeatureFileError(e instanceof Error ? e.message : String(e)); }
  if (inputs.length === 0) throw new FeatureFileError('no files sent');
  const have = rows(goalId);
  if (have.length + inputs.length > FEATURE_FILES_MAX) throw new FeatureFileError(`a feature holds at most ${FEATURE_FILES_MAX} files (it has ${have.length})`);
  const buffers = inputs.map((f) => {
    const buf = Buffer.from(f.dataBase64, 'base64');
    if (buf.length === 0) throw new FeatureFileError(`"${f.name}" is empty`);
    if (f.size && Math.abs(buf.length - f.size) > 2) throw new FeatureFileError(`"${f.name}" did not upload completely`);
    return buf;
  });
  const total = have.reduce((n, f) => n + f.size, 0) + buffers.reduce((n, b) => n + b.length, 0);
  if (total > FEATURE_FILES_MAX_BYTES) throw new FeatureFileError(`a feature's files total at most ${FEATURE_FILES_MAX_BYTES / 1024 / 1024} MB`);

  const dir = featureFilesDir(goalId);
  fs.mkdirSync(dir, { recursive: true });
  // A name already on the feature gets -2, -3…, so the copy in a repo never overwrites another file.
  const taken = new Set(have.map((f) => f.name.toLowerCase()));
  const insert = db.prepare('INSERT INTO goal_files (id, goal_id, name, mime_type, size, stored_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  inputs.forEach((f, i) => {
    const clean = safeFilename(f.name, `file-${i + 1}`);
    const { name: stem, ext } = path.parse(clean);
    let name = clean;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${stem}-${k}${ext}`;
    taken.add(name.toLowerCase());
    const id = randomUUID();
    fs.writeFileSync(path.join(dir, id), buffers[i], { flag: 'wx' });
    insert.run(id, goalId, name, f.mimeType || 'application/octet-stream', buffers[i].length, id, now);
  });
  return listFeatureFiles(goalId);
}

export function readFeatureFile(goalId: string, fileId: string): { file: FeatureFile; data: Buffer } | null {
  const f = rows(goalId).find((x) => x.id === fileId);
  if (!f) return null;
  try { return { file: f, data: fs.readFileSync(path.join(featureFilesDir(goalId), f.storedName)) }; } catch { return null; }
}

export function removeFeatureFile(goalId: string, fileId: string): boolean {
  const f = rows(goalId).find((x) => x.id === fileId);
  if (!f) return false;
  db.prepare('DELETE FROM goal_files WHERE id = ?').run(fileId);
  fs.rmSync(path.join(featureFilesDir(goalId), f.storedName), { force: true });
  return true;
}

/** A feature deleted: its rows and its stored files. */
export function deleteFeatureFiles(goalId: string): void {
  db.prepare('DELETE FROM goal_files WHERE goal_id = ?').run(goalId);
  fs.rmSync(featureFilesDir(goalId), { recursive: true, force: true });
}

/**
 * Copy the feature's files into each repo (kept in step: a file removed from the feature leaves the
 * repo's copy too) and return the prompt block naming them — '' when the feature has none.
 */
export function featureFilesBlock(goalId: string, repoPaths: (string | null | undefined)[]): string {
  const files = rows(goalId);
  if (files.length === 0) return '';
  const repos = [...new Set(repoPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== ''))];
  const sections: string[] = [];
  for (const repo of repos) {
    try {
      if (!fs.statSync(repo).isDirectory()) continue;
      ensureGitignore(repo);
      const dir = path.join(repo, '.neoncore', 'attachments', `feature-${path.basename(goalId).slice(0, 8)}`);
      fs.mkdirSync(dir, { recursive: true });
      const keep = new Set(files.map((f) => f.name));
      for (const old of fs.readdirSync(dir)) if (!keep.has(old)) fs.rmSync(path.join(dir, old), { force: true });
      const lines = files.map((f) => {
        const dest = path.join(dir, f.name);
        const have = fs.existsSync(dest) ? fs.statSync(dest).size : -1;
        if (have !== f.size) fs.copyFileSync(path.join(featureFilesDir(goalId), f.storedName), dest);
        return `- ${f.name} (${f.mimeType}, ${f.size} bytes): ${dest}`;
      });
      sections.push(repos.length > 1 ? `In ${repo}:\n${lines.join('\n')}` : lines.join('\n'));
    } catch (err) {
      console.warn(`[feature-files] could not copy the files of ${goalId} into ${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sections.length === 0) return '';
  return [
    '',
    '',
    'Files the person attached to this feature (copied into your repo — read them where they are relevant; do not commit them):',
    ...sections,
  ].join('\n');
}
