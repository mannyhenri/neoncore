/**
 * THE EPICS, AS CARDS — under the route (RouteView.tsx), every epic of the plan in order: its glyph
 * in a ring that says where it stands, its number and name, a pill for its state, one for its date
 * (gold "On time" once it earned a commendation), one per epic it needs (✓ once delivered), what
 * it delivers, a progress bar, ← → to reorder, Edit, Delete, and its features — each one opens its
 * card; drag one onto another epic's card to move it there. "+ add a feature to this epic" adds one.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RoadmapChart, RoadmapEpic, RoadmapFeature } from '../../types';
import { STAGE_COLOUR, type EpicStage } from './routeLayout';
import { EpicQaControls } from '../../components/EpicQaControls';

export const CARD_STATE: Record<EpicStage, string> = { commended: 'Done', delivered: 'Done', 'under-way': 'Under way', late: 'Late', blocked: 'Waiting', planned: 'Planned' };
const FEATURE_WORD: Record<RoadmapFeature['state'], string> = { delivered: 'done', 'under-way': 'under way', planned: 'planned', late: 'late' };
const longDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const DRAG_TYPE = 'text/neoncore-feature';

export type DatePill = { kind: 'commend' | 'after' | 'late' | 'due'; text: string } | null;
/** What an epic's date pill says, or null when it has no date. */
export function datePill(e: RoadmapEpic): DatePill {
  const due = e.targetDate ?? '';
  if (!due) return null;
  if (e.deliveredAt) {
    if (e.onTime) return { kind: 'commend', text: `🎖 On time · due ${longDay(due)}` };
    const days = Math.max(1, Math.round((Date.parse(`${e.deliveredAt.slice(0, 10)}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000));
    return { kind: 'after', text: `Delivered ${days} ${days === 1 ? 'day' : 'days'} after ${longDay(due)}` };
  }
  if (e.late) return { kind: 'late', text: `Late · was due ${longDay(due)}` };
  return { kind: 'due', text: `Due ${longDay(due)}` };
}

export function EpicCards({ chart, stages, selected, onSelect, selectedFeature, onPickFeature, iconOf, editor, busy, onStart, onAddEpic, onAddFeature, onReorder, onDelete, onMoveFeature, onPassQa, onQaChanged }: {
  chart: RoadmapChart; stages: EpicStage[];
  /** The epic picked on the route (its card is lit and brought into view). */
  selected: string | null; onSelect: (epicId: string) => void;
  selectedFeature: string | null; onPickFeature: (featureId: string) => void;
  iconOf: (epic: RoadmapEpic, i: number) => { src: string } | undefined;
  editor: (epic: RoadmapEpic, close: () => void) => ReactNode;
  busy: boolean;
  onStart: (featureId: string) => void;
  onAddEpic: () => void;
  onAddFeature: (epicId: string, name: string, date: string) => void;
  onReorder: (ids: string[]) => void;
  onDelete: (epic: RoadmapEpic) => void;
  onMoveFeature: (featureId: string, epicId: string) => void;
  /** Passed QA: every feature of the epic done and QA'd as a whole — they move to Done on the Board. */
  onPassQa?: (epic: RoadmapEpic) => void;
  /** A QA run was started: refresh the chart so the epic's run shows. */
  onQaChanged?: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const cards = useRef<Map<string, HTMLElement>>(new Map());
  useEffect(() => { if (selected) cards.current.get(selected)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [selected]);
  const epicName = new Map(chart.epics.map((e) => [e.id, e.name]));
  const deliveredEpics = new Set(chart.epics.filter((_, i) => stages[i] === 'commended' || stages[i] === 'delivered').map((e) => e.id));
  const total = chart.epics.reduce((n, e) => n + e.progress.total, 0);
  const done = chart.epics.reduce((n, e) => n + e.progress.done, 0);
  const ids = chart.epics.map((e) => e.id);
  const move = (i: number, by: -1 | 1) => { const next = [...ids]; [next[i], next[i + by]] = [next[i + by], next[i]]; onReorder(next); };

  return (
    <section data-epic-cards className="mt-3">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <p data-epic-cards-summary className="font-display text-[12px] font-bold tracking-[0.16em] uppercase text-gray-400">
          The route · {chart.epics.length} {chart.epics.length === 1 ? 'epic' : 'epics'} · {done} of {total} features done
        </p>
        <button data-new-epic onClick={onAddEpic} className="h-9 px-4 rounded-[9px] bg-gradient-to-b from-[#FFB84A] to-[#F08A1E] text-[#1A0F02] font-display text-[13px] font-bold tracking-[0.14em] uppercase shadow-[0_0_16px_rgba(255,160,50,0.45)] hover:brightness-110">+ New epic</button>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {chart.epics.map((e, i) => {
          const stage = stages[i];
          const c = STAGE_COLOUR[stage];
          const on = selected === e.id;
          const pill = datePill(e);
          const glyph = iconOf(e, i);
          const pct = e.progress.total ? Math.round((e.progress.done / e.progress.total) * 100) : 0;
          return (
            <article key={e.id} ref={(el) => { if (el) cards.current.set(e.id, el); else cards.current.delete(e.id); }}
              data-epic-card={e.id} data-stage={stage} data-selected={on || undefined} data-drop-target={over === e.id || undefined}
              onClick={() => onSelect(e.id)}
              onDragOver={(ev) => { if (ev.dataTransfer?.types?.includes(DRAG_TYPE)) { ev.preventDefault(); setOver(e.id); } }}
              onDragLeave={() => setOver((o) => (o === e.id ? null : o))}
              onDrop={(ev) => { ev.preventDefault(); setOver(null); const id = ev.dataTransfer?.getData(DRAG_TYPE); if (id && !e.features.some((f) => f.id === id)) onMoveFeature(id, e.id); }}
              className={`relative rounded-[18px] border px-5 py-4 transition-colors ${over === e.id ? 'border-neon-400 bg-[rgba(20,60,120,0.35)]' : on ? 'border-[rgba(120,180,255,0.6)] bg-[rgba(10,20,40,0.88)] shadow-[0_0_18px_rgba(63,180,255,0.22)]' : 'border-white/[0.09] bg-[rgba(8,14,30,0.82)]'}`}>
              {editing === e.id ? <div className="relative min-h-[420px]" onClick={(ev) => ev.stopPropagation()}>{editor(e, () => setEditing(null))}</div> : (<>
                <div className="flex items-start gap-3.5">
                  {/* the epic's glyph, in a ring that says where it stands */}
                  <span data-epic-icon={stage} aria-hidden="true" className="relative shrink-0 w-[60px] h-[60px]">
                    <span className="absolute inset-0 rounded-full" style={{ background: `radial-gradient(circle at 38% 32%, ${c}, ${c}55 60%, #0A1222 72%)`, boxShadow: `0 0 0 4px #1B2436, 0 0 0 6px ${c}55` }} />
                    <span className="absolute inset-0 flex items-center justify-center text-[22px] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                      {stage === 'commended' || stage === 'delivered' ? '✓' : stage === 'late' ? '!' : stage === 'blocked' ? '⛓' : stage === 'under-way' ? '' : ''}
                    </span>
                    {glyph && <span className="absolute -right-2 -bottom-2 w-[30px] h-[30px] rounded-full bg-[#0B1322] border border-white/20 flex items-center justify-center"><img src={glyph.src} alt="" className="w-[22px] h-[22px]" style={{ imageRendering: 'pixelated' }} /></span>}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h4 className="flex items-baseline gap-2"><span className="text-[14px] text-gray-500 tabular-nums">{i + 1}</span><span className="font-display text-[19px] font-bold text-white leading-tight">{e.name}</span></h4>
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span data-epic-pill="state" className="px-2.5 h-7 inline-flex items-center rounded-full text-[13px] font-semibold" style={{ color: c, background: `${c}22` }}>{CARD_STATE[stage]}</span>
                      {pill && <span data-epic-pill="date" data-kind={pill.kind} className={`px-2.5 h-7 inline-flex items-center rounded-full text-[13px] ${pill.kind === 'commend' ? 'border border-[#F5C542]/70 bg-[rgba(245,197,66,0.12)] text-[#FFE39A]' : pill.kind === 'late' ? 'bg-[rgba(255,138,61,0.16)] text-[#FFB27A]' : 'bg-white/[0.06] text-gray-200'}`}>{pill.text}</span>}
                      {/* EPIC QA: done features wait for the epic's QA, at its end, before they are Done on the Board. */}
                      {e.qa === 'passed' && <span data-epic-pill="qa" className="px-2.5 h-7 inline-flex items-center rounded-full text-[13px] bg-emerald-500/10 text-emerald-300">✓ QA passed</span>}
                      {(e.dependsOn ?? []).map((id) => {
                        const met = deliveredEpics.has(id);
                        return <span key={id} data-epic-pill="needs" data-met={met} className={`px-2.5 h-7 inline-flex items-center rounded-full text-[13px] ${met ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-400/10 text-amber-200'}`}>⛓ Needs {epicName.get(id) ?? 'another epic'}{met ? ' ✓' : ''}</span>;
                      })}
                    </div>
                    {/* EPIC QA: its run for this finish, why Passed QA is refused, Run QA (EpicQaControls). */}
                    {e.qa === 'waiting' && onPassQa && (
                      <div className="mt-2"><EpicQaControls epicId={e.id} epicName={e.name} qa={e.qa} run={e.qaRun ?? null} busy={busy} onPassQa={() => onPassQa(e)} onChanged={onQaChanged} /></div>
                    )}
                    {e.outcome && <p className="mt-2 text-[14px] text-gray-300">{e.outcome}</p>}
                    <div className="mt-2.5 flex items-center gap-3">
                      <div role="progressbar" aria-label={`${e.name}: features done`} aria-valuemin={0} aria-valuemax={e.progress.total} aria-valuenow={e.progress.done} className="flex-1 h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                        <span className="block h-full bg-emerald-400/80" style={{ width: `${pct}%` }} />
                      </div>
                      <span data-epic-progress className="text-[12px] text-gray-400 tabular-nums">{e.progress.done}/{e.progress.total} done</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-end gap-1.5 flex-wrap" onClick={(ev) => ev.stopPropagation()}>
                  {e.nextUp && <button data-epic-start={e.id} onClick={() => onStart(e.nextUp!)} className="mr-auto h-9 px-3 rounded-[9px] text-[12px] font-semibold text-neon-200 hover:text-white">Start next ▸</button>}
                  <button data-epic-left aria-label={`Move ${e.name} earlier`} disabled={busy || i === 0} onClick={() => move(i, -1)} className="w-10 h-9 rounded-[9px] border border-white/[0.14] text-gray-200 disabled:opacity-30">←</button>
                  <button data-epic-right aria-label={`Move ${e.name} later`} disabled={busy || i === chart.epics.length - 1} onClick={() => move(i, 1)} className="w-10 h-9 rounded-[9px] border border-white/[0.14] text-gray-200 disabled:opacity-30">→</button>
                  <button data-epic-edit aria-label={`Edit the epic ${e.name}`} onClick={() => setEditing(e.id)} className="h-9 px-4 rounded-[9px] border border-white/[0.14] font-display text-[13px] font-bold tracking-[0.12em] uppercase text-gray-100">Edit</button>
                  <button data-epic-delete aria-label={`Delete the epic ${e.name}`} onClick={() => onDelete(e)} className="h-9 px-4 rounded-[9px] border border-red-400/45 font-display text-[13px] font-bold tracking-[0.12em] uppercase text-[#FFB0A0]">Delete</button>
                </div>
                <ul className="mt-3 space-y-1.5" onClick={(ev) => ev.stopPropagation()}>
                  {e.features.map((f) => {
                    const waits = f.blockedBy.length > 0 || (f.waitsOnEpics ?? []).length > 0;
                    const word = waits && f.state !== 'delivered' ? '⛓ waits' : FEATURE_WORD[f.state];
                    return (
                      <li key={f.id}>
                        <button data-epic-feature={f.id} data-state={f.state} data-selected={selectedFeature === f.id || undefined} draggable
                          onDragStart={(ev) => { ev.dataTransfer?.setData(DRAG_TYPE, f.id); }}
                          onClick={() => onPickFeature(f.id)}
                          className={`w-full flex items-center gap-3 h-11 px-3 rounded-[10px] border text-left ${selectedFeature === f.id ? 'border-[#3FB4FF] bg-[rgba(20,70,130,0.45)]' : 'border-white/[0.08] bg-[rgba(10,18,36,0.7)] hover:border-white/20'}`}>
                          <span aria-hidden="true" className="text-gray-600 tracking-[-0.2em] cursor-grab">⋮⋮</span>
                          <span className={`flex-1 min-w-0 truncate font-mono text-[13px] tracking-[0.12em] uppercase ${f.state === 'delivered' ? 'text-gray-300' : 'text-gray-100'}`}>{f.name}</span>
                          <span data-feature-word className={`shrink-0 text-[12px] ${f.state === 'delivered' ? 'text-emerald-300' : f.state === 'late' ? 'text-[#FF8A3D]' : waits ? 'text-amber-200' : f.state === 'under-way' ? 'text-neon-300' : 'text-gray-400'}`}>{word}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-2" onClick={(ev) => ev.stopPropagation()}>
                  {adding === e.id ? (
                    <form data-epic-adder className="flex items-center gap-2 flex-wrap" onSubmit={(ev) => { ev.preventDefault(); if (name.trim()) { onAddFeature(e.id, name.trim(), date); setAdding(null); } }}>
                      <input value={name} onChange={(ev) => setName(ev.target.value)} aria-label="New feature name" placeholder="Feature name" className="glass-input h-10 px-3 rounded-[9px] text-[13px] flex-1 min-w-[180px]" />
                      <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} aria-label="New feature target date" className="glass-input h-10 px-2 rounded-[9px] text-[13px] text-gray-100" />
                      <button type="submit" disabled={busy || !name.trim()} className="btn-primary h-10 px-3 rounded-[9px] text-[13px] font-semibold disabled:opacity-40">Add</button>
                      <button type="button" onClick={() => setAdding(null)} className="btn-ghost h-10 px-3 rounded-[9px] text-[13px]">Cancel</button>
                    </form>
                  ) : (
                    <button data-epic-add-feature={e.id} onClick={() => { setAdding(e.id); setName(''); setDate(''); }}
                      className="w-full h-11 rounded-[10px] border border-white/[0.14] font-mono text-[13px] tracking-[0.14em] uppercase text-gray-300 hover:border-white/30 hover:text-white text-left px-4">
                      + Add a feature to this epic
                    </button>
                  )}
                </div>
              </>)}
            </article>
          );
        })}
      </div>
    </section>
  );
}
