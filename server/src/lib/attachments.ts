import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import type { CommandAttachmentInput } from '../types.js';

/**
 * Prompt attachments — files the human hands to an agent alongside the prompt.
 *
 * The bytes are decoded server-side and written into the target repo under
 * `.neoncore/attachments/<date>/<batch>/` (gitignored), then referenced by path in
 * the prompt. Agents read files, not base64 blobs, so "attaching" a file means
 * putting it where the agent can `Read` it and telling the agent where that is.
 *
 * Three callers share this: the cartridge send-prompt box, a confer, and a workflow
 * run. The last two dispatch to MANY agents that may sit in different repos, so the
 * bytes are materialized once per distinct repo path and each agent is handed the
 * path that is valid for its own checkout — see materializeForRepos().
 *
 * Caveat (pre-existing, inherited from send-command): the files are written by the
 * SERVER process onto the server's filesystem. An agent on another machine gets a
 * prompt naming a path that only exists server-side.
 */

export const ATTACHMENT_MAX_FILES = 10;
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export interface AttachmentEntry {
  originalName: string;
  path: string;
  mimeType: string;
  size: number;
}

/** repoPath → prompt block. Empty repo paths are never keys. */
export type AttachmentBlocks = Record<string, string>;

function safeFilename(name: string, fallback: string): string {
  const base = path.basename(name || fallback)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : fallback;
}

function ensureGitignore(repoPath: string): void {
  const gitignorePath = path.join(repoPath, '.gitignore');
  const entry = '.neoncore/attachments/';
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (existing.split(/\r?\n/).includes(entry)) return;
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } catch (err) {
    console.warn(`[attachments] Could not update ${gitignorePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Validate a request body's `attachments` field. Throws with a user-facing message —
 * routes turn that into a 400 rather than letting a malformed upload reach the disk.
 */
export function parseAttachmentsInput(raw: unknown): CommandAttachmentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('attachments must be an array');
  for (const attachment of raw) {
    if (
      !attachment ||
      typeof attachment.name !== 'string' ||
      typeof attachment.dataBase64 !== 'string' ||
      typeof attachment.size !== 'number'
    ) {
      throw new Error('Each attachment needs name, size, and dataBase64');
    }
  }
  return raw as CommandAttachmentInput[];
}

/**
 * Decode attachments into `repoPath/.neoncore/attachments/...` and return the prompt
 * block that tells the agent where they landed. Returns '' when there is nothing to
 * attach. Throws when the repo path is unusable or the payload is oversized.
 */
export function materializeAttachments(
  repoPath: string,
  attachments: CommandAttachmentInput[] | undefined,
  opts: { absolutePaths?: boolean } = {},
): string {
  if (!attachments || attachments.length === 0) return '';
  if (!repoPath) throw new Error('Cannot attach files: agent has no repo path');
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`Cannot attach files: repo path does not exist (${repoPath})`);
  }

  const selected = attachments.slice(0, ATTACHMENT_MAX_FILES);
  const totalBytes = selected.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  if (totalBytes > ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachments are too large (${Math.ceil(totalBytes / 1024 / 1024)} MB, max 20 MB)`);
  }

  ensureGitignore(repoPath);
  const today = new Date().toISOString().slice(0, 10);
  const batchId = uuid().slice(0, 8);
  const relativeDir = path.join('.neoncore', 'attachments', today, batchId);
  const absoluteDir = path.join(repoPath, relativeDir);
  fs.mkdirSync(absoluteDir, { recursive: true });

  const entries: AttachmentEntry[] = [];
  const usedNames = new Set<string>();
  selected.forEach((file, index) => {
    if (!file?.dataBase64) return;
    const initialFilename = safeFilename(file.name, `attachment-${index + 1}`);
    const parsed = path.parse(initialFilename);
    let filename = initialFilename;
    let suffix = 2;
    while (usedNames.has(filename)) {
      filename = `${parsed.name}-${suffix}${parsed.ext}`;
      suffix += 1;
    }
    usedNames.add(filename);
    const buffer = Buffer.from(file.dataBase64, 'base64');
    if (buffer.length === 0) return;
    if (file.size && Math.abs(buffer.length - file.size) > 2) {
      throw new Error(`Attachment "${file.name}" size did not match uploaded data`);
    }
    const relativePath = path.join(relativeDir, filename);
    fs.writeFileSync(path.join(repoPath, relativePath), buffer, { flag: 'wx' });
    entries.push({
      originalName: file.name || filename,
      path: relativePath.replace(/\\/g, '/'),
      mimeType: file.mimeType || 'application/octet-stream',
      size: buffer.length,
    });
  });

  fs.writeFileSync(
    path.join(absoluteDir, 'metadata.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), attachments: entries }, null, 2) + '\n',
    { flag: 'wx' },
  );

  if (entries.length === 0) return '';
  // Workflow steps can be told to `cd` into a git worktree before they start, where a repo-
  // relative `.neoncore/attachments/...` path resolves to a directory that has no such file
  // (it is gitignored, so the worktree never gets a copy). Callers that dispatch into
  // worktrees ask for absolute paths, which are correct from any cwd.
  const lines = entries.map((entry) => {
    const shown = opts.absolutePaths ? path.join(repoPath, entry.path) : entry.path;
    return `- ${entry.originalName} (${entry.mimeType}, ${entry.size} bytes): ${shown}`;
  });
  return [
    '',
    '',
    'Attached files have been copied into this repo:',
    ...lines,
    '',
    'Inspect these local files directly when they are relevant. Do not commit them.',
  ].join('\n');
}

/**
 * Materialize the same attachments into every distinct repo path, so each agent in a
 * multi-agent run gets a copy it can open with a path valid in its own checkout.
 * Blank/duplicate paths are dropped. Returns a repoPath → prompt block map, which is
 * what confer sessions and workflow runs persist.
 */
export function materializeForRepos(
  repoPaths: (string | null | undefined)[],
  attachments: CommandAttachmentInput[] | undefined,
  opts: { absolutePaths?: boolean } = { absolutePaths: true },
): AttachmentBlocks {
  const blocks: AttachmentBlocks = {};
  if (!attachments || attachments.length === 0) return blocks;

  const distinct = [...new Set(repoPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== ''))];
  if (distinct.length === 0) {
    throw new Error('Cannot attach files: none of the selected cartridges has a repo path');
  }
  for (const repoPath of distinct) {
    const block = materializeAttachments(repoPath, attachments, opts);
    if (block) blocks[repoPath] = block;
  }
  return blocks;
}

/** Read back a persisted blocks map (a JSON column) without throwing on garbage. */
export function parseAttachmentBlocks(stored: string | null | undefined): AttachmentBlocks {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AttachmentBlocks) : {};
  } catch {
    return {};
  }
}

/**
 * The block to append for an agent sitting in `repoPath`. Falls back to the only
 * entry when there is exactly one repo in play — an agent that joined late (or whose
 * repo path was recorded differently) still learns the files exist rather than
 * silently getting a prompt that never mentions them.
 */
export function blockForRepo(blocks: AttachmentBlocks, repoPath: string): string {
  if (repoPath && blocks[repoPath]) return blocks[repoPath];
  const values = Object.values(blocks);
  return values.length === 1 ? values[0] : '';
}
