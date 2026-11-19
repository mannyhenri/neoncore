/**
 * WHAT A FINISHED AGENT SAID — two or three lines over its head, until you click it.
 *
 * The summary is EXTRACTED from the agent's last message, not rewritten: if the message
 * carries a work-standard completion block (NEONCORE-DONE) its scope / verify / deferred
 * lines are the summary; otherwise it is the first sentences of the message with code and
 * markdown stripped. Nothing is invented, so the bubble can never say more than the agent did.
 *
 * Note: the server keeps only the first 500 characters of a last message
 * (server/src/routes/agents.ts), so a completion block at the END of a long message is not
 * in what the dashboard receives — the summary then falls back to the opening sentences.
 */
export const SUMMARY_MAX_LINES = 3;
export const SUMMARY_MAX_CHARS = 120;

const clip = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= SUMMARY_MAX_CHARS ? t : `${t.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
};

/** scope / verify / deferred from a completion block, or null when there is none. */
function reportLines(message: string): string[] | null {
  const at = message.indexOf('NEONCORE-DONE');
  if (at < 0) return null;
  const field = (name: string) => message.slice(at).match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))?.[1]?.replace(/`+$/, '').trim() ?? '';
  const scope = field('scope');
  const verify = field('verify');
  const deferred = field('deferred');
  const lines = [
    scope && `Scope ${scope}`,
    verify && `Verified: ${verify}`,
    deferred && (/^none\.?$/i.test(deferred) ? 'Nothing deferred' : `Deferred: ${deferred}`),
  ].filter((l): l is string => Boolean(l));
  return lines.length > 0 ? lines.map(clip) : null;
}

/** True when the summary comes from a completion block (shown one field per line). */
export function isReport(message: string): boolean {
  return reportLines(message ?? '') !== null;
}

export function summarize(message: string): string[] {
  const raw = message ?? '';
  const report = reportLines(raw);
  if (report) return report.slice(0, SUMMARY_MAX_LINES);

  const text = raw
    .replace(/```[\s\S]*?(```|$)/g, '\n')              // code blocks, closed or cut off
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, '')               // headings are labels, not content
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')          // links and images → their text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')          // list markers
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~#[\]]/g, '');
  const sentences = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
  return sentences.slice(0, SUMMARY_MAX_LINES).map(clip);
}

// ── Read / unread ──────────────────────────────────────────────────────────────────────

const READ_KEY = 'neoncore.world.read';

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

/** Identifies one message of one session; '' when there is nothing to read. */
export function messageId(sessionId: string, message: string): string {
  const text = (message ?? '').trim();
  return text ? `${sessionId}:${hash(text)}` : '';
}

/** Which message each cartridge's bubble was last dismissed at. */
export function loadRead(): Map<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? '{}') as Record<string, unknown>;
    return new Map(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return new Map();
  }
}

export function markRead(key: string, id: string): Map<string, string> {
  const next = loadRead();
  next.set(key, id);
  try { localStorage.setItem(READ_KEY, JSON.stringify(Object.fromEntries(next))); } catch { /* won't persist */ }
  return next;
}

export function isUnread(read: ReadonlyMap<string, string>, key: string, id: string): boolean {
  return id !== '' && read.get(key) !== id;
}
