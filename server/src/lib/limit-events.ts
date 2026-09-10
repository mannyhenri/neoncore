/**
 * Usage-limit signals — where the wall was, and what had been spent when we hit it.
 *
 * Nothing in NeonCore knows what a plan's real ceiling is. The badge divides a budget the user
 * typed, and Anthropic publishes no remaining-quota API, so the only way to learn the true
 * limit is to notice where it was each time it was reached. GAS-013 turns these rows into a
 * measured ceiling; this is pure capture, and it has to start recording before it can start
 * answering.
 *
 * ── ONLY A NOTIFICATION MAY FIRE THIS ─────────────────────────────────────────────────
 * Earlier today a loop terminated because an agent WROTE ABOUT its stop marker and a substring
 * match read the sentence as the signal — twice, once from an agent explicitly saying it was
 * refusing to signal. The same trap is here: "we hit the usage limit yesterday" in a report
 * must not record a limit event. So the event TYPE is the gate, checked before any text is
 * examined. Notification text is Claude Code's own; every other event carries prose.
 *
 * A pattern carries the `example` it was written for, and the test asserts each one still
 * matches it — a regex that has drifted away from the message it was meant to catch is worse
 * than no regex, because it reads as coverage.
 */

export interface LimitPattern {
  re: RegExp;
  /** A short, stable name for the marker — what a recorded row says about WHY it exists. */
  marker: string;
  /** Real text this was written against; the registry test requires it to still match. */
  example: string;
}

/** THE REGISTRY. Add a pattern here and the tests cover it without being edited. */
export const LIMIT_PATTERNS: LimitPattern[] = [
  { re: /\busage\s+limit\s+reached\b/i, marker: 'usage-limit-reached',
    example: 'Claude usage limit reached. Your limit will reset at 3pm.' },
  { re: /\bapproaching\s+usage\s+limit\b/i, marker: 'approaching-usage-limit',
    example: 'Approaching usage limit' },
  { re: /\breached\s+your\s+(?:usage\s+)?limit\b/i, marker: 'reached-your-limit',
    example: "You've reached your usage limit for this 5-hour window." },
  { re: /\brate\s*limit(?:ed|ing)?\b/i, marker: 'rate-limited',
    example: 'Request was rate limited — retrying shortly.' },
  { re: /\b429\b/, marker: 'http-429',
    example: 'API error 429: too many requests' },
];

/** Only these events carry text Claude Code wrote. Everything else is an agent talking. */
const MACHINE_EVENTS = new Set(['notification']);

/**
 * The marker name if this event is a genuine usage-limit signal, else null.
 *
 * Returns the MARKER rather than the message: the message carries a reset time and wording
 * that change between releases, and a row should record what kind of wall was hit, not one
 * day's phrasing of it.
 */
export function detectLimitSignal(eventType: string | undefined, payload: string | undefined | null): string | null {
  if (!eventType || !MACHINE_EVENTS.has(eventType.trim())) return null;
  const text = (payload || '').trim();
  if (!text) return null;
  return LIMIT_PATTERNS.find((p) => p.re.test(text))?.marker ?? null;
}

import db from '../db.js';
import { randomUUID } from 'crypto';
import { totalCostUsd, type UsageRow } from './pricing.js';

export interface LimitEvent {
  id: string;
  agent_id: string;
  marker: string;
  detected_at: string;
  tokens_at_event: number;
  cost_usd_at_event: number;
}

/** A burst of notifications about one wall is one observation, not many. */
const DEDUPE_MS = 60_000;

/**
 * Record a limit observation with the spend AT THIS MOMENT.
 *
 * The snapshot is the entire value of the row: `session_usage` keeps growing, so "what had
 * been spent when the wall appeared" cannot be reconstructed afterwards. Returns null when the
 * observation is a duplicate of one already recorded for the same agent and marker inside the
 * dedupe window — Claude Code emits the same notification repeatedly while a limit holds, and
 * counting each one would make one wall look like twenty.
 */
export function recordLimitEvent(agentId: string, marker: string, atIso: string): LimitEvent | null {
  const at = Date.parse(atIso);
  const since = new Date(at - DEDUPE_MS).toISOString();
  const dupe = db.prepare(
    'SELECT id FROM limit_events WHERE agent_id = ? AND marker = ? AND detected_at >= ? AND detected_at <= ? LIMIT 1',
  ).get(agentId, marker, since, atIso);
  if (dupe) return null;

  // Everything this agent has spent, priced by the same table the badge uses.
  const rows = db.prepare(
    'SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model FROM session_usage WHERE agent_id = ?',
  ).all(agentId) as UsageRow[];
  const tokens = rows.reduce(
    (n, r) => n + (r.input_tokens || 0) + (r.output_tokens || 0)
      + (r.cache_read_tokens || 0) + (r.cache_creation_tokens || 0), 0);

  const row: LimitEvent = {
    id: randomUUID(), agent_id: agentId, marker, detected_at: atIso,
    tokens_at_event: tokens, cost_usd_at_event: totalCostUsd(rows),
  };
  db.prepare(
    'INSERT INTO limit_events (id, agent_id, marker, detected_at, tokens_at_event, cost_usd_at_event) VALUES (?,?,?,?,?,?)',
  ).run(row.id, row.agent_id, row.marker, row.detected_at, row.tokens_at_event, row.cost_usd_at_event);
  return row;
}

export function limitEventsSince(sinceIso: string): LimitEvent[] {
  return db.prepare('SELECT * FROM limit_events WHERE detected_at >= ? ORDER BY detected_at').all(sinceIso) as LimitEvent[];
}
