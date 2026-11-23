/**
 * A PROJECT'S DESIGN SYSTEM — step 1: its DIRECTION.
 *
 * A person loads pictures of interfaces they like; a designer answers with four directions
 * (colours, type, corners, density, surfaces); the person comments and asks for four more, as
 * often as they like, and in the end selects one. That whole exploration is kept with the project:
 *
 *   inspirations   the pictures (as data URLs, already scaled down by the page) and the colours read off them
 *   rounds         every pass of the designer: four variations each, with the comments made on them
 *   selected       the direction chosen, or null while still exploring
 *   system         step 2 — the direction FINALIZED into a design system (design-system-build.ts): its
 *                  spec, its version, the files it is made of, and the direction it was made from
 *   published      where that system has been put: each repo of the project, and what happened there
 *
 * `system` and `published` are the server's: a save from the page never changes or drops them.
 *
 * This file only KEEPS it, whole, and refuses what is not an exploration. The designer is Claude's
 * /design, run in the project's main repo (design-request.ts): its rounds arrive through
 * appendRound, and a save from the page never drops a round it has not seen yet.
 */
import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS design_systems (
    project_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export class DesignSystemError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const LIMITS = { inspirations: 12, rounds: 40, variationsPerRound: 4, bytes: 16 * 1024 * 1024, pictureBytes: 1_500_000 } as const;
export interface FinalSystem {
  version: number; finalizedAt: string; from: { roundId: string; variationId: string }; name: string;
  spec: unknown; files: { path: string; bytes: number }[]; html: string;
}
export interface RepoResult { repoPath: string; status: 'pushed' | 'committed' | 'unchanged' | 'failed'; detail: string; branch: string; commit: string }
export interface Published { version: number; at: string; repos: RepoResult[] }
export interface Exploration {
  inspirations: unknown[]; rounds: unknown[]; selected: { roundId: string; variationId: string } | null; updatedAt: string;
  system?: FinalSystem | null; published?: Published | null;
}
const EMPTY = (): Exploration => ({ inspirations: [], rounds: [], selected: null, updatedAt: '' });

const projectExists = (projectId: string) => !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The project's exploration; an empty one when it has none yet; null when there is no such project. */
export function getDesignSystem(projectId: string): Exploration | null {
  if (!projectExists(projectId)) return null;
  const row = db.prepare('SELECT data, updated_at FROM design_systems WHERE project_id = ?').get(projectId) as { data: string; updated_at: string } | undefined;
  if (!row) return EMPTY();
  try { return { ...EMPTY(), ...(JSON.parse(row.data) as object), updatedAt: row.updated_at }; } catch { return EMPTY(); }
}

/** Check that `input` is an exploration, and say exactly what is wrong when it is not. */
export function validateExploration(input: unknown): Pick<Exploration, 'inspirations' | 'rounds' | 'selected'> {
  if (!isObject(input)) throw new DesignSystemError('a design system is an object');
  const { inspirations, rounds, selected } = input;
  if (!Array.isArray(inspirations) || !Array.isArray(rounds)) throw new DesignSystemError('inspirations and rounds are lists');
  if (inspirations.length > LIMITS.inspirations) throw new DesignSystemError(`at most ${LIMITS.inspirations} inspiration pictures`);
  if (rounds.length > LIMITS.rounds) throw new DesignSystemError(`at most ${LIMITS.rounds} rounds`);
  for (const pic of inspirations) {
    if (!isObject(pic) || typeof pic.id !== 'string' || typeof pic.dataUrl !== 'string') throw new DesignSystemError('an inspiration has an id and a picture');
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(pic.dataUrl)) throw new DesignSystemError('an inspiration picture is a PNG, JPEG, WebP or GIF');
    if (pic.dataUrl.length > LIMITS.pictureBytes) throw new DesignSystemError('an inspiration picture is too large');
    if (!Array.isArray(pic.colors) || !pic.colors.every((c) => typeof c === 'string' && HEX.test(c))) throw new DesignSystemError("an inspiration's colours are #rrggbb");
  }
  const known = new Set<string>();
  for (const round of rounds) {
    if (!isObject(round) || typeof round.id !== 'string' || !Array.isArray(round.variations)) throw new DesignSystemError('a round has an id and its variations');
    if (round.variations.length !== LIMITS.variationsPerRound) throw new DesignSystemError(`a round has exactly ${LIMITS.variationsPerRound} variations`);
    for (const v of round.variations) {
      if (!isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || !isObject(v.tokens)) throw new DesignSystemError('a variation has an id, a name and its tokens');
      const colors = (v.tokens as Record<string, unknown>).colors;
      if (!isObject(colors) || !Object.values(colors).every((c) => typeof c === 'string' && HEX.test(c))) throw new DesignSystemError("a variation's colours are #rrggbb");
      if (!Array.isArray(v.comments)) throw new DesignSystemError("a variation's comments are a list");
      if (known.has(`${round.id}/${v.id}`)) throw new DesignSystemError('two variations share an id');
      known.add(`${round.id}/${v.id}`);
    }
  }
  let chosen: Exploration['selected'] = null;
  if (selected !== null && selected !== undefined) {
    if (!isObject(selected) || typeof selected.roundId !== 'string' || typeof selected.variationId !== 'string') throw new DesignSystemError('the selection names a round and a variation');
    // The selection must be one of the variations that are actually there.
    if (!known.has(`${selected.roundId}/${selected.variationId}`)) throw new DesignSystemError('the selected direction is not one of the variations');
    chosen = { roundId: selected.roundId, variationId: selected.variationId };
  }
  return { inspirations, rounds, selected: chosen };
}

/** Keep the exploration (the whole of it replaces what was there). */
export function saveDesignSystem(projectId: string, input: unknown, now = new Date().toISOString()): Exploration {
  if (!projectExists(projectId)) throw new DesignSystemError('Project not found', 404);
  // What the server made — the finalized system and where it was published — stays as it is.
  const before = getDesignSystem(projectId);
  const valid = validateExploration(input);
  // A round the designer delivered (it says who made it: `by`) while the page was open is not in
  // what the page sends back — it is kept, in its place at the end, not dropped.
  const sent = new Set((valid.rounds as { id: string }[]).map((r) => r.id));
  const unseen = ((before?.rounds ?? []) as { id: string; by?: string }[]).filter((r) => r.by && !sent.has(r.id));
  const clean = { ...valid, rounds: [...valid.rounds, ...unseen], system: before?.system ?? null, published: before?.published ?? null };
  const data = JSON.stringify(clean);
  if (data.length > LIMITS.bytes) throw new DesignSystemError('this design system is too large to keep — remove some inspiration pictures');
  db.prepare(`INSERT INTO design_systems (project_id, data, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(projectId, data, now);
  return { ...clean, updatedAt: now };
}

/** A round the designer delivered: added after the rounds that are there. Everything else stays. */
export function appendRound(projectId: string, round: Record<string, unknown>, now = new Date().toISOString()): Exploration {
  const cur = getDesignSystem(projectId);
  if (!cur) throw new DesignSystemError('Project not found', 404);
  const { updatedAt: _was, ...rest } = cur;
  const next = { ...rest, rounds: [...cur.rounds, round] };
  validateExploration(next);
  db.prepare(`INSERT INTO design_systems (project_id, data, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(projectId, JSON.stringify(next), now);
  return { ...next, updatedAt: now };
}

/** Keep what the server itself worked out (the finalized system, the publishing) beside the exploration. */
export function keepServerPart(projectId: string, part: { system?: FinalSystem | null; published?: Published | null }, now = new Date().toISOString()): Exploration {
  const cur = getDesignSystem(projectId);
  if (!cur) throw new DesignSystemError('Project not found', 404);
  const { updatedAt: _was, ...rest } = cur;
  const next = { ...rest, ...part };
  db.prepare(`INSERT INTO design_systems (project_id, data, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(projectId, JSON.stringify(next), now);
  return { ...next, updatedAt: now };
}

