/**
 * A calendar date picker that matches the dashboard.
 *
 * Replaces `<input type="date">`, whose calendar button is a near-invisible dark glyph on this
 * theme and which shows "mm/dd/yyyy" to everyone. Value in and out is 'YYYY-MM-DD' ('' = unset),
 * the same string the goal API stores, so callers swap it in without changing anything else.
 *
 * Keyboard: Enter/Space/↓ opens; arrows move a day/week; PageUp/PageDown a month; Enter picks;
 * Escape closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  WEEKDAYS, addDays, addMonths, displayDate, monthGrid, monthLabel, parseISODate, todayISO,
} from '../lib/calendar';

export function DatePicker({ value, onChange, placeholder = 'Pick a date', id, className = '' }: {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const today = todayISO();
  const start = parseISODate(value) ?? parseISODate(today)!;
  const [view, setView] = useState({ year: start.year, month: start.month });
  const [focus, setFocus] = useState(value || today);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Opening shows the selected month (or this one), with the selected day focused.
  useEffect(() => {
    if (!open) return;
    const p = parseISODate(value) ?? parseISODate(today)!;
    setView({ year: p.year, month: p.month });
    setFocus(value || today);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (open) gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focus}"]`)?.focus();
  }, [open, focus, view]);

  const days = useMemo(() => monthGrid(view.year, view.month), [view]);

  const pick = (iso: string) => { onChange(iso); setOpen(false); };
  const moveFocus = (iso: string) => {
    const p = parseISODate(iso)!;
    setFocus(iso);
    if (p.year !== view.year || p.month !== view.month) setView({ year: p.year, month: p.month });
  };
  const onGridKey = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) { e.preventDefault(); moveFocus(addDays(focus, step[e.key])); }
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const m = addMonths(view.year, view.month, e.key === 'PageUp' ? -1 : 1);
      setView(m);
      const p = parseISODate(focus)!;
      const last = new Date(m.year, m.month + 1, 0).getDate();
      setFocus(`${m.year}-${String(m.month + 1).padStart(2, '0')}-${String(Math.min(p.day, last)).padStart(2, '0')}`);
    } else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
        className="w-full flex items-center justify-between gap-2 bg-black/30 border border-white/10 rounded-md px-2.5 py-1.5 text-[13px] text-left focus:outline-none focus:border-violet-500/60 hover:border-white/20"
      >
        <span className={value ? 'text-gray-200' : 'text-gray-600'}>{value ? displayDate(value) : placeholder}</span>
        <svg className="w-4 h-4 text-violet-300 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15" rx="2" />
          <path strokeLinecap="round" d="M3.5 9.5h17M8 3v4M16 3v4" />
        </svg>
      </button>

      {open && (
        <div role="dialog" aria-label="Choose a date" className="absolute z-50 mt-1 w-64 rounded-lg border border-white/10 bg-[#15131f] shadow-2xl p-2.5">
          <div className="flex items-center justify-between mb-2">
            <button type="button" aria-label="Previous month" onClick={() => setView(addMonths(view.year, view.month, -1))}
              className="w-7 h-7 rounded hover:bg-white/10 text-gray-400 hover:text-gray-100">‹</button>
            <span className="text-[13px] text-gray-200 font-medium">{monthLabel(view.year, view.month)}</span>
            <button type="button" aria-label="Next month" onClick={() => setView(addMonths(view.year, view.month, 1))}
              className="w-7 h-7 rounded hover:bg-white/10 text-gray-400 hover:text-gray-100">›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {WEEKDAYS.map((w) => <span key={w} className="text-[10px] text-gray-600 text-center">{w}</span>)}
          </div>
          <div ref={gridRef} role="grid" className="grid grid-cols-7 gap-0.5" onKeyDown={onGridKey}>
            {days.map((d) => {
              const selected = d.iso === value;
              const isToday = d.iso === today;
              return (
                <button
                  key={d.iso}
                  type="button"
                  data-iso={d.iso}
                  tabIndex={d.iso === focus ? 0 : -1}
                  aria-label={displayDate(d.iso)}
                  aria-selected={selected}
                  onClick={() => pick(d.iso)}
                  className={`h-8 rounded text-[12px] transition-colors focus:outline-none focus:ring-1 focus:ring-violet-400 ${
                    selected ? 'bg-violet-600 text-white'
                      : isToday ? 'border border-violet-500/60 text-violet-200 hover:bg-white/10'
                      : d.inMonth ? 'text-gray-300 hover:bg-white/10' : 'text-gray-600 hover:bg-white/5'
                  }`}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/[0.06]">
            <button type="button" onClick={() => pick(today)} className="text-[11px] text-violet-300 hover:text-violet-200">Today</button>
            {value && <button type="button" onClick={() => pick('')} className="text-[11px] text-gray-500 hover:text-gray-300">Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}
