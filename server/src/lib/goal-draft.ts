/**
 * ASSISTED GOAL AUTHORING. A draft is a proposal, never a goal.
 *
 * The user asked for "more tools to flesh out the details of the goals and expectations" — the
 * goal form is eight fields typed by hand, and Phase 3's own detail pane now reports how many
 * of them are empty. This is the thing that fills them.
 *
 * ── WHY A CARTRIDGE AND NOT AN API CALL ────────────────────────────────────────────────
 * NeonCore has no LLM client and deliberately still does not. Generation happens where every
 * other prompt in the fleet happens: dispatched to a cartridge, which submits its answer back
 * through MCP. Two reasons, one of them load-bearing:
 *
 *  1. Cost visibility. `goalCostUsd` is built on `session_usage`, which exists only for
 *     cartridge work. A server-side API call would be real money spent against a goal that the
 *     goal's own cost rollup could not see — reintroducing precisely the invisibility Phases 1
 *     and 3 were spent removing.
 *  2. Authoring improves as the templates do (GOAL-032), instead of forking into a second
 *     bespoke prompt that nobody maintains.
 *
 * ── THE REGISTRY IS THE SINGLE SOURCE ──────────────────────────────────────────────────
 * `DRAFTABLE_FIELDS` drives the prompt the cartridge receives, the validation of what comes
 * back, and the fields the UI offers. Adding a field to a goal means adding one row here; the
 * three cannot drift, and a field the prompt asks for but validation rejects cannot exist.
 */
import db from '../db.js';
import { randomUUID } from 'crypto';

export interface DraftableField {
  key: string;
  label: string;
  /** What the cartridge is being asked for. Also the UI's tooltip. */
  guidance: string;
  /** Free text, or the structured key-results array. */
  kind: 'text' | 'keyResults';
  /** Column on `goals`. */
  column: string;
}

export const DRAFTABLE_FIELDS: DraftableField[] = [
  {
    key: 'description', column: 'description', kind: 'text', label: 'Why this matters',
    guidance: 'Two or three sentences on the outcome and why it is worth doing NOW. No implementation detail.',
  },
  {
    key: 'successMetric', column: 'success_metric', kind: 'text', label: 'Done when',
    guidance: 'One sentence naming the observable condition that means this goal is finished.',
  },
  {
    key: 'acceptanceCriteria', column: 'acceptance_criteria', kind: 'text', label: 'Acceptance criteria',
    guidance: 'EARS-form statements, one per line: "When <trigger>, the system shall <response>." These reach the agent at dispatch, so they must be checkable, not aspirational.',
  },
  {
    key: 'invariants', column: 'invariants', kind: 'text', label: 'Invariants',
    guidance: 'What must remain true THROUGHOUT the work — behaviour that may not regress. One per line.',
  },
  {
    key: 'noGos', column: 'no_gos', kind: 'text', label: 'No-gos',
    guidance: 'Explicitly out of scope. This is the field that fights agent over-reach, so be concrete about what NOT to touch.',
  },
  {
    key: 'rabbitHoles', column: 'rabbit_holes', kind: 'text', label: 'Rabbit holes',
    guidance: 'Known time sinks to steer around, and why each is a trap.',
  },
  {
    key: 'keyResults', column: 'key_results', kind: 'keyResults', label: 'Key results',
    guidance: 'Up to four measurable results as JSON objects with keys: metric, baseline, target, measure. Omit entirely if nothing is genuinely measurable — an invented baseline is worse than none.',
  },
];

const BY_KEY = new Map(DRAFTABLE_FIELDS.map((f) => [f.key, f]));

export interface KeyResult {
  metric: string;
  baseline?: string;
  target?: string;
  measure?: string;
}

/** Proposed values. Every key optional — a cartridge may legitimately have nothing to add. */
export type DraftFields = Partial<Record<string, string | KeyResult[]>>;

export interface GoalDraft {
  id: string;
  goalId: string | null;
  seed: string;
  status: 'pending' | 'ready' | 'failed';
  agentId: string;
  source: string;
  fields: DraftFields;
  error: string;
  createdAt: string;
  completedAt: string | null;
  /** Set only by an explicit accept. Null means nothing generated has touched the goal. */
  appliedAt: string | null;
  appliedFields: string[];
}

function rowToDraft(row: Record<string, unknown>): GoalDraft {
  const parse = <T>(s: unknown, fallback: T): T => {
    try { return JSON.parse((s as string) || ''); } catch { return fallback; }
  };
  return {
    id: row.id as string,
    goalId: (row.goal_id as string) ?? null,
    seed: (row.seed as string) || '',
    status: ((row.status as string) || 'pending') as GoalDraft['status'],
    agentId: (row.agent_id as string) || '',
    source: (row.source as string) || '',
    fields: parse<DraftFields>(row.fields, {}),
    error: (row.error as string) || '',
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) ?? null,
    appliedAt: (row.applied_at as string) ?? null,
    appliedFields: parse<string[]>(row.applied_fields, []),
  };
}

/**
 * Keep only what the registry knows, and only in the shape it declares.
 *
 * A cartridge writes free-form output; this is the boundary that stops it becoming goal state.
 * Unknown keys are DROPPED rather than rejected — a model that volunteers an extra field should
 * not fail the whole draft — but nothing outside the registry can ever reach a column.
 */
export function normalizeDraftFields(raw: unknown): DraftFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: DraftFields = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = BY_KEY.get(key);
    if (!field) continue;

    if (field.kind === 'text') {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      // An empty proposal is not a proposal. Keeping it would let "accept" blank a field the
      // user had already filled in by hand.
      if (trimmed) out[key] = trimmed;
      continue;
    }

    if (!Array.isArray(value)) continue;
    const krs = value
      .filter((k): k is Record<string, unknown> => !!k && typeof k === 'object' && !Array.isArray(k))
      .map((k) => ({
        metric: typeof k.metric === 'string' ? k.metric.trim() : '',
        baseline: typeof k.baseline === 'string' ? k.baseline.trim() : undefined,
        target: typeof k.target === 'string' ? k.target.trim() : undefined,
        measure: typeof k.measure === 'string' ? k.measure.trim() : undefined,
      }))
      .filter((k) => k.metric)          // a key result with no metric measures nothing
      .slice(0, 4);
    if (krs.length) out[key] = krs;
  }
  return out;
}

/**
 * The prompt the cartridge receives.
 *
 * Built from the registry plus whatever the goal already has, so the cartridge is filling gaps
 * rather than overwriting decisions the user already made. It is told to submit through MCP
 * because a draft pasted into chat is not a draft anyone can accept per-field.
 */
export function buildDraftPrompt(draftId: string, seed: string, goal?: Record<string, unknown>): string {
  const existing = goal
    ? DRAFTABLE_FIELDS
        .map((f) => ({ f, v: goal[f.column] }))
        .filter((x) => typeof x.v === 'string' && x.v.trim() && x.v !== '[]')
        .map((x) => `- ${x.f.label}: ${String(x.v).replace(/\s+/g, ' ').slice(0, 300)}`)
    : [];

  return [
    'Draft the intent for a NeonCore goal. You are filling in a planning document, not writing code.',
    '',
    goal?.name ? `GOAL: ${goal.name}` : 'This is a NEW goal with no name yet.',
    '',
    'WHAT THE USER SAID:',
    seed || '(nothing beyond the goal name — infer carefully and stay conservative)',
    '',
    ...(existing.length
      ? [
          'ALREADY FILLED IN — do NOT contradict these, and only propose a replacement if you can',
          'make it materially more checkable:',
          ...existing,
          '',
        ]
      : []),
    'PRODUCE these fields:',
    ...DRAFTABLE_FIELDS.map((f) => `- ${f.key} (${f.label}): ${f.guidance}`),
    '',
    'RULES',
    '- Omit any field you cannot ground in what the user actually said. A missing field is fine;',
    '  an invented metric or a fabricated baseline is not. This text reaches working agents at',
    '  dispatch, so anything you invent becomes an instruction someone acts on.',
    '- Do not restate the goal name as the description.',
    '- Write for the person who will do the work, not for the person who asked for it.',
    '',
    `SUBMIT with the MCP tool \`neoncore_submit_goal_draft\`, draftId "${draftId}", passing a`,
    '`fields` object keyed exactly as above. Do not save anything yourself and do not edit any',
    'goal — the user reviews your draft field by field and chooses what to keep.',
  ].join('\n');
}

export function createDraft(input: {
  goalId: string | null;
  seed: string;
  agentId: string;
  source: string;
}): GoalDraft {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO goal_drafts (id, goal_id, seed, status, agent_id, source, fields, error, created_at)
     VALUES (?,?,?,'pending',?,?,'{}','',?)`,
  ).run(id, input.goalId, input.seed, input.agentId, input.source, new Date().toISOString());
  return getDraft(id)!;
}

export function getDraft(id: string): GoalDraft | null {
  const row = db.prepare('SELECT * FROM goal_drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToDraft(row) : null;
}

export function draftsForGoal(goalId: string | null): GoalDraft[] {
  const rows = (goalId
    ? db.prepare('SELECT * FROM goal_drafts WHERE goal_id = ? ORDER BY created_at DESC').all(goalId)
    : db.prepare('SELECT * FROM goal_drafts WHERE goal_id IS NULL ORDER BY created_at DESC').all()
  ) as Record<string, unknown>[];
  return rows.map(rowToDraft);
}

/** Record what a cartridge produced. Stores a PROPOSAL; touches no goal. */
export function submitDraft(id: string, rawFields: unknown): GoalDraft | null {
  const draft = getDraft(id);
  if (!draft) return null;
  const fields = normalizeDraftFields(rawFields);
  db.prepare(
    `UPDATE goal_drafts SET status = ?, fields = ?, completed_at = ?, error = ? WHERE id = ?`,
  ).run(
    Object.keys(fields).length ? 'ready' : 'failed',
    JSON.stringify(fields),
    new Date().toISOString(),
    Object.keys(fields).length ? '' : 'the draft contained no usable fields',
    id,
  );
  return getDraft(id);
}

export function failDraft(id: string, error: string): void {
  db.prepare(`UPDATE goal_drafts SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
    .run(error, new Date().toISOString(), id);
}

export class DraftApplyError extends Error {}

/**
 * Write accepted fields onto the goal. THE ONLY path from a draft to goal state.
 *
 * Per-field by design: the caller names exactly which keys it accepts, so accepting a good
 * acceptance-criteria block never smuggles in a no-gos section the user did not read. Anything
 * not named is left alone, and a draft that has already been applied cannot be replayed.
 */
export function applyDraft(draftId: string, keys: string[]): GoalDraft {
  const draft = getDraft(draftId);
  if (!draft) throw new DraftApplyError('draft not found');
  if (!draft.goalId) throw new DraftApplyError('this draft is not attached to a goal');
  if (draft.status !== 'ready') throw new DraftApplyError(`draft is ${draft.status}, not ready`);
  if (draft.appliedAt) throw new DraftApplyError('draft has already been applied');

  const chosen = keys.filter((k) => BY_KEY.has(k) && draft.fields[k] !== undefined);
  if (chosen.length === 0) throw new DraftApplyError('no applicable fields were selected');

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of chosen) {
    const field = BY_KEY.get(key)!;
    const value = draft.fields[key]!;
    sets.push(`${field.column} = ?`);
    values.push(field.kind === 'keyResults' ? JSON.stringify(value) : (value as string));
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE goals SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, now, draft.goalId);
    db.prepare('UPDATE goal_drafts SET applied_at = ?, applied_fields = ? WHERE id = ?')
      .run(now, JSON.stringify(chosen), draftId);
  });
  tx();

  return getDraft(draftId)!;
}
