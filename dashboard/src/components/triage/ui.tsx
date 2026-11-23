/** Small Night Glass pieces the Triage tabs share. The class names are the QA section's, so the two read alike. */
import type { ReactNode } from 'react';
import { TriageArt, type TriageArtName } from './art';
import { STATE_LABEL } from './stages';

export { CARD, INPUT, BTN_PRIMARY, BTN_GHOST, ErrorNote, when } from '../qa/ui';
import { CARD } from '../qa/ui';

const STATE_CLS: Record<string, { cls: string; dot: string }> = {
  queued: { cls: 'bg-white/[0.06] text-gray-300', dot: 'bg-gray-400' },
  working: { cls: 'bg-neon-500/15 text-neon-200', dot: 'bg-neon-400 shadow-[0_0_8px_rgba(90,174,255,0.9)] animate-pulse' },
  waiting_reporter: { cls: 'bg-ember-500/15 text-ember-300', dot: 'bg-ember-400' },
  waiting_review: { cls: 'bg-neon-500/15 text-neon-200', dot: 'bg-neon-400' },
  handed_over: { cls: 'bg-yellow-500/15 text-yellow-100', dot: 'bg-yellow-300' },
  labelled: { cls: 'bg-white/[0.06] text-gray-300', dot: 'bg-gray-300' },
  fixed: { cls: 'bg-emerald-500/15 text-emerald-200', dot: 'bg-emerald-400' },
  released: { cls: 'bg-emerald-500/15 text-emerald-200', dot: 'bg-emerald-400' },
  paused: { cls: 'bg-white/[0.06] text-gray-300', dot: 'bg-gray-500' },
  error: { cls: 'bg-red-500/15 text-red-200', dot: 'bg-red-400' },
};

export function StatePill({ state }: { state: string }) {
  const s = STATE_CLS[state] ?? { cls: 'bg-white/[0.06] text-gray-300', dot: 'bg-gray-400' };
  return (
    <span data-triage-state={state} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${s.cls}`}>
      <span className={`w-[7px] h-[7px] rounded-full ${s.dot}`} aria-hidden="true" />
      {STATE_LABEL[state] ?? (state || '—')}
    </span>
  );
}

export function Empty({ art, title, children }: { art: TriageArtName; title: string; children?: ReactNode }) {
  return (
    <div data-triage-empty className={`${CARD} flex flex-col sm:flex-row items-center gap-5`}>
      <TriageArt name={art} className="w-40 shrink-0" />
      <div className="space-y-2 text-center sm:text-left">
        <h3 className="font-display text-lg text-gray-100">{title}</h3>
        {children && <div className="text-[14px] text-gray-400 space-y-2">{children}</div>}
      </div>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div data-triage-loading role="status" className={`${CARD} text-[14px] text-gray-400 flex items-center gap-2`}>
      <span className="w-[7px] h-[7px] rounded-full bg-neon-400 animate-pulse" aria-hidden="true" />
      Loading {what}…
    </div>
  );
}

/** "3h ago", "2d ago" — how long since a report was filed. */
export function since(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Cartridge minutes: what an issue costs here (the work runs on cartridges, not a per-call API). */
export const agentMin = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n < 1 ? '<1 min' : `${Math.round(n)} min`;
