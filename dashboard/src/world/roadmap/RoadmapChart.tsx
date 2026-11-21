/**
 * THE ROADMAP DECK — a project's plan as its own screen: the VISION across the top, an EPIC per
 * lane, a FEATURE per waypoint on its date, a line where today is, the officer of the deck at
 * the left, and the selected waypoint's card at the bottom right.
 *
 * It is the planning surface AND the launch surface: drag a waypoint along its lane to change its
 * date or into another lane to change its epic; select one to see it, plan it (its epic, dates,
 * what it waits on) and START it. "Start next" on an epic opens its earliest feature that can start.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Project, RoadmapChart as Chart, RoadmapEpic, RoadmapFeature, RoadmapFeatureState } from '../../types';
import { api } from '../../lib/api';
import { THEME, word } from '../theme';
import { DECK_ART } from '../bridge/art';
import { DeckSprite } from '../bridge/Decks';
import { ROADMAP_ART, type RoadmapStrip } from './roadmapArt.generated';
import { xOf, dateAt, monthColumns, placeLane, visionGauges, startBlock, dayOf, calendarYears } from './chartLayout';

const ART = ROADMAP_ART[THEME] ?? ROADMAP_ART.scifi;
export const STATE_LABEL: Record<RoadmapFeatureState, string> = { delivered: 'Delivered', 'under-way': 'Under way', planned: 'Planned', late: 'Late' };
const LEGEND: readonly RoadmapFeatureState[] = ['delivered', 'under-way', 'planned', 'late'];
const COLOUR: Record<RoadmapFeatureState, string> = { delivered: '#34D36B', 'under-way': '#3FB4FF', planned: '#C9D6EA', late: '#FF8A3D' };

const LABEL_W = 224;          // an epic's label cell, px
const LANE_H = 84;            // a lane with one row of name tags, px
const TAG_ROW = 28;           // each further row of name tags, px
const NODE_Y = 30;            // where the route line runs in a lane, px from its top
const NODE = 18;              // a waypoint's node, px
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : 'That did not work';
  // A server from before the roadmap existed answers "Not Found" — say what to do about it.
  return /not found/i.test(m) ? 'This server does not have the roadmap yet. Rebuild and restart it, then reload this page.' : m;
};
const MONTH_NAME = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthOf = (day: string | null) => (day ? `${MONTH_NAME[Number(day.slice(5, 7)) - 1]} ${day.slice(8, 10)}` : 'No date');

/** The officer's look is what the plan says (same rows as on the Projects bridge). */
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

interface Drag { id: string; fromEpic: string; startX: number; startY: number; x: number; lane: number; moved: boolean }

export function RoadmapChart({ project, version, onOpenFeature, onChanged, toolbar }: {
  project: Project; version: number; onOpenFeature: (id: string) => void; onChanged: () => void;
  /** Controls for the deck's top-left corner (where you are, and the way back). */
  toolbar?: ReactNode;
}) {
  const [chart, setChart] = useState<Chart | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [visionDraft, setVisionDraft] = useState<string | null>(null);
  const [newEpic, setNewEpic] = useState<string | null>(null);
  const [editEpic, setEditEpic] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ deckH: 720, lineW: 1000 });

  useEffect(() => {
    let alive = true;
    api.getRoadmap(project.id).then((c) => { if (alive) { setChart(c); setError(''); } }).catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [project.id, version]);

  // The officer's height follows the deck's, and the dependency lines need the timeline's width.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const measure = () => setSize((s) => {
      const deckH = root.current?.clientHeight || s.deckH;
      const lineW = timeline.current?.clientWidth || s.lineW;
      return deckH === s.deckH && lineW === s.lineW ? s : { deckH, lineW };
    });
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    if (timeline.current) ro.observe(timeline.current);
    measure();
    return () => ro.disconnect();
  }, [chart === null]);

  /** One change: send it, show the chart it answers with, and tell the page its features changed. */
  const change = useCallback(async (call: () => Promise<Chart>) => {
    setBusy(true);
    try { setChart(await call()); setError(''); onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }, [onChanged]);

  // The chart shows whole calendar years: JAN to DEC, however few months the plan covers.
  const range = useMemo(() => (chart ? calendarYears(chart.range) : { from: '', to: '' }), [chart]);

  const lanes = useMemo(() => {
    if (!chart) return [];
    const all: { epic: RoadmapEpic | null; id: string; features: RoadmapFeature[] }[] = chart.epics.map((e) => ({ epic: e, id: e.id, features: e.features }));
    // Features in no epic get a lane only when one of them is on the timeline (or there is no epic at all).
    if (chart.unassigned.some((f) => dayOf(f) !== null) || chart.epics.length === 0) all.push({ epic: null, id: '', features: chart.unassigned });
    let top = 0;
    return all.map((l) => {
      const laid = placeLane(l.features, range, 0.088);
      const height = LANE_H + (laid.rows - 1) * TAG_ROW;
      const lane = { ...l, ...laid, top, height };
      top += height + 6;
      return lane;
    });
  }, [chart, range]);

  const shell = (inner: ReactNode) => (
    <div ref={root} data-roadmap-chart data-theme={THEME} className="relative h-full min-h-[600px] overflow-hidden text-gray-100"
      style={ART.deck ? { backgroundImage: `url(${ART.deck})`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundColor: '#050912' } : { backgroundColor: '#050912' }}>
      {inner}
    </div>
  );
  if (!chart) {
    return shell(
      <div className="absolute inset-0 flex flex-col gap-3 p-5">
        {toolbar}
        <p className={`text-[14px] ${error ? 'text-ember-300' : 'text-gray-400'}`}>{error || 'Loading…'}</p>
      </div>,
    );
  }

  const everyFeature = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned];
  const names = new Map(everyFeature.map((f) => [f.id, f.name]));
  const picked = everyFeature.find((f) => f.id === selected) ?? null;
  const unplanned = everyFeature.filter((f) => dayOf(f) === null);
  const months = monthColumns(range);
  const todayX = xOf(chart.today, range);
  const gauges = visionGauges(chart);
  const totalH = lanes.reduce((n, l) => Math.max(n, l.top + l.height), 0);
  const epicNumber = (id: string) => chart.epics.findIndex((e) => e.id === id) + 1;
  const iconOf = (epic: RoadmapEpic, i: number) => ART.icons.find((g) => g.id === epic.icon) ?? ART.icons[i % Math.max(1, ART.icons.length)];

  // Where each dated feature's node is, in the timeline's own box — for the dependency lines.
  const at = new Map<string, { x: number; y: number }>();
  for (const l of lanes) for (const p of l.placed) at.set(p.feature.id, { x: p.x, y: l.top + NODE_Y });

  const laneAtY = (y: number) => {
    const i = lanes.findIndex((l) => y >= l.top && y < l.top + l.height + 6);
    return i < 0 ? (y < 0 ? 0 : lanes.length - 1) : i;
  };
  const point = (e: ReactPointerEvent) => {
    const box = timeline.current!.getBoundingClientRect();
    return { x: (e.clientX - box.left) / (box.width || 1), y: e.clientY - box.top };
  };
  const onDown = (e: ReactPointerEvent, f: RoadmapFeature) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = point(e);
    setDrag({ id: f.id, fromEpic: f.epicId, startX: e.clientX, startY: e.clientY, x: p.x, lane: laneAtY(p.y), moved: false });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = point(e);
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5;
    setDrag({ ...drag, x: Math.min(1, Math.max(0, p.x)), lane: laneAtY(p.y), moved });
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    setSelected(d.id);
    if (!d.moved) return;
    const epicId = lanes[d.lane]?.id ?? d.fromEpic;
    void change(() => api.planFeature(d.id, { targetDate: dateAt(d.x, range), ...(epicId !== d.fromEpic ? { epicId } : {}) }));
  };

  const officerH = Math.round(Math.min(340, Math.max(200, size.deckH * 0.42)));
  const glass = 'rounded-[14px] border border-[rgba(96,160,255,0.28)] bg-[rgba(6,12,26,0.78)] backdrop-blur-[3px]';

  return shell(
    <>
      <div className="absolute inset-0 flex flex-col gap-3 px-5 pt-3 pb-4">
        {/* ── VISION ───────────────────────────────────────────────────────── */}
        <div data-vision className={`${glass} px-6 py-3 flex items-center gap-6`}>
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
            {toolbar && <div className="self-stretch mb-auto pt-1">{toolbar}</div>}
            <DeckSprite sheet={DECK_ART.sheets.captain} cycle={officerAnim(chart.totals)} fps={4} height={officerH} />
          </div>

          {/* ── THE CHART ────────────────────────────────────────────────── */}
          <div className={`${glass} flex-1 min-w-0 flex flex-col`}>
            <div className="flex items-center justify-between gap-4 flex-wrap px-6 pt-4 pb-3 border-b border-white/[0.08]">
              <h3 className="font-display text-[19px] font-semibold tracking-[0.08em] text-white uppercase">Roadmap — {word('roadmap')}</h3>
              <div className="flex items-center gap-5 flex-wrap text-[13px] text-gray-200">
                {LEGEND.map((s) => (
                  <span key={s} data-legend={s} className="inline-flex items-center gap-2"><Node state={s} size={14} />{STATE_LABEL[s]}<span className="text-gray-500 tabular-nums">{chart.totals[s]}</span></span>
                ))}
                <span className="inline-flex items-center gap-2 border-l border-white/[0.16] pl-5"><span className="w-7 border-t-2 border-dotted border-[#9CCBFF]" />Dependency</span>
                {newEpic === null
                  ? <button onClick={() => setNewEpic('')} className="btn-ghost h-8 px-3 rounded-[9px] text-[12px] font-semibold">+ Epic</button>
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

            <div className="flex-1 min-h-0 overflow-auto px-5 pb-4" style={{ paddingBottom: picked ? 190 : undefined }}>
              <div style={{ minWidth: 940 }}>
                {/* months, and TODAY */}
                <div className="flex sticky top-0 z-30 bg-[rgba(6,12,26,0.92)]" style={{ paddingLeft: LABEL_W }}>
                  <div className="relative flex-1 h-11">
                    {months.map((m) => (
                      <span key={m.key} data-month={m.key} className="absolute top-3 text-[13px] tracking-[0.12em] text-gray-200 text-center" style={{ left: `${m.from * 100}%`, width: `${(m.to - m.from) * 100}%` }}>
                        {m.label}{months.length > 12 && m.label === 'JAN' ? ` ’${String(m.year).slice(2)}` : ''}
                      </span>
                    ))}
                    <span data-today-pill className="absolute top-2 -translate-x-1/2 px-3 h-7 rounded-[8px] bg-[#1E9BFF] text-white text-[12px] font-bold tracking-[0.1em] flex items-center shadow-[0_0_14px_rgba(63,180,255,0.9)]" style={{ left: `${todayX * 100}%` }} title={`${word('today')} — ${chart.today}`}>TODAY</span>
                  </div>
                </div>

                <div className="flex">
                  {/* the epics */}
                  <div style={{ width: LABEL_W, height: totalH }} className="shrink-0 relative">
                    {lanes.map((l, i) => (
                      <div key={l.id || 'none'} data-epic-label={l.id || 'none'} style={{ top: l.top, height: l.height }}
                        className="group absolute left-0 right-0 border border-r-0 border-[rgba(96,160,255,0.2)] rounded-l-[8px] bg-[rgba(10,18,36,0.7)] px-3 py-2.5 flex gap-3 items-start overflow-hidden">
                        {l.epic && iconOf(l.epic, i) ? <img src={iconOf(l.epic, i).src} alt="" className="w-9 h-9 mt-1 shrink-0" /> : <span className="w-9 h-9 shrink-0" />}
                        <div className="min-w-0 flex-1">
                          {l.epic && editEpic === l.epic.id ? (
                            <EpicEditor epic={l.epic} busy={busy} onClose={() => setEditEpic(null)}
                              onSave={(data) => { void change(() => api.updateEpic(l.epic!.id, data)); setEditEpic(null); }}
                              onDelete={() => { if (confirm(`Remove the epic "${l.epic!.name}"? Its ${l.epic!.features.length} feature(s) stay in the project, in no epic.`)) { void change(() => api.deleteEpic(l.epic!.id)); setEditEpic(null); } }} />
                          ) : (
                            <>
                              <div className="flex items-baseline gap-2">
                                <span className="text-[12px] font-bold tracking-[0.08em] text-white uppercase">{l.epic ? `Epic ${epicNumber(l.epic.id)}` : 'No epic'}</span>
                                {l.epic && <button onClick={() => setEditEpic(l.epic!.id)} className="text-[11px] text-gray-500 hover:text-neon-300 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Edit the epic ${l.epic.name}`}>edit</button>}
                              </div>
                              <p className="text-[13px] font-semibold text-gray-100 truncate" title={l.epic?.name}>{l.epic ? l.epic.name : 'Unassigned'}</p>
                              <p className="text-[11px] text-gray-400 leading-snug line-clamp-2">{l.epic ? (l.epic.outcome || `${l.epic.progress.done} of ${l.epic.progress.total} delivered`) : 'Drag a feature into an epic’s lane.'}</p>
                              {l.epic?.nextUp && (
                                <button data-start-next={l.epic.id} onClick={() => onOpenFeature(l.epic!.nextUp!)} className="absolute right-2 top-2 text-[10px] font-bold tracking-[0.06em] uppercase text-neon-300 hover:text-white opacity-0 group-hover:opacity-100 focus:opacity-100" title={`Start next: ${names.get(l.epic.nextUp)}`}>
                                  Start next ▸
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* the timeline */}
                  <div ref={timeline} data-timeline className="relative flex-1 select-none touch-none" style={{ height: totalH }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
                    {lanes.map((l, i) => {
                      const lastDone = Math.max(-1, ...l.placed.filter((p) => p.feature.state === 'delivered').map((p) => p.x));
                      const lastLive = Math.max(lastDone, ...l.placed.filter((p) => p.feature.state === 'under-way').map((p) => p.x));
                      const first = l.placed.length ? l.placed[0].x : 0;
                      const last = l.placed.length ? l.placed[l.placed.length - 1].x : 0;
                      return (
                        <div key={l.id || 'none'} data-lane={l.id || 'none'} className={`absolute left-0 right-0 border border-[rgba(96,160,255,0.2)] rounded-r-[8px] ${drag?.moved && drag.lane === i ? 'bg-[rgba(63,180,255,0.1)]' : 'bg-[rgba(8,14,30,0.55)]'}`} style={{ top: l.top, height: l.height }}>
                          {months.slice(1).map((m) => <div key={m.key} className="absolute top-0 bottom-0 border-l border-white/[0.06]" style={{ left: `${m.from * 100}%` }} />)}
                          {/* THE ROUTE: travelled (green) up to the last delivery, under way (blue) from there, ahead (faint) to the last waypoint. */}
                          {l.placed.length > 0 && <div data-route="ahead" className="absolute h-[2px] bg-[rgba(140,170,220,0.28)]" style={{ top: NODE_Y - 1, left: `${Math.max(0, first - 0.025) * 100}%`, width: `${(Math.min(1, last + 0.03) - Math.max(0, first - 0.025)) * 100}%` }} />}
                          {lastLive > lastDone && <div data-route="under-way" className="absolute h-[2px]" style={{ top: NODE_Y - 1, left: `${Math.max(0, lastDone < 0 ? first - 0.025 : lastDone) * 100}%`, width: `${(lastLive - Math.max(0, lastDone < 0 ? first - 0.025 : lastDone)) * 100}%`, background: COLOUR['under-way'], boxShadow: `0 0 8px ${COLOUR['under-way']}` }} />}
                          {lastDone >= 0 && <div data-route="delivered" className="absolute h-[2px]" style={{ top: NODE_Y - 1, left: `${Math.max(0, first - 0.025) * 100}%`, width: `${(lastDone - Math.max(0, first - 0.025)) * 100}%`, background: COLOUR.delivered, boxShadow: `0 0 8px ${COLOUR.delivered}` }} />}
                        </div>
                      );
                    })}

                    {/* what waits on what: down (or up) to the waiting feature's lane, then along it */}
                    <svg className="absolute inset-0 w-full h-full pointer-events-none z-[5]" aria-hidden="true">
                      {everyFeature.flatMap((f) => f.dependsOn.map((dep) => {
                        const a = at.get(dep); const b = at.get(f.id);
                        if (!a || !b) return null;
                        const ax = a.x * size.lineW; const bx = b.x * size.lineW;
                        const points = a.y === b.y ? `${ax},${a.y - 12} ${ax},${a.y - 20} ${bx},${b.y - 20} ${bx},${b.y - 12}` : `${ax},${a.y + (b.y > a.y ? 12 : -12)} ${ax},${b.y} ${bx - (bx > ax ? 12 : -12)},${b.y}`;
                        return <polyline key={`${dep}>${f.id}`} data-dependency={`${dep}>${f.id}`} points={points} fill="none" stroke={f.blockedBy.includes(dep) ? COLOUR.late : '#9CCBFF'} strokeWidth="2" strokeDasharray="2 5" strokeLinecap="round" />;
                      }))}
                    </svg>

                    {/* today */}
                    <div data-today className="absolute top-0 bottom-0 pointer-events-none z-[6]" style={{ left: `${todayX * 100}%` }}>
                      <div className="absolute -top-3 bottom-0 -ml-px w-[2px] bg-[#3FB4FF] shadow-[0_0_14px_rgba(63,180,255,1)]" />
                      {ART.today && <div className="absolute -translate-x-1/2 -bottom-1"><Strip art={ART.today} height={24} fps={8} /></div>}
                    </div>

                    {/* the features */}
                    {lanes.flatMap((l) => l.placed.map((p) => {
                      const f = p.feature;
                      const dragging = drag?.id === f.id && drag.moved;
                      const x = dragging ? drag!.x : p.x;
                      const top = dragging ? lanes[drag!.lane].top : l.top;
                      const on = selected === f.id;
                      const c = COLOUR[f.state];
                      const lit = on || f.state === 'under-way' || f.state === 'late';
                      return (
                        <div key={f.id} data-waypoint={f.id} data-state={f.state} data-blocked={f.blockedBy.length > 0 || undefined} data-selected={on || undefined}
                          role="button" tabIndex={0} aria-label={`${f.name}, ${STATE_LABEL[f.state].toLowerCase()}, ${monthOf(dayOf(f))}`}
                          onPointerDown={(e) => onDown(e, f)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(f.id); } }}
                          className={`absolute -translate-x-1/2 flex flex-col items-center cursor-grab active:cursor-grabbing outline-none focus-visible:[&>span:last-child]:ring-2 ${dragging ? 'z-20 opacity-90' : on ? 'z-[12]' : 'z-10'}`}
                          style={{ left: `${x * 100}%`, top: top + NODE_Y - NODE / 2 }}>
                          <Node state={f.state} selected={on} />
                          <span className="px-2.5 h-[24px] rounded-[7px] border text-[12px] whitespace-nowrap max-w-[168px] truncate flex items-center gap-1.5"
                            style={{
                              marginTop: 9 + p.row * TAG_ROW, color: lit ? '#FFFFFF' : '#D5DEEC',
                              borderColor: lit ? c : 'rgba(150,175,215,0.38)', background: on ? 'rgba(20,70,130,0.92)' : f.state === 'late' ? 'rgba(60,24,6,0.92)' : 'rgba(10,18,36,0.94)',
                              boxShadow: lit ? `0 0 ${on ? 14 : 8}px ${c}90` : undefined,
                            }}>
                            {f.state === 'late' && <span aria-hidden="true" style={{ color: c }}>⚠</span>}{f.name}
                          </span>
                        </div>
                      );
                    }))}
                  </div>
                </div>

                {/* features with no date: off the chart until they are given one */}
                {unplanned.length > 0 && (
                  <div data-unplanned className="mt-3 flex items-center gap-2 flex-wrap" style={{ paddingLeft: LABEL_W }}>
                    <span className="text-[11px] tracking-[0.12em] uppercase text-gray-400">Not on the chart yet</span>
                    {unplanned.map((f) => (
                      <button key={f.id} data-waypoint={f.id} data-state={f.state} data-unscheduled onClick={() => { setSelected(f.id); setPlanning(true); }}
                        className={`px-2.5 h-6 rounded-[7px] border border-dashed text-[12px] truncate max-w-[190px] ${selected === f.id ? 'border-[#3FB4FF] text-white' : 'border-white/30 text-gray-300 hover:border-white/60'}`} title="Give it a target date to put it on the chart">
                        {f.name}
                      </button>
                    ))}
                  </div>
                )}
                {everyFeature.length === 0 && <p className="text-[13px] text-gray-400 mt-4" style={{ paddingLeft: LABEL_W }}>No features to plan yet. Add features to the project, then give them an epic and a date here.</p>}
              </div>
            </div>
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

function EpicEditor({ epic, busy, onSave, onDelete, onClose }: {
  epic: RoadmapEpic; busy: boolean; onSave: (d: { name: string; outcome: string; icon: string }) => void; onDelete: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(epic.name);
  const [outcome, setOutcome] = useState(epic.outcome);
  const [icon, setIcon] = useState(epic.icon);
  return (
    <form data-epic-editor className="absolute left-0 top-0 z-40 w-[300px] p-3 space-y-2 rounded-[10px] border border-[rgba(96,160,255,0.4)] bg-[#0A1224] shadow-[0_10px_30px_rgba(0,0,0,0.6)]" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name, outcome, icon }); }}>
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
