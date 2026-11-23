/**
 * LOGS — every agent's events (from every machine), the terminal output of what NeonCore runs in
 * the background on this machine, and NeonCore's own console, in one pane, each line labelled with
 * where it came from (server lib/log-stream.ts).
 *
 * A chip per source: click to hide or show it, double-click to show only that one. Filters for the
 * three kinds, "Problems only", a search and Pause. It follows the newest line until you scroll up;
 * scrolling back to the top loads older lines.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogKind, LogLine, LogPage, LogSource } from '../types';
import { api } from '../lib/api';

export const LOG_POLL_MS = 2000;
const PAGE = 200;
const KIND_LABEL: Record<LogKind, string> = { event: 'Events', terminal: 'Terminal', neoncore: 'NeonCore' };
const KIND_GLYPH: Record<LogKind, string> = { event: '◆', terminal: '┃', neoncore: '⚙' };
const PALETTE = ['#56D364', '#3FB4FF', '#B79CFF', '#2EE6D6', '#F5C542', '#FF8A3D', '#FF7AC8', '#8FE3F0'];
/** A source's colour: the same every time, NeonCore always lilac. */
export function sourceColour(source: string): string {
  if (source === 'NeonCore') return '#B79CFF';
  let h = 0;
  for (const ch of source) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export interface LogFilters { kinds: LogKind[]; problems: boolean; q: string; only: string; hide: string[] }
const ALL_KINDS: LogKind[] = ['event', 'terminal', 'neoncore'];
const asParams = (f: LogFilters) => ({ kinds: f.kinds.length === ALL_KINDS.length ? undefined : f.kinds, problems: f.problems || undefined, q: f.q.trim() || undefined, only: f.only || undefined, hide: f.hide.length ? f.hide : undefined });

export function LogsPage({ pollMs = LOG_POLL_MS }: { pollMs?: number }) {
  const [filters, setFilters] = useState<LogFilters>({ kinds: ALL_KINDS, problems: false, q: '', only: '', hide: [] });
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const loadingOlder = useRef(false);
  const linesRef = useRef<LogLine[]>([]);
  linesRef.current = lines;

  // The search applies a moment after typing stops.
  useEffect(() => { const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 250); return () => clearTimeout(t); }, [search]);

  const take = useCallback((p: LogPage) => { if (Array.isArray(p.sources)) setSources(p.sources); }, []);
  // The newest page, whenever the filters change.
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.getLogs({ ...asParams(filters), limit: PAGE }))
      .then((p) => { if (!alive || !p) return; setLines(p.lines); setHasMore(p.hasMore); take(p); setError(''); setFollow(true); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [filters, take]);
  // What came since, while not paused.
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      const last = linesRef.current[linesRef.current.length - 1];
      Promise.resolve(api.getLogs({ ...asParams(filters), limit: 500, ...(last ? { after: last.cursor } : {}) }))
        .then((p) => { if (!p) return; take(p); if (p.lines.length) setLines((ls) => (last ? [...ls, ...p.lines] : p.lines).slice(-5000)); })
        .catch(() => { /* the next tick tries again */ });
    }, pollMs);
    return () => clearInterval(t);
  }, [paused, filters, pollMs, take]);
  // Following: the newest line stays in view.
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, follow]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
    if (el.scrollTop < 40 && hasMore && !loadingOlder.current && lines.length) {
      loadingOlder.current = true;
      const before = el.scrollHeight;
      Promise.resolve(api.getLogs({ ...asParams(filters), limit: PAGE, before: lines[0].cursor }))
        .then((p) => {
          if (!p) return;
          setHasMore(p.hasMore);
          setLines((ls) => [...p.lines, ...ls]);
          // Keep the line you were reading where it was.
          requestAnimationFrame(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight - before + el.scrollTop; });
        })
        .catch(() => { /* try again on the next scroll */ })
        .finally(() => { loadingOlder.current = false; });
    }
  };

  const toggleSource = (s: string) => setFilters((f) => (f.only ? { ...f, only: '' } : { ...f, hide: f.hide.includes(s) ? f.hide.filter((x) => x !== s) : [...f.hide, s] }));
  const soloSource = (s: string) => setFilters((f) => ({ ...f, only: f.only === s ? '' : s, hide: [] }));
  const toggleKind = (k: LogKind) => setFilters((f) => {
    const on = f.kinds.includes(k);
    const kinds = on ? f.kinds.filter((x) => x !== k) : [...f.kinds, k];
    return { ...f, kinds: kinds.length ? ALL_KINDS.filter((x) => kinds.includes(x)) : ALL_KINDS };
  });
  const shownSource = (s: string) => (filters.only ? filters.only === s : !filters.hide.includes(s));
  const allShown = !filters.only && filters.hide.length === 0;
  const chipBase = 'h-10 px-4 rounded-[10px] border text-[14px] font-semibold inline-flex items-center gap-2 transition-colors';
  const visibleSources = useMemo(() => sources, [sources]);

  return (
    <div data-logs className="h-full flex flex-col gap-3 px-6 py-5 min-h-0">
      <div>
        <h2 className="font-display text-[26px] font-semibold text-white">Logs</h2>
        <p className="text-[14px] text-gray-400">Every session&apos;s log and NeonCore&apos;s own, in one pane — each line labelled with where it came from.</p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the logs…" aria-label="Search the logs" className="glass-input h-10 px-3 rounded-[10px] text-[14px] w-[300px] max-w-full" />
        <button data-logs-problems aria-pressed={filters.problems} onClick={() => setFilters((f) => ({ ...f, problems: !f.problems }))}
          className={`${chipBase} ${filters.problems ? 'border-amber-300/70 bg-amber-300/15 text-amber-100' : 'border-white/[0.12] text-gray-200 hover:border-white/30'}`}>⚠ Problems only</button>
        <button data-logs-pause aria-pressed={paused} onClick={() => setPaused((p) => !p)}
          className={`${chipBase} ${paused ? 'border-neon-400/70 bg-neon-500/15 text-neon-100' : 'border-white/[0.12] text-gray-200 hover:border-white/30'}`}>{paused ? '▶ Resume' : '❚❚ Pause'}</button>
      </div>
      <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Sources">
        <button data-logs-all aria-pressed={allShown} onClick={() => setFilters((f) => ({ ...f, only: '', hide: [] }))}
          className={`${chipBase} ${allShown ? 'border-white/30 bg-white/[0.08] text-white' : 'border-white/[0.12] text-gray-400'}`}>All sources</button>
        {visibleSources.map((s) => {
          const on = shownSource(s.source);
          const c = sourceColour(s.source);
          return (
            <button key={`${s.kind}|${s.source}`} data-log-source={s.source} data-shown={on} aria-pressed={on}
              title={`${s.source}${s.engine ? ` · ${s.engine}` : ''}${s.machine ? ` · ${s.machine}` : ''} — click to hide, double-click to show it alone`}
              onClick={() => toggleSource(s.source)} onDoubleClick={() => soloSource(s.source)}
              className={`${chipBase} ${on ? 'border-white/[0.16] bg-white/[0.04]' : 'border-white/[0.08] opacity-45'}`} style={{ color: on ? c : undefined }}>
              <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />
              {s.source}
              {s.engine && <span className="font-mono text-[12px] text-gray-400">{s.engine}</span>}
              <span className="font-mono text-[12px] text-gray-500 tabular-nums">{s.count}</span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Kinds">
        {ALL_KINDS.map((k) => {
          const on = filters.kinds.includes(k);
          return (
            <button key={k} data-log-kind={k} aria-pressed={on} onClick={() => toggleKind(k)}
              className={`${chipBase} ${on ? 'border-white/[0.16] bg-white/[0.04] text-gray-100' : 'border-white/[0.08] text-gray-500'}`}>
              <span aria-hidden="true">{KIND_GLYPH[k]}</span>{KIND_LABEL[k]}
            </button>
          );
        })}
      </div>
      {error && <p className="text-[13px] text-ember-300">{error}</p>}
      <div ref={box} data-logs-lines onScroll={onScroll} className="flex-1 min-h-[240px] overflow-y-auto rounded-[14px] border border-white/[0.1] bg-[rgba(6,10,20,0.85)] px-4 py-2 font-mono text-[14px]">
        {hasMore && <p data-logs-older className="text-center text-[12px] text-gray-500 py-1">Scroll up for older lines</p>}
        {lines.length === 0 && <p className="text-gray-500 py-6 text-center">{filters.problems || filters.q || filters.only || filters.hide.length ? 'No line matches.' : 'Nothing logged yet.'}</p>}
        {lines.map((l) => (
          <div key={l.cursor} data-log-line={l.kind} data-level={l.level} className="grid grid-cols-[78px_200px_18px_1fr] gap-x-3 py-[3px] leading-snug">
            <span className="text-gray-500 tabular-nums">{time(l.at)}</span>
            <span className="truncate font-semibold" style={{ color: sourceColour(l.source) }} title={`${l.source}${l.engine ? ` · ${l.engine}` : ''}${l.machine ? ` · ${l.machine}` : ''}`}>{l.source}</span>
            <span aria-hidden="true" className="text-gray-500">{KIND_GLYPH[l.kind]}</span>
            <span className={`whitespace-pre-wrap break-words ${l.level === 'problem' ? 'text-[#FFB27A]' : 'text-gray-200'}`}>{l.text}</span>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-gray-500">◆ events come from every cartridge&apos;s hooks, on every machine · ┃ terminal output from what NeonCore runs in the background on this machine · ⚙ NeonCore&apos;s own log.{follow ? '' : ' Scrolled back — following stops until you return to the bottom.'}</p>
    </div>
  );
}
