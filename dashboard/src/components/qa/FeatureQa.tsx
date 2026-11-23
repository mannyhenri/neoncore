/**
 * QA FOLLOWS THE FEATURE — the first thing the QA section shows.
 *
 * Nobody enters a test here. A feature's acceptance criteria are its QA test (server
 * lib/qa/feature-link.ts); it runs by itself each time a workflow stage of the feature finishes.
 * This is the report: per project and per feature, how many criteria pass, which ones do not, and
 * the screenshot of what was tested.
 *
 * What QA cannot work out by itself is said in place: a project with no target (where its app
 * runs), a feature with no criteria yet, a feature nothing has been built for yet.
 */
import { useCallback, useEffect, useState } from 'react';
import { qaApi as defaultApi, type QaApi } from '../../lib/qaApi';
import type { QaCriterionStatus, QaFeature, QaFeatureState, QaProjectFeatures } from './types';
import { QaArt } from './art';
import { BTN_GHOST, CARD, ErrorNote, when } from './ui';

export const FEATURE_STATE: Record<QaFeatureState, { label: string; tone: string }> = {
  passed: { label: 'Passing', tone: 'border-emerald-400/60 text-emerald-300 bg-emerald-400/10' },
  failed: { label: 'Failing', tone: 'border-ember-400/60 text-ember-300 bg-ember-500/10' },
  running: { label: 'Testing…', tone: 'border-neon-400/60 text-neon-200 bg-neon-500/10' },
  error: { label: 'Could not run', tone: 'border-ember-400/60 text-ember-300 bg-ember-500/10' },
  'not-run': { label: 'Not run yet', tone: 'border-white/20 text-gray-300 bg-white/[0.04]' },
  'waiting-for-build': { label: 'Waiting for the build', tone: 'border-white/20 text-gray-300 bg-white/[0.04]' },
  'no-criteria': { label: 'No criteria yet', tone: 'border-white/20 text-gray-400 bg-white/[0.03]' },
  'no-target': { label: 'No target', tone: 'border-amber-400/50 text-amber-300 bg-amber-400/10' },
};
const CRITERION: Record<QaCriterionStatus, { mark: string; tone: string; word: string }> = {
  passed: { mark: '✓', tone: 'text-emerald-300', word: 'passed' },
  failed: { mark: '✕', tone: 'text-ember-300', word: 'failed' },
  running: { mark: '…', tone: 'text-neon-300', word: 'being tested' },
  'not-run': { mark: '·', tone: 'text-gray-500', word: 'not run' },
};
/** A feature can be run by hand once it has a test and is not already running. */
const RUNNABLE: ReadonlySet<QaFeatureState> = new Set(['passed', 'failed', 'error', 'not-run', 'waiting-for-build']);

function Bar({ passed, total, failed = 0, label }: { passed: number; total: number; failed?: number; label: string }) {
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  return (
    <div data-qa-bar role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={passed} title={label}
      className="h-2 rounded-full bg-white/[0.08] overflow-hidden flex">
      <span className="h-full bg-emerald-400 shadow-[0_0_8px_#4ADE80] transition-[width] duration-500" style={{ width: `${pct(passed)}%` }} />
      <span className="h-full bg-ember-400 transition-[width] duration-500" style={{ width: `${pct(failed)}%` }} />
    </div>
  );
}

function FeatureRow({ f, busy, onRun }: { f: QaFeature; busy: boolean; onRun: () => void }) {
  const state = FEATURE_STATE[f.state];
  const failed = f.criteria.filter((c) => c.status === 'failed').length;
  // Open by default where there is something to look at: a failure, or a run in progress.
  const [open, setOpen] = useState(f.state === 'failed' || f.state === 'running');
  return (
    <li data-qa-feature={f.goalId} data-state={f.state} className="rounded-[12px] border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={f.total === 0} className="text-left min-w-0 flex-1 disabled:cursor-default">
          <span className="block text-[15px] font-semibold text-gray-100 truncate">{f.total > 0 && <span className="text-gray-500 mr-1.5">{open ? '▾' : '▸'}</span>}{f.name}</span>
        </button>
        <span data-qa-feature-state className={`rounded-full border px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap ${state.tone}`}>{state.label}</span>
        {f.total > 0 && <span data-qa-feature-count className="font-display text-[16px] font-bold text-gray-100 whitespace-nowrap">{f.passed}/{f.total}</span>}
        {f.reportUrl && <a href={f.reportUrl} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-neon-300 hover:text-white whitespace-nowrap">Report ↗</a>}
        {RUNNABLE.has(f.state) && (
          <button data-qa-feature-run disabled={busy} onClick={onRun} className={`${BTN_GHOST} h-8 px-3 text-[12px]`}>{f.runId ? '↻ Run again' : '▶ Run now'}</button>
        )}
      </div>
      {f.total > 0 && <div className="mt-2"><Bar passed={f.passed} failed={failed} total={f.total} label={`${f.passed} of ${f.total} criteria passing`} /></div>}
      {(f.note || f.runAt) && (
        <p data-qa-feature-note className="text-[13px] text-gray-400 mt-1.5">
          {f.note}{f.note && f.runAt ? ' · ' : ''}{f.runAt ? `last run ${when(f.runAt)}${f.repaired ? ' (a step was self-repaired)' : ''}` : ''}
        </p>
      )}
      {open && f.total > 0 && (
        <ul className="mt-2.5 space-y-2">
          {f.criteria.map((c) => {
            const s = CRITERION[c.status];
            return (
              <li key={c.id} data-qa-criterion={c.id} data-status={c.status} className="flex items-start gap-3">
                <span aria-label={s.word} className={`w-5 text-center text-[15px] font-bold shrink-0 ${s.tone}`}>{s.mark}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-gray-200"><span className="font-mono text-gray-400 mr-1.5">{c.id}</span>{c.text}</span>
                  {c.expect && <span className="block text-[12px] text-gray-500">Expected: {c.expect}</span>}
                  {c.error && <span className="block text-[12px] text-ember-300">{c.error}</span>}
                </span>
                {c.screenshot && (
                  <a data-qa-shot href={c.screenshot} target="_blank" rel="noreferrer" title={`Screenshot of ${c.id} — open full size`} className="shrink-0">
                    <img src={c.screenshot} alt={`What was on screen when ${c.id} was checked`} loading="lazy" className="w-[132px] h-[82px] object-cover object-top rounded-[8px] border border-white/[0.14]" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function FeatureQa({ api = defaultApi, tick = 0, pollMs = 8000, onAddTarget }: {
  api?: QaApi;
  /** Changes when the server says a QA run moved: the report is read again. */
  tick?: number;
  pollMs?: number;
  onAddTarget?: () => void;
}) {
  const [projects, setProjects] = useState<QaProjectFeatures[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { setProjects(await api.features()); setError(null); } catch (e) { setProjects((p) => p ?? []); setError((e as Error).message); }
  }, [api]);
  useEffect(() => { void load(); }, [load, tick]);
  // While something is being tested, keep the bars moving.
  const running = !!projects?.some((p) => p.features.some((f) => f.state === 'running'));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [running, load, pollMs]);

  const run = async (goalId: string) => {
    setBusy(goalId); setError(null);
    let refused: string | null = null;
    try { await api.runFeature(goalId); } catch (e) { refused = (e as Error).message; }
    await load();
    // Said after the reload, which clears an older error.
    if (refused) setError(refused);
    setBusy('');
  };

  if (projects === undefined) return null;
  const withFeatures = projects.filter((p) => p.features.length > 0);
  return (
    <section data-qa-features className="space-y-3">
      <div className="flex items-center gap-3">
        <QaArt name="module-runner" className="w-12 h-12 shrink-0" />
        <div>
          <h3 className="font-display text-[20px] font-semibold text-gray-100">Features under test</h3>
          <p className="text-[13px] text-gray-400">A feature’s acceptance criteria are its test. It runs by itself every time a stage of the feature finishes — nothing to enter.</p>
        </div>
      </div>
      <ErrorNote error={error} />
      {withFeatures.length === 0 && !error && (
        <p data-qa-features-empty className={`${CARD} text-[14px] text-gray-300`}>
          No feature is being developed yet. Start one from a project’s Features list: as soon as it has acceptance criteria it appears here, and QA tests it as it is built.
        </p>
      )}
      {withFeatures.map((p) => {
        const failed = p.features.reduce((n, f) => n + f.criteria.filter((c) => c.status === 'failed').length, 0);
        return (
          <div key={p.projectId} data-qa-project={p.projectId} className={CARD}>
            <div className="flex items-center gap-3 flex-wrap">
              <span aria-hidden="true" className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: p.color || '#60a0ff', boxShadow: `0 0 10px ${p.color || '#60a0ff'}` }} />
              <span className="font-display text-[18px] font-semibold text-gray-100">{p.name}</span>
              {p.target
                ? <span className="font-mono text-[12px] text-gray-400">{p.target.baseUrl}</span>
                : <span data-qa-no-target className="text-[13px] text-amber-300">QA does not know where this project’s app runs.</span>}
              {p.target && !p.target.hasCartridge && <span data-qa-no-cartridge className="text-[13px] text-amber-300">Its target has no cartridge — pick one in Target settings.</span>}
              <span className="flex-1" />
              {!p.target && onAddTarget && <button data-qa-add-target onClick={onAddTarget} className={`${BTN_GHOST} h-8 px-3 text-[12px]`}>+ Add its target</button>}
              <span data-qa-project-count className="text-[13px] text-gray-300 whitespace-nowrap">
                <span className="font-display text-[18px] font-bold text-gray-100">{p.passed}/{p.total}</span> criteria · {p.featuresPassing} of {p.features.length} feature{p.features.length === 1 ? '' : 's'} passing
              </span>
            </div>
            <div className="mt-2.5"><Bar passed={p.passed} failed={failed} total={p.total} label={`${p.name}: ${p.passed} of ${p.total} criteria passing`} /></div>
            <ul className="mt-3 space-y-2">
              {p.features.map((f) => <FeatureRow key={`${f.goalId}:${f.state}`} f={f} busy={busy !== ''} onRun={() => void run(f.goalId)} />)}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
