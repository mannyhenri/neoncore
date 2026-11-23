/**
 * THE LOGS — one stream, three kinds of line, each labelled with where it came from:
 *
 *   event     what every agent did: its hooks' events, from EVERY machine (read straight from the
 *             activity table, so nothing has to remember to copy them here)
 *   terminal  the output of the processes NeonCore runs in the background on THIS machine — the
 *             QA runner, commands run in a repo (terminalSink)
 *   neoncore  NeonCore's own console (installConsoleCapture) — warnings and errors are problems
 *
 * readLogs pages it newest-first with cursors (before = older, after = newer), filtered by kind,
 * problems only, a search, one source only, or hidden sources — all applied to the line as shown,
 * so a filter keeps exactly what it says. Terminal and NeonCore lines are kept in `log_lines`,
 * pruned to the newest LOG_KEEP.
 */
import { format } from 'node:util';
import db from '../db.js';

export type LogKind = 'event' | 'terminal' | 'neoncore';
export const LOG_KINDS: readonly LogKind[] = ['event', 'terminal', 'neoncore'];
/** A line before it is given its place in the stream. */
export type LogEntry = Omit<LogLine, keyof LogPlace>;
interface LogPlace {
  /** Where this line sits in the stream; pass as `before` / `after`. */
  cursor: string;
}
export interface LogLine extends LogPlace {
  at: string;
  kind: LogKind;
  /** The agent's repo name, the process, or 'NeonCore'. */
  source: string;
  engine: string;
  machine: string;
  level: 'info' | 'problem';
  text: string;
}
export interface LogSource { source: string; kind: LogKind; engine: string; machine: string; count: number }
export interface LogQuery {
  before?: string; after?: string; limit?: number;
  kinds?: readonly LogKind[]; problems?: boolean; q?: string;
  /** Show this source alone. */
  only?: string;
  /** Hide these sources. */
  hide?: readonly string[];
}
export interface LogPage { lines: LogLine[]; hasMore: boolean; sources: LogSource[] }

export const LOG_KEEP = 20_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS log_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT '',
    machine TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'info',
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_log_lines_at ON log_lines(at, id);
`);

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (s: string) => s.replace(ANSI, '').replace(/\r/g, '');
const PROBLEM = /\b(error|failed|failure|exception|refused|denied|fatal|crash(ed)?)\b/i;

let sinceprune = 0;
const insert = db.prepare('INSERT INTO log_lines (at, kind, source, engine, machine, level, text) VALUES (?,?,?,?,?,?,?)');
/** Keep a terminal or NeonCore line. */
export function recordLog(l: { kind: Exclude<LogKind, 'event'>; source: string; text: string; level?: 'info' | 'problem'; engine?: string; machine?: string; at?: string }): void {
  const text = clean(l.text).replace(/\s+$/, '');
  if (!text) return;
  insert.run(l.at ?? new Date().toISOString(), l.kind, l.source, l.engine ?? '', l.machine ?? '', l.level ?? (PROBLEM.test(text) ? 'problem' : 'info'), text);
  if (++sinceprune >= 1000) { sinceprune = 0; pruneLogs(); }
}

/** Only the newest `keep` terminal and NeonCore lines stay. */
export function pruneLogs(keep = LOG_KEEP): void {
  db.prepare('DELETE FROM log_lines WHERE id NOT IN (SELECT id FROM log_lines ORDER BY id DESC LIMIT ?)').run(keep);
}

/** A writer for a background process's output: whole lines go in as they complete; flush() the rest at the end. */
export function terminalSink(source: string): { write: (chunk: Buffer | string) => void; flush: () => void } {
  let partial = '';
  return {
    write(chunk) {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) { try { recordLog({ kind: 'terminal', source, text: line }); } catch { /* never break the process for a log */ } }
    },
    flush() { if (partial) { try { recordLog({ kind: 'terminal', source, text: partial }); } catch { /* ignore */ } partial = ''; } },
  };
}

/**
 * NeonCore's own console, kept as `neoncore` lines. The original output is untouched. Returns the
 * undo. Re-entrant writes (a log while logging) are printed but not kept.
 */
export function installConsoleCapture(target: Console = console): () => void {
  const methods = ['log', 'info', 'warn', 'error'] as const;
  const original = Object.fromEntries(methods.map((m) => [m, target[m]])) as Record<(typeof methods)[number], (...a: unknown[]) => void>;
  let busy = false;
  for (const m of methods) {
    target[m] = (...args: unknown[]) => {
      original[m].apply(target, args);
      if (busy) return;
      busy = true;
      try { recordLog({ kind: 'neoncore', source: 'NeonCore', text: format(...args), level: m === 'warn' || m === 'error' ? 'problem' : undefined }); } catch { /* the db may not be there */ } finally { busy = false; }
    };
  }
  return () => { for (const m of methods) target[m] = original[m]; };
}

// ── reading ───────────────────────────────────────────────────────────────────

interface Row { at: string; t: 'a' | 'l'; id: string; line: LogEntry }
const cursorOf = (r: Pick<Row, 'at' | 't' | 'id'>) => `${r.at}~${r.t}~${r.id}`;
function parseCursor(c: string | undefined): { at: string; t: string; id: string } | null {
  if (!c) return null;
  const [at, t, ...rest] = c.split('~');
  return at && t ? { at, t, id: rest.join('~') } : null;
}
const cmp = (a: Row, b: Row) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const pad = (n: number) => String(n).padStart(12, '0');

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
/** What an agent's event says, in one readable line (or a message's own lines). */
export function eventText(type: string, tool: string, rawInput: string): string {
  let input: unknown = rawInput;
  try { input = JSON.parse(rawInput); } catch { /* plain text */ }
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const summary = typeof input === 'string' ? input
    : str(o.command) || str(o.file_path) || str(o.path) || str(o.pattern) || str(o.url) || str(o.description) || str(o.prompt) || str(o.text) || str(Object.values(o).find((v) => typeof v === 'string'));
  if (type === 'assistant_message') return summary;
  if (type === 'user_command') return `› ${summary}`;
  const bad = /error|fail|denied/i.test(type);
  const head = tool || (type === 'tool_use' ? '' : type.replace(/_/g, ' '));
  const body = [head, summary.split('\n')[0].slice(0, 400)].filter(Boolean).join(' ');
  return bad ? `${body} — error` : body;
}

function activityRows(dir: 'asc' | 'desc', from: { at: string; t: string; id: string } | null, n: number): Row[] {
  const cond: string[] = []; const args: unknown[] = [];
  if (from) {
    // Strictly beyond the cursor, in the direction of travel: (timestamp, 'a', id) vs (at, t, id).
    const op = dir === 'desc' ? '<' : '>';
    const sameTOk = dir === 'desc' ? from.t > 'a' : from.t < 'a';
    cond.push(`(a.timestamp ${op} ? OR (a.timestamp = ? AND ${sameTOk ? '1' : from.t === 'a' ? `a.id ${op} ?` : '0'}))`);
    args.push(from.at, from.at);
    if (!sameTOk && from.t === 'a') args.push(from.id);
  }
  const rows = db.prepare(`
    SELECT a.id, a.event_type, a.tool_name, a.tool_input, a.tool_result, a.timestamp,
           COALESCE(NULLIF(g.repo_name, ''), g.name, 'an agent') AS source, COALESCE(g.agent_type, '') AS engine, COALESCE(g.machine, '') AS machine
    FROM activity a LEFT JOIN agents g ON g.id = a.agent_id
    ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
    ORDER BY a.timestamp ${dir}, a.id ${dir} LIMIT ?`).all(...args, n) as Record<string, string>[];
  return rows.map((r) => {
    const text = eventText(r.event_type, r.tool_name, r.tool_input);
    const problem = /error|fail|denied/i.test(r.event_type) || /"is_error"\s*:\s*true/.test(r.tool_result || '');
    return { at: r.timestamp, t: 'a' as const, id: r.id, line: { at: r.timestamp, kind: 'event' as const, source: r.source, engine: r.engine, machine: r.machine, level: problem ? 'problem' as const : 'info' as const, text } };
  });
}
function storedRows(dir: 'asc' | 'desc', from: { at: string; t: string; id: string } | null, n: number): Row[] {
  const cond: string[] = []; const args: unknown[] = [];
  if (from) {
    const op = dir === 'desc' ? '<' : '>';
    const sameTOk = dir === 'desc' ? from.t > 'l' : from.t < 'l';
    cond.push(`(at ${op} ? OR (at = ? AND ${sameTOk ? '1' : from.t === 'l' ? `id ${op} ?` : '0'}))`);
    args.push(from.at, from.at);
    if (!sameTOk && from.t === 'l') args.push(Number(from.id));
  }
  const rows = db.prepare(`SELECT * FROM log_lines ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY at ${dir}, id ${dir} LIMIT ?`).all(...args, n) as Record<string, string | number>[];
  return rows.map((r) => ({ at: String(r.at), t: 'l' as const, id: pad(Number(r.id)), line: {
    at: String(r.at), kind: r.kind as LogKind, source: String(r.source), engine: String(r.engine), machine: String(r.machine), level: r.level === 'problem' ? 'problem' as const : 'info' as const, text: String(r.text),
  } }));
}

export function readLogs(q: LogQuery = {}): LogPage {
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 200)));
  const dir: 'asc' | 'desc' = q.after ? 'asc' : 'desc';
  const kinds = new Set(q.kinds && q.kinds.length ? q.kinds : LOG_KINDS);
  const needle = (q.q ?? '').trim().toLowerCase();
  const hide = new Set(q.hide ?? []);
  const keep = (l: LogEntry) => kinds.has(l.kind) && (!q.problems || l.level === 'problem')
    && (!needle || l.text.toLowerCase().includes(needle) || l.source.toLowerCase().includes(needle))
    && (!q.only || l.source === q.only) && !hide.has(l.source);

  // A merge of the two tables in cursor order, refilled a batch at a time, filtered as it goes.
  const batch = Math.max(100, limit * 2);
  const tables = [
    { on: kinds.has('event'), read: activityRows, pos: parseCursor(q.after ?? q.before), buf: [] as Row[], done: false },
    { on: kinds.has('terminal') || kinds.has('neoncore'), read: storedRows, pos: parseCursor(q.after ?? q.before), buf: [] as Row[], done: false },
  ].filter((t) => t.on);
  const refill = (t: (typeof tables)[number]) => {
    if (t.done || t.buf.length) return;
    const rows = t.read(dir, t.pos, batch);
    if (rows.length < batch) t.done = true;
    if (rows.length) t.pos = { at: rows[rows.length - 1].at, t: rows[rows.length - 1].t, id: rows[rows.length - 1].id };
    t.buf = rows;
  };
  const out: Row[] = [];
  while (out.length <= limit) {
    for (const t of tables) refill(t);
    const live = tables.filter((t) => t.buf.length);
    if (!live.length) break;
    const next = live.reduce((best, t) => (dir === 'desc' ? cmp(t.buf[0], best.buf[0]) > 0 : cmp(t.buf[0], best.buf[0]) < 0) ? t : best);
    const row = next.buf.shift()!;
    if (keep(row.line)) out.push(row);
  }
  const hasMore = out.length > limit;
  const page = out.slice(0, limit);
  if (dir === 'desc') page.reverse();
  return { lines: page.map((r) => ({ cursor: cursorOf(r), ...r.line })), hasMore, sources: logSources() };
}

export function logSources(): LogSource[] {
  const events = db.prepare(`
    SELECT COALESCE(NULLIF(g.repo_name, ''), g.name, 'an agent') AS source, COALESCE(g.agent_type, '') AS engine, COALESCE(g.machine, '') AS machine, COUNT(*) AS count
    FROM activity a LEFT JOIN agents g ON g.id = a.agent_id GROUP BY a.agent_id`).all() as { source: string; engine: string; machine: string; count: number }[];
  const stored = db.prepare('SELECT source, kind, MAX(engine) AS engine, MAX(machine) AS machine, COUNT(*) AS count FROM log_lines GROUP BY source, kind').all() as LogSource[];
  // One chip per source: an agent on two machines is two agents, but one repo name — they add up.
  const m = new Map<string, LogSource>();
  for (const e of events) {
    const k = `event|${e.source}`;
    const had = m.get(k);
    m.set(k, had ? { ...had, count: had.count + e.count } : { source: e.source, kind: 'event', engine: e.engine, machine: e.machine, count: e.count });
  }
  for (const s of stored) m.set(`${s.kind}|${s.source}`, { ...s, engine: s.engine ?? '', machine: s.machine ?? '' });
  return [...m.values()].sort((a, b) => LOG_KINDS.indexOf(a.kind) - LOG_KINDS.indexOf(b.kind) || a.source.localeCompare(b.source));
}
