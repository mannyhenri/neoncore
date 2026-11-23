/** Small Night Glass pieces the QA tabs share. */
import type { ReactNode } from 'react';
import { QaArt, type QaArtName } from './art';
import type { QaAction, QaLocator, QaRunStatus, QaSeverity, QaTestSource } from './types';

export const CARD = 'rounded-[18px] bg-gl-surface border border-white/[0.08] p-4';
export const INPUT = 'glass-input w-full rounded-[10px] bg-gl-code border border-white/[0.1] px-3 h-10 text-[14px] text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-neon-500/60';
export const BTN_PRIMARY = 'btn-primary h-10 px-4 rounded-[10px] text-[13px] font-semibold disabled:opacity-50';
export const BTN_GHOST = 'btn-ghost h-10 px-3.5 rounded-[10px] text-[13px] font-semibold text-gray-300 border border-white/[0.12] hover:text-gray-100 hover:bg-white/[0.04] disabled:opacity-50';

const STATUS: Record<QaRunStatus, { label: string; cls: string; dot: string }> = {
  queued: { label: 'Queued', cls: 'bg-white/[0.06] text-gray-300', dot: 'bg-gray-400' },
  dispatched: { label: 'Sent to cartridge', cls: 'bg-neon-500/15 text-neon-200', dot: 'bg-neon-400 shadow-[0_0_8px_rgba(90,174,255,0.9)]' },
  running: { label: 'Running', cls: 'bg-neon-500/15 text-neon-200', dot: 'bg-neon-400 shadow-[0_0_8px_rgba(90,174,255,0.9)] animate-pulse' },
  waiting: { label: 'With the cartridge', cls: 'bg-neon-500/15 text-neon-200', dot: 'bg-neon-400 shadow-[0_0_8px_rgba(90,174,255,0.9)] animate-pulse' },
  completed: { label: 'Completed', cls: 'bg-emerald-500/15 text-emerald-200', dot: 'bg-emerald-400' },
  passed: { label: 'Passed', cls: 'bg-emerald-500/15 text-emerald-200', dot: 'bg-emerald-400' },
  passed_with_repair: { label: 'Passed with repair', cls: 'bg-ember-500/15 text-ember-300', dot: 'bg-ember-400' },
  failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-200', dot: 'bg-red-400' },
  error: { label: 'Error', cls: 'bg-red-500/15 text-red-200', dot: 'bg-red-400' },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status as QaRunStatus] ?? { label: status || '—', cls: 'bg-white/[0.06] text-gray-300', dot: 'bg-gray-400' };
  return (
    <span data-qa-status={status} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${s.cls}`}>
      <span className={`w-[7px] h-[7px] rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

const SOURCE: Record<QaTestSource, string> = {
  manual: 'border-white/[0.16] text-gray-300',
  explorer: 'border-neon-500/50 text-neon-200',
  recorder: 'border-[#2EE6D6]/50 text-[#9FF5EC]',
  feature: 'border-emerald-400/50 text-emerald-200',
};

export function SourceBadge({ source }: { source: QaTestSource }) {
  return <span data-qa-source={source} className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SOURCE[source]}`}>{source}</span>;
}

const SEVERITY: Record<QaSeverity, string> = {
  critical: 'bg-red-500/25 text-red-100 border-red-400/60',
  high: 'bg-ember-500/20 text-ember-300 border-ember-400/60',
  medium: 'bg-yellow-500/15 text-yellow-100 border-yellow-400/40',
  low: 'bg-white/[0.06] text-gray-300 border-white/[0.14]',
};

export function SeverityPill({ severity }: { severity: QaSeverity }) {
  return <span data-qa-severity={severity} className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEVERITY[severity] ?? SEVERITY.low}`}>{severity}</span>;
}

export function Empty({ art, title, children }: { art: QaArtName; title: string; children?: ReactNode }) {
  return (
    <div data-qa-empty className={`${CARD} flex flex-col sm:flex-row items-center gap-5`}>
      <QaArt name={art} className="w-40 shrink-0" />
      <div className="space-y-2 text-center sm:text-left">
        <h3 className="font-display text-lg text-gray-100">{title}</h3>
        {children && <div className="text-[14px] text-gray-400 space-y-2">{children}</div>}
      </div>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div data-qa-loading role="status" className={`${CARD} text-[14px] text-gray-400 flex items-center gap-2`}>
      <span className="w-[7px] h-[7px] rounded-full bg-neon-400 animate-pulse" aria-hidden="true" />
      Loading {what}…
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div role="alert" className="rounded-[10px] border border-red-400/45 px-3 py-2 text-[13px] text-red-200">{error}</div>;
}

function locator(t?: QaLocator): string {
  if (!t) return '';
  if (t.role) return `${t.role}${t.name ? ` "${t.name}"` : ''}`;
  if (t.label) return `field "${t.label}"`;
  if (t.text) return `text "${t.text}"`;
  if (t.placeholder) return `placeholder "${t.placeholder}"`;
  if (t.testId) return `test id ${t.testId}`;
  if (t.css) return `css ${t.css}`;
  return '?';
}

/** One cached action, in words. A credential shows its ENV NAME, never a value. */
export function describeAction(a: QaAction): string {
  switch (a.do) {
    case 'goto': return `go to ${a.path}`;
    case 'click': return `click ${locator(a.target)}`;
    case 'fill': return `fill ${locator(a.target)} with ${a.valueEnv ? `$${a.valueEnv}` : JSON.stringify(a.value ?? '')}`;
    case 'select': return `select "${a.option}" in ${locator(a.target)}`;
    case 'check': return `${a.checked ? 'tick' : 'untick'} ${locator(a.target)}`;
    case 'press': return `press ${a.key}`;
    case 'wait': return `wait ${a.ms} ms`;
    case 'expect': {
      const what = a.equals !== undefined ? ` = ${JSON.stringify(a.equals)}` : a.contains !== undefined ? ` contains ${JSON.stringify(a.contains)}` : '';
      return `expect ${a.kind}${a.target ? ` of ${locator(a.target)}` : ''}${what}`;
    }
    default: return JSON.stringify(a);
  }
}

export function ActionList({ actions, tone = 'neutral' }: { actions: QaAction[]; tone?: 'neutral' | 'before' | 'after' }) {
  const cls = tone === 'before' ? 'border-red-400/25' : tone === 'after' ? 'border-emerald-400/30' : 'border-white/[0.08]';
  if (actions.length === 0) return <div className="text-[13px] text-gray-500">No actions</div>;
  return (
    <ol className={`rounded-[10px] bg-gl-code border ${cls} p-2.5 space-y-1 font-mono text-[12px] text-gray-300`}>
      {actions.map((a, i) => (
        <li key={i} className={a.do === 'expect' ? 'text-neon-200' : undefined}>{describeAction(a)}</li>
      ))}
    </ol>
  );
}

export const when = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
