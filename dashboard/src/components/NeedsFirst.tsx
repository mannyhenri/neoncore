/**
 * NEEDS FIRST — what must be done before a feature can be marked done (server lib/roadmap.ts).
 *
 * A feature needs the features ticked on its "Needs first" panel, and every epic its own epic
 * depends on. While any of that is not done it can still be started, but not marked done: the
 * server refuses (however it is asked), and here the Mark done button is disabled and says what it
 * is waiting on. Only features of the same project are offered, never one that already depends on
 * this one — that would be a loop.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FeatureNeeds, RoadmapChart } from '../types';
import { api } from '../lib/api';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The feature's needs, reloaded on `version`. null: not known (yet, or an older server). */
export function useFeatureNeeds(featureId: string, version: number): { needs: FeatureNeeds | null; reload: () => void } {
  const [needs, setNeeds] = useState<FeatureNeeds | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    try {
      Promise.resolve(api.getFeatureNeeds?.(featureId))
        .then((n) => { if (alive) setNeeds(n && Array.isArray(n.candidates) ? n : null); })
        .catch(() => { if (alive) setNeeds(null); });
    } catch { setNeeds(null); }
    return () => { alive = false; };
  }, [featureId, version, tick]);
  return { needs, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** ✓ Mark done — disabled, saying why, while anything it needs is not done. */
export function MarkDoneButton({ needs, onClick, className = '' }: { needs: FeatureNeeds | null; onClick: () => void; className?: string }) {
  const waits = needs?.message ?? '';
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button disabled={!!waits} title={waits || undefined} onClick={() => { if (!waits) onClick(); }}
        className={`${className} disabled:opacity-45 disabled:cursor-not-allowed`}>✓ Mark done</button>
      {waits && <span data-mark-done-waits className="text-[12px] text-amber-200 max-w-[340px] text-right leading-snug">{waits}</span>}
    </span>
  );
}

const STATE_WORD: Record<string, string> = { delivered: 'done', 'under-way': 'under way', planned: 'not started', late: 'late' };

export function NeedsFirstPanel({ featureId, needs, onChanged }: { featureId: string; needs: FeatureNeeds | null; onChanged: () => void }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!needs) return null;
  const name = new Map(needs.candidates.map((c) => [c.id, c]));
  const unmetIds = new Set(needs.unmet.features.map((f) => f.id));
  const save = async (ids: string[]) => {
    setBusy(true); setError('');
    try { await api.planFeature(featureId, { dependsOn: ids }); onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const nothing = needs.chosen.length === 0 && needs.unmet.epics.length === 0;
  return (
    <section data-needs-first className="rounded-[16px] border border-white/[0.1] bg-white/[0.02] px-4 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-neon-300">Needs first</p>
          <p className="text-[13px] text-gray-400">{nothing ? 'Nothing has to be done before this one.' : needs.message ? 'It can be started now, but marked done only once these are.' : 'Everything it needs is done.'}</p>
        </div>
        <button onClick={() => setPicking((v) => !v)} aria-expanded={picking} className="h-8 px-3 rounded-[9px] border border-white/[0.14] text-[12px] font-semibold text-gray-100 hover:border-white/30">
          {picking ? 'Done choosing' : '⛓ Add what must be done first'}
        </button>
      </div>
      {!nothing && (
        <ul className="mt-2.5 space-y-1.5">
          {needs.chosen.map((id) => {
            const c = name.get(id);
            const met = !unmetIds.has(id);
            return (
              <li key={id} data-need={id} data-met={met} className="flex items-center gap-2 text-[13px]">
                <span aria-hidden="true" className={met ? 'text-emerald-300' : 'text-amber-200'}>{met ? '✓' : '⛓'}</span>
                <span className="text-gray-100">{c?.name ?? needs.unmet.features.find((f) => f.id === id)?.name ?? 'A feature'}</span>
                <span className="text-gray-500 text-[12px]">{met ? 'done' : STATE_WORD[c?.state ?? 'planned'] ?? ''}</span>
              </li>
            );
          })}
          {needs.unmet.epics.map((e) => (
            <li key={e.id} data-need={`epic:${e.id}`} data-met="false" className="flex items-center gap-2 text-[13px]">
              <span aria-hidden="true" className="text-amber-200">⛓</span>
              <span className="text-gray-100">The epic “{e.name}”</span>
              <span className="text-gray-500 text-[12px]">its epic needs it delivered first</span>
            </li>
          ))}
        </ul>
      )}
      {picking && (
        <fieldset data-need-pick disabled={busy} className="mt-3 border-t border-white/[0.08] pt-3">
          <legend className="sr-only">What must be done first</legend>
          {needs.candidates.length === 0 && <p className="text-[13px] text-gray-400">No other feature of this project can be chosen: every one already depends on this.</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 max-h-[220px] overflow-y-auto pr-1">
            {needs.candidates.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-[13px] text-gray-200">
                <input type="checkbox" value={c.id} checked={needs.chosen.includes(c.id)} className="accent-neon-500"
                  onChange={(e) => void save(e.target.checked ? [...needs.chosen, c.id] : needs.chosen.filter((id) => id !== c.id))} />
                <span className="truncate">{c.name}</span>
                <span className="text-[11px] text-gray-500 shrink-0">{STATE_WORD[c.state] ?? ''}</span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-gray-500">Features that already depend on this one are not offered: that would make a loop.</p>
        </fieldset>
      )}
      {error && <p data-need-error className="mt-2 text-[13px] text-ember-300">{error}</p>}
    </section>
  );
}

/** featureId → what it waits on, worded ("Points per visit", the epic "Online ordering"), for every blocked feature of a plan. */
export function waitsByFeature(chart: RoadmapChart): Map<string, string[]> {
  const all = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned];
  const name = new Map(all.map((f) => [f.id, f.name]));
  const epic = new Map(chart.epics.map((e) => [e.id, e.name]));
  const out = new Map<string, string[]>();
  for (const f of all) {
    const words = [...f.blockedBy.map((id) => `"${name.get(id) ?? 'another feature'}"`), ...(f.waitsOnEpics ?? []).map((id) => `the epic "${epic.get(id) ?? 'another epic'}"`)];
    if (words.length) out.set(f.id, words);
  }
  return out;
}

/** The project's plan, read for what its features wait on. Empty while unknown. */
export function useProjectWaits(projectId: string | undefined, version: number): Map<string, string[]> {
  const [waits, setWaits] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    try {
      Promise.resolve(api.getRoadmap?.(projectId))
        .then((c) => { if (alive) setWaits(c && Array.isArray(c.epics) ? waitsByFeature(c) : new Map()); })
        .catch(() => { if (alive) setWaits(new Map()); });
    } catch { /* none shown */ }
    return () => { alive = false; };
  }, [projectId, version]);
  return waits;
}

export function WaitsOn({ names, className = '' }: { names: string[]; className?: string }) {
  if (names.length === 0) return null;
  return <div data-waits-on className={`text-[12px] text-amber-200 truncate ${className}`} title={`Waits on ${names.join(', ')}`}>⛓ Waits on {names.join(', ')}</div>;
}
