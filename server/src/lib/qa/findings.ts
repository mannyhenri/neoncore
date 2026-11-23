/**
 * EXPLORER FINDINGS — each bug once, however many paths reached it (scope §3.1, "Deduplicates").
 *
 * The signature is the kind, the page's path with ids and numbers taken out, and the title/error
 * with its variable parts (numbers, quoted values, hashes) taken out. Reaching the same broken
 * button from ten pages is ten paths, one signature: the first creates the finding and its
 * reproduction test, every repeat only bumps `seen_count`.
 */
import { createHash, randomUUID } from 'crypto';
import db from '../../db.js';
import { createTest, emitEvent } from './store.js';
import { QaError, SEVERITIES, type Severity } from './types.js';

const nowIso = () => new Date().toISOString();

export interface QaFinding {
  id: string; targetId: string; runId: string; signature: string; severity: Severity; kind: string;
  title: string; detail: string; page: string; steps: string[]; screenshot: string; reproTestId: string;
  status: 'open' | 'dismissed' | 'fixed'; seenCount: number; createdAt: string; lastSeenAt: string;
}

export interface FindingInput {
  severity?: string; kind?: string; title?: string; detail?: string; page?: string;
  steps?: unknown; screenshot?: string; sentences?: unknown;
}

/** The page's path, without host, query, hash, ids or numbers: /reports/42/edit → /reports/:id/edit. */
export function normalisePage(page: string): string {
  let p = (page || '').trim();
  try { if (/^https?:/i.test(p)) p = new URL(p).pathname; } catch { /* keep as given */ }
  p = p.split(/[?#]/)[0] || '/';
  return p.toLowerCase().split('/').map((seg) => (/^\d+$|^[0-9a-f-]{8,}$/i.test(seg) ? ':id' : seg)).join('/').replace(/\/+$/, '') || '/';
}

export function normaliseText(text: string): string {
  return (text || '').toLowerCase()
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\b[0-9a-f]{8,}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ').trim();
}

export function findingSignature(f: Pick<FindingInput, 'kind' | 'page' | 'title'>): string {
  return createHash('sha256').update([normaliseText(f.kind ?? ''), normalisePage(f.page ?? ''), normaliseText(f.title ?? '')].join('|')).digest('hex').slice(0, 24);
}

function toFinding(r: Record<string, unknown>): QaFinding {
  const steps = (() => { try { return JSON.parse(String(r.steps)) as string[]; } catch { return []; } })();
  return {
    id: String(r.id), targetId: String(r.target_id), runId: String(r.run_id), signature: String(r.signature),
    severity: String(r.severity) as Severity, kind: String(r.kind), title: String(r.title), detail: String(r.detail),
    page: String(r.page), steps, screenshot: String(r.screenshot), reproTestId: String(r.repro_test_id),
    status: String(r.status) as QaFinding['status'], seenCount: Number(r.seen_count),
    createdAt: String(r.created_at), lastSeenAt: String(r.last_seen_at),
  };
}

export function listFindings(targetId?: string): QaFinding[] {
  const rows = targetId
    ? db.prepare('SELECT * FROM qa_findings WHERE target_id = ? ORDER BY created_at DESC').all(targetId)
    : db.prepare('SELECT * FROM qa_findings ORDER BY created_at DESC').all();
  return (rows as Record<string, unknown>[]).map(toFinding);
}
export function getFinding(id: string): QaFinding | null {
  const r = db.prepare('SELECT * FROM qa_findings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toFinding(r) : null;
}
export function setFindingStatus(id: string, status: string): QaFinding {
  if (!['open', 'dismissed', 'fixed'].includes(status)) throw new QaError('status must be open, dismissed or fixed');
  if (!getFinding(id)) throw new QaError('finding not found', 404);
  db.prepare('UPDATE qa_findings SET status = ? WHERE id = ?').run(status, id);
  return getFinding(id)!;
}

/**
 * Record one finding: a new signature creates it and its reproduction test; a known one is
 * counted again. Returns the finding and whether it was new.
 */
export function recordFinding(targetId: string, runId: string, input: FindingInput): { finding: QaFinding; created: boolean } {
  const title = String(input.title ?? '').trim();
  if (!title) throw new QaError('a finding needs a title');
  const severity = (SEVERITIES as readonly string[]).includes(String(input.severity)) ? input.severity as Severity : 'medium';
  const signature = findingSignature(input);
  const now = nowIso();
  const existing = db.prepare('SELECT id FROM qa_findings WHERE target_id = ? AND signature = ?').get(targetId, signature) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE qa_findings SET seen_count = seen_count + 1, last_seen_at = ? WHERE id = ?').run(now, existing.id);
    return { finding: getFinding(existing.id)!, created: false };
  }
  const steps = Array.isArray(input.steps) ? input.steps.map(String).filter(Boolean) : [];
  const id = randomUUID();
  db.prepare(`INSERT INTO qa_findings (id, target_id, run_id, signature, severity, kind, title, detail, page, steps, screenshot, created_at, last_seen_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, targetId, runId, signature, severity, String(input.kind ?? ''), title, String(input.detail ?? ''),
      normalisePage(String(input.page ?? '')), JSON.stringify(steps), String(input.screenshot ?? ''), now, now);
  // Its reproduction test: the cartridge's sentences, or the steps it took.
  const sentences = Array.isArray(input.sentences) && input.sentences.length ? input.sentences : steps;
  if (sentences.length) {
    try {
      const test = createTest({ targetId, name: `Repro: ${title}`.slice(0, 120), sentences }, { source: 'explorer', findingId: id });
      db.prepare('UPDATE qa_findings SET repro_test_id = ? WHERE id = ?').run(test.id, id);
    } catch { /* a finding without a usable reproduction is still a finding */ }
  }
  const finding = getFinding(id)!;
  emitEvent('qa_finding_added', finding);
  return { finding, created: true };
}
