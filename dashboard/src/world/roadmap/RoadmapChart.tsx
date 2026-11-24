/**
 * THE ROADMAP DECK — a project's plan as its own screen: the VISION across the top, the ROUTE
 * (RouteView.tsx: every epic a stop on the way to the destination, and its card under the route),
 * the officer of the deck at the left, and the selected feature's card at the bottom right.
 * There is one view: the route. (A dated timeline was retired — it read as noise.)
 *
 * It is the planning surface AND the launch surface: select a feature to see it, plan it (its
 * epic, dates, what it waits on) and START it. "Start next" on an epic opens its earliest feature
 * that can start.
 *
 * Nothing here decides anything about the work: every state, date, dependency and "next up" comes
 * from the server's chart (server lib/roadmap.ts), and every change is one call that answers with
 * the chart as it now is. Positions are chartLayout.ts.
 *
 * The room, the destination, the marker on today's line, the epic glyphs and the officer are the
 * theme's drawn art (roadmapArt.generated.ts, ../bridge/art.ts, ../theme.ts): a star chart on a
 * ship's deck, or a quest map in a cartographer's room. The chart itself — lines, nodes, tags — is
 * interface, drawn by the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Project, RoadmapChart as Chart, RoadmapEpic, RoadmapFeature, RoadmapFeatureState } from '../../types';
import { api } from '../../lib/api';
import { THEME, word } from '../theme';
import { DECK_ART } from '../bridge/art';
import { DeckSprite } from '../bridge/Decks';
import { RankPlate, captainSheet, useProjectRank } from '../bridge/rank';
import { RouteView } from './RouteView';
import { ROADMAP_ART, type RoadmapStrip } from './roadmapArt.generated';
import { visionGauges, startBlock, dayOf } from './chartLayout';

const ART = ROADMAP_ART[THEME] ?? ROADMAP_ART.scifi;
export const STATE_LABEL: Record<RoadmapFeatureState, string> = { delivered: 'Delivered', 'under-way': 'Under way', planned: 'Planned', late: 'Late' };
const LEGEND: readonly RoadmapFeatureState[] = ['delivered', 'under-way', 'planned', 'late'];
const COLOUR: Record<RoadmapFeatureState, string> = { delivered: '#34D36B', 'under-way': '#3FB4FF', planned: '#C9D6EA', late: '#FF8A3D' };

const NODE = 18;              // a feature's node, px
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : 'That did not work';
  // A server from before the roadmap existed answers "Not Found" — say what to do about it.
  return /not found/i.test(m) ? 'This server does not have the roadmap yet. Rebuild and restart it, then reload this page.' : m;
};
const MONTH_NAME = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthOf = (day: string | null) => (day ? `${MONTH_NAME[Number(day.slice(5, 7)) - 1]} ${day.slice(8, 10)}` : 'No date');

/** The officer's look is what the plan says (same rows as on the Projects bridge). */
const shortDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export type EpicNote = { kind: 'commend' | 'delivered' | 'late' | 'due' | 'waits'; text: string };
/**
 * What an epic's lane says about its date and what it waits on — nothing for an epic with neither.
 * Delivered on or before its date is a COMMENDATION (it promotes the project's captain).
 */
export function epicStatus(epic: RoadmapEpic, numberOf: (id: string) => number): EpicNote[] {
  const out: EpicNote[] = [];
  const due = epic.targetDate ?? '';
  const waits = epic.blockedBy ?? [];
  if (waits.length > 0) out.push({ kind: 'waits', text: `Waits on ${waits.map((id) => `Epic ${numberOf(id)}`).join(', ')}` });
  if (epic.deliveredAt) {
    const on = shortDay(epic.deliveredAt);
    if (epic.onTime) out.push({ kind: 'commend', text: `★ Commendation · delivered ${on}, due ${shortDay(due)}` });
    else if (due) {
      const days = Math.max(1, Math.round((Date.parse(`${epic.deliveredAt.slice(0, 10)}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000));
      out.push({ kind: 'delivered', text: `Delivered ${on} · ${days} ${days === 1 ? 'day' : 'days'} after its date` });
    } else out.push({ kind: 'delivered', text: `Delivered ${on}` });
  } else if (epic.late) out.push({ kind: 'late', text: `Late · was due ${shortDay(due)}` });
  else if (due) out.push({ kind: 'due', text: `Due ${shortDay(due)}` });
  return out;
}

export function officerAnim(totals: Chart['totals']): 'worry' | 'log' | 'idle' {
  if (totals.late > 0) return 'worry';
  if (totals['under-way'] > 0) return 'log';
  return 'idle';
}

/** A drawn strip of frames, stepping (the same strip animation as every other sprite). */
function Strip({ art, height, fps = 4 }: { art: RoadmapStrip; height: number; fps?: number }) {
  const width = (height * art.frameW) / art.frameH;
  return (
    <div aria-hidden="true" className="overflow-hidden shrink-0" style={{ width, height }}>
      <div className="world-strip" style={{
        width: width * art.frames, height, backgroundImage: `url(${art.src})`, backgroundRepeat: 'no-repeat',
        backgroundSize: `${width * art.frames}px ${height}px`, animationDuration: `${art.frames / fps}s`, animationTimingFunction: `steps(${art.frames})`,
      }} />
    </div>
  );
}

/** A half-ring gauge: the arc fills left to right. */
function Gauge({ id, label, value, title }: { id: string; label: string; value: number; title: string }) {
  const r = 34; const cx = 44; const cy = 42;
  const sweep = 220;                                   // degrees of arc, centred on the top
  const at = (deg: number) => { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = (to: number) => { const [x0, y0] = at(-sweep / 2); const [x1, y1] = at(-sweep / 2 + to); return `M ${x0} ${y0} A ${r} ${r} 0 ${to > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  return (
    <div data-vision-gauge={id} title={title} className="flex flex-col items-center w-[104px]">
      <svg width="88" height="56" viewBox="0 0 88 56" aria-hidden="true">
        <path d={arc(sweep)} fill="none" stroke="rgba(120,160,220,0.22)" strokeWidth="7" strokeLinecap="round" />
        {value > 0 && <path d={arc((sweep * Math.min(100, value)) / 100)} fill="none" stroke="#3FB4FF" strokeWidth="7" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 5px rgba(63,180,255,0.8))' }} />}
        <text x={cx} y={cy + 6} textAnchor="middle" fill="#F2F6FF" fontSize="17" fontWeight="600">{value}%</text>
      </svg>
      <span className="text-[11px] tracking-[0.14em] text-gray-300 uppercase -mt-0.5">{label}</span>
    </div>
  );
}

/** A waypoint's node: a circle, in its state. */
function Node({ state, selected, size = NODE }: { state: RoadmapFeatureState; selected?: boolean; size?: number }) {
  const c = COLOUR[state];
  const style: CSSProperties = {
    width: size, height: size, borderRadius: '50%', border: `2px solid ${c}`, boxSizing: 'border-box',
    background: state === 'delivered' ? c : '#08101F',
    boxShadow: state === 'planned' && !selected ? 'none' : `0 0 ${selected ? 14 : 9}px ${c}${selected ? '' : 'B0'}`,
  };
  return <span data-node={state} aria-hidden="true" className="block shrink-0" style={style} />;
}

export function RoadmapChart({ project, version, onOpenFeature, onChanged, toolbar }: {
  project: Project; version: number; onOpenFeature: (id: string) => void; onChanged: () => void;
  /** Controls for the deck's top-left corner (where you are, and the way back). */
  toolbar?: ReactNode;
}) {
  // The project's rank: what its officer of the deck wears (bridge/rank.tsx).
  const rank = useProjectRank(project.id);
  const [chart, setChart] = useState<Chart | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [visionDraft, setVisionDraft] = useState<string | null>(null);
  const [newEpic, setNewEpic] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [deckH, setDeckH] = useState(720);

  useEffect(() => {
    let alive = true;
    api.getRoadmap(project.id).then((c) => { if (alive) { setChart(c); setError(''); } }).catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [project.id, version]);

  // The officer's height follows the deck's.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const measure = () => setDeckH((h) => root.current?.clientHeight || h);
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    measure();
    return () => ro.disconnect();
  }, [chart === null]);

  /** One change: send it, show the chart it answers with, and tell the page its features changed. */
  const change = useCallback(async (call: () => Promise<Chart>) => {
    setBusy(true);
    try { setChart(await call()); setError(''); onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }, [onChanged]);

  /** A new feature, straight into an epic (and onto a date, when one is given). */
  const addFeature = useCallback((epicId: string, name: string, targetDate: string) => change(async () => {
    const goal = await api.createGoal({ name, projectId: project.id });
    return api.planFeature(goal.id, { epicId, ...(targetDate ? { targetDate } : {}) });
  }), [change, project.id]);

  const shell = (inner: ReactNode) => (
    <div ref={root} data-roadmap-chart data-theme={THEME} className="relative h-full min-h-[600px] overflow-hidden text-gray-100"
      style={ART.deck ? { backgroundImage: `url(${ART.deck})`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundColor: '#050912' } : { backgroundColor: '#050912' }}>
      {inner}
    </div>
  );
  if (!chart) {
    return shell(
      <div className="absolute inset-0 flex flex-col gap-3 p-5">
        {toolbar && <div className="flex items-center gap-2 flex-wrap">{toolbar}</div>}
        <p className={`text-[14px] ${error ? 'text-ember-300' : 'text-gray-400'}`}>{error || 'Loading…'}</p>
      </div>,
    );
  }

  const everyFeature = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned];
  const names = new Map(everyFeature.map((f) => [f.id, f.name]));
  const picked = everyFeature.find((f) => f.id === selected) ?? null;
  const gauges = visionGauges(chart);
  const epicNumber = (id: string) => chart.epics.findIndex((e) => e.id === id) + 1;
  const iconOf = (epic: RoadmapEpic, i: number) => ART.icons.find((g) => g.id === epic.icon) ?? ART.icons[i % Math.max(1, ART.icons.length)];

  const officerH = Math.round(Math.min(340, Math.max(200, deckH * 0.42)));
  const glass = 'rounded-[14px] border border-[rgba(96,160,255,0.28)] bg-[rgba(6,12,26,0.78)] backdrop-blur-[3px]';

  return shell(
    <>
      <div className="absolute inset-0 flex flex-col gap-3 px-5 pt-3 pb-4">
        {/* ── VISION ───────────────────────────────────────────────────────── */}
        <div data-vision className={`${glass} px-6 py-3 flex items-center gap-6`}>
          {/* which project this roadmap is — first thing on the deck */}
          <div data-roadmap-project className="shrink-0 max-w-[240px] pr-6 border-r border-white/[0.16]" title={`${chart.project.name} — roadmap`}>
            <span className="block text-[11px] font-bold tracking-[0.16em] text-neon-300 uppercase">Project roadmap</span>
            <span className="flex items-center gap-2 mt-0.5">
              <span aria-hidden="true" className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: project.color || '#60a0ff', boxShadow: `0 0 10px ${project.color || '#60a0ff'}` }} />
              <span className="font-display text-[20px] font-semibold text-white truncate">{chart.project.name}</span>
            </span>
          </div>
          <span className="font-display text-[22px] font-semibold tracking-[0.1em] text-white shrink-0">VISION</span>
          <div className="flex-1 min-w-0 border-l border-white/[0.16] pl-6">
            {visionDraft !== null ? (
              <div className="flex items-start gap-2">
                <textarea autoFocus value={visionDraft} onChange={(e) => setVisionDraft(e.target.value)} rows={2} aria-label="The project's vision"
                  className="glass-input flex-1 rounded-[10px] px-3 py-2 text-[15px] text-gray-100" placeholder="Where is this project going? One or two sentences." />
                <button disabled={busy} onClick={() => { void change(() => api.setRoadmapVision(project.id, visionDraft)); setVisionDraft(null); }} className="btn-primary h-9 px-3 rounded-[10px] text-[13px] font-semibold">Save</button>
                <button onClick={() => setVisionDraft(null)} className="btn-ghost h-9 px-3 rounded-[10px] text-[13px]">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setVisionDraft(chart.vision)} className="text-left w-full group" title="Edit the vision">
                <span className={`text-[16px] leading-snug ${chart.vision ? 'text-gray-100' : 'text-gray-400 italic'}`}>
                  {chart.vision || 'No vision yet. Say where this project is going — every feature started from here is told.'}
                </span>
                <span className="ml-2 text-[12px] text-neon-300 opacity-0 group-hover:opacity-100 group-focus:opacity-100">edit</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 border-l border-white/[0.16] pl-5 shrink-0">
            <Gauge id="delivery" label="Delivery" value={gauges.delivered} title="Features delivered, of all that are planned" />
            <Gauge id="scope" label="Scope" value={gauges.scheduled} title="Features with a place on the chart (a date, or already delivered)" />
            <Gauge id="readiness" label="Readiness" value={gauges.onTrack} title="Features that are not late" />
          </div>
          <div data-destination className="flex items-center gap-3 shrink-0">
            <span aria-hidden="true" className="hidden xl:block w-[110px] border-t-2 border-dotted border-[rgba(96,160,255,0.55)]" />
            <div className="flex flex-col items-center gap-0.5 w-[170px]">
              {ART.destination ? <Strip art={ART.destination} height={62} fps={2} /> : <span className="w-[56px] h-[56px] rounded-full bg-neon-500/40" />}
              <span className="text-[11px] tracking-[0.16em] text-gray-300 uppercase">{word('destination')}</span>
              <span className="text-[12px] tracking-[0.1em] text-white uppercase text-center leading-tight line-clamp-2">{chart.project.name}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex gap-3">
          {/* ── THE OFFICER OF THE DECK ─────────────────────────────────── */}
          <div className="hidden lg:flex w-[176px] shrink-0 flex-col justify-end items-center pb-[9%] relative z-10 pointer-events-none [&_button]:pointer-events-auto" data-officer={officerAnim(chart.totals)}>
            {/* The deck's own controls. This column is only as wide as the officer, so they are
                STACKED, one under the other — side by side they ran over the chart's title. */}
            {toolbar && <div data-roadmap-toolbar className="self-stretch mb-auto pt-1 flex flex-col items-start gap-2 [&>*]:max-w-full">{toolbar}</div>}
            <DeckSprite sheet={captainSheet(DECK_ART.sheets.captain, rank?.id)} cycle={officerAnim(chart.totals)} fps={4} height={officerH} />
            {/* His rank: one promotion per epic delivered on or before its date (bridge/rank.tsx). */}
            {rank && <div className="mt-1"><RankPlate rank={rank} name={project.name} /></div>}
          </div>

          {/* ── THE CHART ────────────────────────────────────────────────── */}
          <div className={`${glass} flex-1 min-w-0 flex flex-col`}>
            <div className="flex items-center justify-between gap-4 flex-wrap px-6 pt-4 pb-3 border-b border-white/[0.08]">
              <div className="flex items-center gap-4 flex-wrap">
                <h3 className="font-display text-[19px] font-semibold tracking-[0.08em] text-white uppercase">Roadmap — the route</h3>
              </div>
              <div className="flex items-center gap-5 flex-wrap text-[13px] text-gray-200">
                {LEGEND.map((s) => (
                  <span key={s} data-legend={s} className="inline-flex items-center gap-2"><Node state={s} size={14} />{STATE_LABEL[s]}<span className="text-gray-500 tabular-nums">{chart.totals[s]}</span></span>
                ))}
                <span className="inline-flex items-center gap-2 border-l border-white/[0.16] pl-5"><span className="w-7 border-t-2 border-dotted border-[#9CCBFF]" />Dependency</span>
                {newEpic === null
                  ? <button data-add-epic onClick={() => setNewEpic('')} className="btn-primary h-9 px-4 rounded-[9px] text-[13px] font-semibold">+ Add epic</button>
                  : (
                    <form className="inline-flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (newEpic.trim()) { void change(() => api.createEpic(project.id, { name: newEpic })); setNewEpic(null); } }}>
                      <input autoFocus value={newEpic} onChange={(e) => setNewEpic(e.target.value)} placeholder="Epic name" aria-label="New epic name" className="glass-input h-8 px-2 rounded-[8px] text-[12px] w-[170px]" />
                      <button type="submit" disabled={busy || !newEpic.trim()} className="btn-primary h-8 px-3 rounded-[9px] text-[12px] font-semibold disabled:opacity-40">Add</button>
                      <button type="button" onClick={() => setNewEpic(null)} className="btn-ghost h-8 px-2 rounded-[9px] text-[12px]">Cancel</button>
                    </form>
                  )}
              </div>
            </div>
            {error && <p className="text-[13px] text-ember-300 px-6 pt-2">{error}</p>}

            <RouteView chart={chart} busy={busy} selectedFeature={selected} padBottom={picked ? 200 : undefined}
                iconOf={iconOf} notesOf={(e) => epicStatus(e, epicNumber)} node={(st) => <Node state={st} size={12} />}
                destination={ART.destination ? <Strip art={ART.destination} height={104} fps={2} /> : null}
                ship={ART.today ? <Strip art={ART.today} height={26} fps={8} /> : null}
                editor={(e, close) => (
                  <EpicEditor epic={e} busy={busy} onClose={close}
                    others={chart.epics.filter((o) => o.id !== e.id).map((o) => ({ id: o.id, label: `Epic ${epicNumber(o.id)} — ${o.name}` }))}
                    onSave={(data) => { void change(() => api.updateEpic(e.id, data)); close(); }}
                    onDelete={() => { if (confirm(`Remove the epic "${e.name}"? Its ${e.features.length} feature(s) stay in the project, in no epic.`)) { void change(() => api.deleteEpic(e.id)); close(); } }} />
                )}
                onPickFeature={(id) => { setSelected(id); setPlanning(false); }} onStart={onOpenFeature} onAddEpic={() => setNewEpic('')}
                onAddFeature={(epicId, name, date) => { void addFeature(epicId, name, date); }}
                onReorder={(ids) => void change(() => api.reorderEpics(project.id, ids))}
                onDeleteEpic={(e) => { if (confirm(`Remove the epic "${e.name}"? Its ${e.features.length} feature(s) stay in the project, in no epic.`)) void change(() => api.deleteEpic(e.id)); }}
                onMoveFeature={(featureId, epicId) => void change(() => api.planFeature(featureId, { epicId }))}
                onPassQa={(e) => void change(() => api.setEpicQa(e.id, true))}
                onQaChanged={() => void change(() => api.getRoadmap(project.id))} />
          </div>
        </div>
      </div>

      {/* ── THE SELECTED WAYPOINT ──────────────────────────────────────────── */}
      {picked && (
        <FeatureCard key={picked.id} feature={picked} chart={chart} names={names} busy={busy} epicNumber={epicNumber(picked.epicId)} planning={planning} onPlanning={setPlanning}
          onPlan={(data) => void change(() => api.planFeature(picked.id, data))} onOpen={() => onOpenFeature(picked.id)} onClose={() => { setSelected(null); setPlanning(false); }} />
      )}
    </>,
  );
}

function EpicEditor({ epic, others, busy, onSave, onDelete, onClose }: {
  epic: RoadmapEpic;
  /** Every other epic of the project: what this one can wait on. */
  others: { id: string; label: string }[];
  busy: boolean; onSave: (d: { name: string; outcome: string; icon: string; targetDate: string; dependsOn: string[]; qaCommand: string }) => void; onDelete: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(epic.name);
  const [outcome, setOutcome] = useState(epic.outcome);
  const [icon, setIcon] = useState(epic.icon);
  const [targetDate, setTargetDate] = useState(epic.targetDate ?? '');
  const [dependsOn, setDependsOn] = useState<string[]>(epic.dependsOn ?? []);
  const [qaCommand, setQaCommand] = useState(epic.qaCommand ?? '');
  return (
    <form data-epic-editor className="absolute left-0 top-0 z-40 w-[300px] p-3 space-y-2 rounded-[10px] border border-[rgba(96,160,255,0.4)] bg-[#0A1224] shadow-[0_10px_30px_rgba(0,0,0,0.6)]" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name, outcome, icon, targetDate, dependsOn, qaCommand }); }}>
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Epic name" className="glass-input w-full h-8 px-2 rounded-[7px] text-[13px]" />
      <input value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="What this epic delivers" placeholder="What it delivers" className="glass-input w-full h-8 px-2 rounded-[7px] text-[13px]" />
      <div className="flex gap-1 flex-wrap">
        {ART.icons.map((g) => (
          <button type="button" key={g.id} onClick={() => setIcon(g.id)} aria-label={`Icon: ${g.id}`} aria-pressed={icon === g.id}
            className={`w-8 h-8 p-1 rounded-[6px] border ${icon === g.id ? 'border-neon-400 bg-neon-500/15' : 'border-white/10'}`}>
            <img src={g.src} alt="" className="w-full h-full" />
          </button>
        ))}
      </div>
      {/* WHEN THE EPIC IS DUE. Delivered on or before this day, it is a commendation for the project. */}
      <label className="block">
        <span className="block text-[11px] font-semibold text-gray-300 mb-1">Due — deliver it by this day for a commendation</span>
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} aria-label="Epic due date" className="glass-input w-full h-8 px-2 rounded-[7px] text-[13px] text-gray-100" />
      </label>
      {/* EPIC QA: run when its last feature is done, with every feature's locked tests. Empty = the project's. */}
      <label className="block">
        <span className="block text-[11px] font-semibold text-gray-300 mb-1">QA command — overrides the project's for this epic</span>
        <input value={qaCommand} onChange={(e) => setQaCommand(e.target.value)} aria-label="Epic QA command" placeholder="e.g. bash scripts/run_gates.sh 1"
          className="glass-input w-full h-8 px-2 rounded-[7px] text-[13px] font-mono text-gray-100" />
      </label>
      {/* WHAT IT WAITS ON: its features are not offered to start until these epics are delivered. */}
      {others.length > 0 && (
        <fieldset data-epic-waits>
          <legend className="text-[11px] font-semibold text-gray-300 mb-1">Waits on</legend>
          <div className="max-h-[112px] overflow-y-auto space-y-1 pr-1">
            {others.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-[12px] text-gray-200">
                <input type="checkbox" value={o.id} checked={dependsOn.includes(o.id)} className="accent-neon-500"
                  onChange={(e) => setDependsOn(e.target.checked ? [...dependsOn, o.id] : dependsOn.filter((id) => id !== o.id))} />
                <span className="truncate" title={o.label}>{o.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !name.trim()} className="btn-primary h-8 px-3 rounded-[8px] text-[12px] font-semibold disabled:opacity-40">Save</button>
        <button type="button" onClick={onClose} className="btn-ghost h-8 px-3 rounded-[8px] text-[12px]">Cancel</button>
        <button type="button" onClick={onDelete} className="ml-auto h-8 px-2 rounded-[8px] text-[12px] text-red-300 hover:text-red-200">Remove</button>
      </div>
    </form>
  );
}

function FeatureCard({ feature: f, chart, names, busy, epicNumber, planning, onPlanning, onPlan, onOpen, onClose }: {
  feature: RoadmapFeature; chart: Chart; names: ReadonlyMap<string, string>; busy: boolean; epicNumber: number; planning: boolean; onPlanning: (v: boolean) => void;
  onPlan: (d: { epicId?: string; startDate?: string; targetDate?: string; dependsOn?: string[] }) => void; onOpen: () => void; onClose: () => void;
}) {
  const others = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned].filter((o) => o.id !== f.id);
  const why = startBlock(f, names);
  const epic = chart.epics.find((e) => e.id === f.epicId);
  const started = f.state === 'under-way' || f.state === 'delivered';
  const go = 'h-10 px-6 rounded-[10px] text-[15px] font-bold tracking-[0.06em] text-white bg-[#1E9BFF] shadow-[0_0_16px_rgba(63,180,255,0.7)] hover:bg-[#3FB4FF] disabled:opacity-35 disabled:shadow-none disabled:cursor-not-allowed';
  const chip = 'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[7px] border border-white/20 bg-[rgba(10,18,36,0.8)] text-[12px] text-gray-100 whitespace-nowrap';
  return (
    <div data-selected-feature={f.id} className="absolute right-5 bottom-5 z-40 w-[min(560px,calc(100%-40px))] rounded-[14px] border border-[rgba(96,160,255,0.45)] bg-[rgba(6,12,26,0.96)] shadow-[0_0_30px_rgba(30,110,220,0.35)] px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] tracking-[0.14em] text-gray-300 uppercase">Selected {word('waypoint').toLowerCase()}</p>
          <p className="text-[20px] font-semibold text-white flex items-center gap-2.5 mt-1"><Node state={f.state} selected size={20} /><span className="truncate">{f.name}</span></p>
        </div>
        <div className="flex items-center gap-2 shrink-0 border-l border-white/[0.14] pl-4">
          {/* A feature that has started is opened, not started: the same button, saying which. */}
          {started
            ? <button data-open-feature onClick={onOpen} title="Open the feature" className={go}>OPEN ▸</button>
            : <button data-start disabled={why !== ''} onClick={onOpen} title={why || 'Open the feature and start its pipeline'} className={go}>START ▸</button>}
          <button onClick={onClose} aria-label="Close" className="btn-ghost h-10 w-9 rounded-[10px] text-[16px]">×</button>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap mt-3">
        <span className={chip}>{epic ? `EPIC ${epicNumber} — ${epic.name}` : 'No epic'}</span>
        <span className={chip}><span aria-hidden="true">▦</span>{monthOf(dayOf(f))}</span>
        <span className={chip} style={{ borderColor: COLOUR[f.state] }}><Node state={f.state} size={12} />{STATE_LABEL[f.state]}</span>
        {f.blockedBy.length > 0 && <span className={chip} style={{ borderColor: COLOUR.late, color: '#FFC9A3' }}>Waits on {f.blockedBy.map((id) => names.get(id)).join(', ')}</span>}
      </div>
      {f.summary && <p className="text-[14px] text-gray-200 mt-3 leading-snug line-clamp-3">{f.summary}</p>}
      <div className="flex items-center gap-3 mt-3">
        <button data-plan-toggle aria-expanded={planning} onClick={() => onPlanning(!planning)} className="text-[12px] font-semibold text-neon-300 hover:text-white">{planning ? 'Hide plan ▴' : 'Edit plan ▾'}</button>
        <button onClick={onOpen} className="text-[12px] text-gray-400 hover:text-white">Open the feature</button>
      </div>
      {planning && (
        <div data-plan className="mt-3 grid grid-cols-2 gap-3 text-[12px] text-gray-400">
          <label className="flex flex-col gap-1">Epic
            <select disabled={busy} value={f.epicId} onChange={(e) => onPlan({ epicId: e.target.value })} className="glass-input h-9 px-2 rounded-[9px] text-[13px] text-gray-100">
              <option value="">No epic</option>
              {chart.epics.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-1 row-span-2">Waits on
            <div data-depends className="glass-input rounded-[9px] px-2 py-1.5 h-[98px] overflow-y-auto space-y-0.5">
              {others.length === 0 ? <span className="text-gray-500">No other feature</span> : others.map((o) => (
                <label key={o.id} className="flex items-center gap-1.5 text-[12px] text-gray-200 cursor-pointer">
                  <input type="checkbox" disabled={busy} checked={f.dependsOn.includes(o.id)} className="accent-neon-500"
                    onChange={(e) => onPlan({ dependsOn: e.target.checked ? [...f.dependsOn, o.id] : f.dependsOn.filter((id) => id !== o.id) })} />
                  <span className="truncate">{o.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">Starts
              <input type="date" disabled={busy} value={f.startDate} max={f.targetDate || undefined} onChange={(e) => onPlan({ startDate: e.target.value })} className="glass-input h-9 px-2 rounded-[9px] text-[13px] text-gray-100" />
            </label>
            <label className="flex flex-col gap-1">Target date
              <input type="date" disabled={busy} value={f.targetDate} min={f.startDate || undefined} onChange={(e) => onPlan({ targetDate: e.target.value })} className="glass-input h-9 px-2 rounded-[9px] text-[13px] text-gray-100" />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
