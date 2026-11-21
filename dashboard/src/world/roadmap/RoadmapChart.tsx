/**
 * THE ROADMAP CHART — a project's plan as a timeline: VISION at the top, an EPIC per lane, a
 * FEATURE per waypoint, and a line where today is.
 *
 * It is the planning surface AND the launch surface: drag a waypoint along its lane to change its
 * date or into another lane to change its epic; select one to set its dates, its epic and what it
 * waits on; press Start to open the feature and run its pipeline. "Start next" on an epic opens
 * the earliest feature of that epic that can start.
 *
 * Nothing here decides anything about the work: every state, date, dependency and "next up" comes
 * from the server's chart (server lib/roadmap.ts), and every change is one call that answers with
 * the chart as it now is. Positions are chartLayout.ts.
 *
 * The drawn parts — the room behind, the destination, the marker on the today line, the epic
 * glyphs and the waypoint markers — are the theme's (roadmapArt.generated.ts, ../theme.ts): a
 * star chart on a ship's bridge, or a quest map in a cartographer's room. A theme with a piece
 * missing draws that piece plainly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Project, RoadmapChart as Chart, RoadmapEpic, RoadmapFeature, RoadmapFeatureState } from '../../types';
import { api } from '../../lib/api';
import { THEME, word } from '../theme';
import { ROADMAP_ART, type RoadmapStrip } from './roadmapArt.generated';
import { xOf, dateAt, monthColumns, placeLane, visionGauges, startBlock, dayOf } from './chartLayout';

const ART = ROADMAP_ART[THEME] ?? ROADMAP_ART.scifi;
const STATE_LABEL: Record<RoadmapFeatureState, string> = { planned: 'Planned', 'under-way': 'Under way', delivered: 'Delivered', late: 'Late' };
const STATE_TONE: Record<RoadmapFeatureState, { ring: string; text: string; dot: string }> = {
  planned: { ring: 'border-white/30', text: 'text-gray-300', dot: 'bg-transparent border border-white/50' },
  'under-way': { ring: 'border-neon-500 shadow-[0_0_14px_rgba(90,174,255,0.55)]', text: 'text-neon-200', dot: 'bg-neon-500 shadow-[0_0_10px_rgba(90,174,255,0.9)]' },
  delivered: { ring: 'border-emerald-400/70', text: 'text-emerald-200', dot: 'bg-emerald-400' },
  late: { ring: 'border-ember-500 shadow-[0_0_14px_rgba(255,138,61,0.5)]', text: 'text-ember-300', dot: 'bg-ember-500 shadow-[0_0_10px_rgba(255,138,61,0.9)]' },
};
const LABEL_W = 230;          // the epic's label column, px
const LANE_BASE = 88;         // a lane with one row of name tags (and room for the epic's label), px
const TAG_ROW = 26;           // each further row of name tags, px
const NODE_Y = 26;            // where the route line runs in a lane, px from its top
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : 'That did not work';
  // A server from before the roadmap existed answers "Not Found" — say what to do about it.
  return /not found/i.test(m) ? 'This server does not have the roadmap yet. Rebuild and restart it, then reload this page.' : m;
};

/** A drawn strip of frames, stepping (the same strip animation as every other sprite). */
function Strip({ art, height, fps = 4 }: { art: RoadmapStrip; height: number; fps?: number }) {
  const width = (height * art.frameW) / art.frameH;
  return (
    <div aria-hidden="true" className="overflow-hidden shrink-0" style={{ width, height }}>
      <div
        className="world-strip"
        style={{
          width: width * art.frames, height, backgroundImage: `url(${art.src})`, backgroundRepeat: 'no-repeat',
          backgroundSize: `${width * art.frames}px ${height}px`, animationDuration: `${art.frames / fps}s`, animationTimingFunction: `steps(${art.frames})`,
        }}
      />
    </div>
  );
}

function Ring({ label, value }: { label: string; value: number }) {
  const sweep = Math.round((value / 100) * 270);
  return (
    <div data-vision-gauge={label} className="flex flex-col items-center gap-1 w-[92px]">
      <div
        className="relative w-[64px] h-[64px] rounded-full"
        style={{ background: `conic-gradient(from 225deg, #5AAEFF ${sweep}deg, rgba(120,150,255,0.16) ${sweep}deg 270deg, transparent 270deg)` }}
      >
        <div className="absolute inset-[6px] rounded-full bg-[#070C18] flex items-center justify-center text-[15px] font-semibold text-gray-100 tabular-nums">{value}%</div>
      </div>
      <span className="text-[10px] tracking-[0.14em] text-gray-400 uppercase">{label}</span>
    </div>
  );
}

interface Drag { id: string; fromEpic: string; startX: number; startY: number; x: number; lane: number; moved: boolean }

export function RoadmapChart({ project, version, onOpenFeature, onChanged }: {
  project: Project; version: number; onOpenFeature: (id: string) => void; onChanged: () => void;
}) {
  const [chart, setChart] = useState<Chart | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [visionDraft, setVisionDraft] = useState<string | null>(null);
  const [newEpic, setNewEpic] = useState<string | null>(null);
  const [editEpic, setEditEpic] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const timeline = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.getRoadmap(project.id).then((c) => { if (alive) { setChart(c); setError(''); } }).catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [project.id, version]);

  /** One change: send it, show the chart it answers with, and tell the page its features changed. */
  const change = useCallback(async (call: () => Promise<Chart>) => {
    setBusy(true);
    try { setChart(await call()); setError(''); onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }, [onChanged]);

  const lanes = useMemo(() => {
    if (!chart) return [];
    const all: { epic: RoadmapEpic | null; id: string; features: RoadmapFeature[] }[] = chart.epics.map((e) => ({ epic: e, id: e.id, features: e.features }));
    if (chart.unassigned.length > 0 || chart.epics.length === 0) all.push({ epic: null, id: '', features: chart.unassigned });
    let top = 0;
    return all.map((l) => {
      const laid = placeLane(l.features, chart.range);
      const height = LANE_BASE + (laid.rows - 1) * TAG_ROW + (laid.unscheduled.length > 0 ? 30 : 0);
      const lane = { ...l, ...laid, top, height };
      top += height;
      return lane;
    });
  }, [chart]);

  if (error && !chart) return <p className="text-[13px] text-ember-300">{error}</p>;
  if (!chart) return <p className="text-[13px] text-gray-500">Loading…</p>;

  const everyFeature = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned];
  const names = new Map(everyFeature.map((f) => [f.id, f.name]));
  const picked = everyFeature.find((f) => f.id === selected) ?? null;
  const months = monthColumns(chart.range);
  const todayX = xOf(chart.today, chart.range);
  const gauges = visionGauges(chart);
  const totalH = lanes.reduce((n, l) => n + l.height, 0);
  const iconOf = (epic: RoadmapEpic, i: number) => ART.icons.find((g) => g.id === epic.icon) ?? ART.icons[i % Math.max(1, ART.icons.length)];

  // Where each dated feature's marker is, in the timeline's own box — for the dependency lines.
  const at = new Map<string, { x: number; y: number }>();
  for (const l of lanes) for (const p of l.placed) at.set(p.feature.id, { x: p.x, y: l.top + NODE_Y });

  const laneAtY = (y: number) => {
    const i = lanes.findIndex((l) => y >= l.top && y < l.top + l.height);
    return i < 0 ? (y < 0 ? 0 : lanes.length - 1) : i;
  };
  const point = (e: ReactPointerEvent) => {
    const box = timeline.current!.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: e.clientY - box.top };
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
    if (!d.moved) { setSelected(d.id); return; }
    const epicId = lanes[d.lane]?.id ?? d.fromEpic;
    void change(() => api.planFeature(d.id, { targetDate: dateAt(d.x, chart.range), ...(epicId !== d.fromEpic ? { epicId } : {}) }));
    setSelected(d.id);
  };

  const frame: CSSProperties = ART.deck
    ? { backgroundImage: `linear-gradient(rgba(4,6,12,0.72), rgba(4,6,12,0.86)), url(${ART.deck})`, backgroundSize: 'cover', backgroundPosition: 'center top' }
    : {};

  return (
    <div data-roadmap-chart data-theme={THEME} className="rounded-[18px] border border-white/[0.1] p-4 space-y-4" style={frame}>
      {/* ── VISION ─────────────────────────────────────────────────────────── */}
      <div data-vision className="glass-light rounded-[16px] px-5 py-4 flex items-center gap-5 flex-wrap">
        <span className="font-display text-[20px] font-semibold tracking-[0.12em] text-gray-100">VISION</span>
        <div className="flex-1 min-w-[240px] border-l border-white/[0.12] pl-5">
          {visionDraft !== null ? (
            <div className="flex items-start gap-2">
              <textarea
                autoFocus value={visionDraft} onChange={(e) => setVisionDraft(e.target.value)} rows={2} aria-label="The project's vision"
                className="glass-input flex-1 rounded-[10px] px-3 py-2 text-[14px] text-gray-100" placeholder="Where is this project going? One or two sentences."
              />
              <button disabled={busy} onClick={() => { void change(() => api.setRoadmapVision(project.id, visionDraft)); setVisionDraft(null); }} className="btn-primary h-9 px-3 rounded-[10px] text-[13px] font-semibold">Save</button>
              <button onClick={() => setVisionDraft(null)} className="btn-ghost h-9 px-3 rounded-[10px] text-[13px]">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setVisionDraft(chart.vision)} className="text-left w-full group" title="Edit the vision">
              <span className={`text-[15px] leading-snug ${chart.vision ? 'text-gray-100' : 'text-gray-500 italic'}`}>
                {chart.vision || 'No vision yet. Say where this project is going — every feature started from here is told.'}
              </span>
              <span className="ml-2 text-[12px] text-neon-300 opacity-0 group-hover:opacity-100 group-focus:opacity-100">edit</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Ring label="Delivered" value={gauges.delivered} />
          <Ring label="Scheduled" value={gauges.scheduled} />
          <Ring label="On track" value={gauges.onTrack} />
        </div>
        <div data-destination className="flex flex-col items-center gap-1 w-[150px]">
          {ART.destination ? <Strip art={ART.destination} height={72} fps={2} /> : <div className="w-[60px] h-[60px] rounded-full bg-neon-500/40" />}
          <span className="text-[10px] tracking-[0.14em] text-gray-400 uppercase">{word('destination')}</span>
          <span className="text-[11px] tracking-[0.1em] text-gray-200 uppercase text-center leading-tight">{chart.project.name}</span>
        </div>
      </div>

      {/* ── THE CHART ──────────────────────────────────────────────────────── */}
      <div className="glass-dark rounded-[16px] p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h3 className="font-display text-[15px] font-semibold tracking-[0.14em] text-gray-100 uppercase">Roadmap — {word('roadmap')}</h3>
          <div className="flex items-center gap-4 flex-wrap text-[12px] text-gray-300">
            {(Object.keys(STATE_LABEL) as RoadmapFeatureState[]).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-full ${STATE_TONE[s].dot}`} />{STATE_LABEL[s]} <span className="text-gray-500 tabular-nums">{chart.totals[s]}</span></span>
            ))}
            <span className="inline-flex items-center gap-1.5 text-gray-400"><span className="w-5 border-t border-dotted border-neon-300" />Waits on</span>
            {newEpic === null
              ? <button onClick={() => setNewEpic('')} className="btn-ghost h-8 px-3 rounded-[10px] text-[12px] font-semibold">+ Epic</button>
              : (
                <form className="inline-flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (newEpic.trim()) { void change(() => api.createEpic(project.id, { name: newEpic })); setNewEpic(null); } }}>
                  <input autoFocus value={newEpic} onChange={(e) => setNewEpic(e.target.value)} placeholder="Epic name" aria-label="New epic name" className="glass-input h-8 px-2 rounded-[8px] text-[12px] w-[170px]" />
                  <button type="submit" disabled={busy || !newEpic.trim()} className="btn-primary h-8 px-3 rounded-[10px] text-[12px] font-semibold disabled:opacity-40">Add</button>
                  <button type="button" onClick={() => setNewEpic(null)} className="btn-ghost h-8 px-2 rounded-[10px] text-[12px]">Cancel</button>
                </form>
              )}
          </div>
        </div>
        {error && <p className="text-[13px] text-ember-300 mb-2">{error}</p>}

        <div className="overflow-x-auto">
          <div style={{ minWidth: 900 }}>
            {/* months */}
            <div className="flex" style={{ paddingLeft: LABEL_W }}>
              <div className="relative flex-1 h-7">
                {months.map((m) => (
                  <span key={m.key} data-month={m.key} className="absolute top-0 text-[11px] tracking-[0.14em] text-gray-400 text-center" style={{ left: `${m.from * 100}%`, width: `${(m.to - m.from) * 100}%` }}>
                    {m.label}{m.label === 'JAN' ? ` ${m.year}` : ''}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex">
              {/* the epics' labels */}
              <div style={{ width: LABEL_W }} className="shrink-0">
                {lanes.map((l, i) => (
                  <div key={l.id || 'none'} data-epic-label={l.id || 'none'} style={{ height: l.height }} className="border-t border-white/[0.08] pr-3 py-2 flex gap-2.5 items-start">
                    {l.epic && iconOf(l.epic, i) ? <img src={iconOf(l.epic, i).src} alt="" className="w-8 h-8 mt-0.5 shrink-0 opacity-90" /> : <span className="w-8 h-8 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      {l.epic && editEpic === l.epic.id ? (
                        <EpicEditor epic={l.epic} busy={busy} onClose={() => setEditEpic(null)}
                          onSave={(data) => { void change(() => api.updateEpic(l.epic!.id, data)); setEditEpic(null); }}
                          onDelete={() => { if (confirm(`Remove the epic "${l.epic!.name}"? Its ${l.epic!.features.length} feature(s) stay in the project, in no epic.`)) { void change(() => api.deleteEpic(l.epic!.id)); setEditEpic(null); } }} />
                      ) : (
                        <>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[13px] font-semibold text-gray-100 truncate" title={l.epic?.name}>{l.epic ? l.epic.name : 'No epic yet'}</span>
                            {l.epic && <button onClick={() => setEditEpic(l.epic!.id)} className="text-[11px] text-gray-500 hover:text-neon-300" aria-label={`Edit the epic ${l.epic.name}`}>edit</button>}
                          </div>
                          <p className="text-[11px] text-gray-400 leading-snug line-clamp-2">{l.epic ? (l.epic.outcome || `${l.epic.progress.done} of ${l.epic.progress.total} delivered`) : 'Drag a feature into an epic’s lane.'}</p>
                          {l.epic?.nextUp && (
                            <button data-start-next={l.epic.id} onClick={() => onOpenFeature(l.epic!.nextUp!)} className="mt-1 text-[11px] font-semibold text-neon-300 hover:text-neon-200" title={`Open ${names.get(l.epic.nextUp)} to start it`}>
                              Start next ▸ <span className="font-normal text-gray-400">{names.get(l.epic.nextUp)}</span>
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
                {months.map((m) => <div key={m.key} className="absolute top-0 bottom-0 border-l border-white/[0.05]" style={{ left: `${m.from * 100}%` }} />)}
                {lanes.map((l, i) => (
                  <div key={l.id || 'none'} data-lane={l.id || 'none'} className={`absolute left-0 right-0 border-t border-white/[0.08] ${drag?.moved && drag.lane === i ? 'bg-neon-500/[0.06]' : ''}`} style={{ top: l.top, height: l.height }}>
                    <div className="absolute left-0 right-0 border-t border-neon-500/25" style={{ top: NODE_Y }} />
                    {l.unscheduled.length > 0 && (
                      <div className="absolute left-2 right-2 bottom-1.5 flex items-center gap-1.5 overflow-hidden">
                        <span className="text-[10px] tracking-[0.1em] uppercase text-gray-500 shrink-0">No date</span>
                        {l.unscheduled.map((f) => (
                          <button key={f.id} data-waypoint={f.id} data-state={f.state} data-unscheduled onClick={() => setSelected(f.id)}
                            className={`px-2 h-5 rounded-full border border-dashed text-[11px] truncate max-w-[160px] ${selected === f.id ? 'border-neon-400 text-neon-200' : 'border-white/25 text-gray-300 hover:border-white/50'}`}>
                            {f.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {/* what waits on what */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
                  {everyFeature.flatMap((f) => f.dependsOn.map((dep) => {
                    const a = at.get(dep); const b = at.get(f.id);
                    if (!a || !b) return null;
                    return <line key={`${dep}>${f.id}`} data-dependency={`${dep}>${f.id}`} x1={`${a.x * 100}%`} y1={a.y} x2={`${b.x * 100}%`} y2={b.y} stroke={f.blockedBy.includes(dep) ? '#FF8A3D' : '#7CC4FF'} strokeWidth="1.5" strokeDasharray="2 5" strokeLinecap="round" opacity="0.8" />;
                  }))}
                </svg>

                {/* today */}
                <div data-today className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${todayX * 100}%` }} title={word('today')}>
                  <div className="absolute top-0 bottom-0 -ml-px w-[2px] bg-neon-500 shadow-[0_0_12px_rgba(90,174,255,0.9)]" />
                  <div className="absolute -top-7 -translate-x-1/2 px-2 h-5 rounded-[6px] bg-neon-500 text-[#04060C] text-[10px] font-bold tracking-[0.12em] flex items-center">TODAY</div>
                  {ART.today && <div className="absolute -translate-x-1/2 bottom-0"><Strip art={ART.today} height={26} fps={8} /></div>}
                </div>

                {/* the features */}
                {lanes.flatMap((l) => l.placed.map((p) => {
                  const f = p.feature;
                  const dragging = drag?.id === f.id && drag.moved;
                  const x = dragging ? drag!.x : p.x;
                  const top = dragging ? lanes[drag!.lane].top : l.top;
                  const tone = STATE_TONE[f.state];
                  const marker = ART.waypoints?.[f.state];
                  return (
                    <div key={f.id} data-waypoint={f.id} data-state={f.state} data-blocked={f.blockedBy.length > 0 || undefined} data-selected={selected === f.id || undefined}
                      role="button" tabIndex={0} aria-label={`${f.name}, ${STATE_LABEL[f.state].toLowerCase()}${dayOf(f) ? `, ${dayOf(f)}` : ''}`}
                      onPointerDown={(e) => onDown(e, f)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(f.id); } }}
                      className={`absolute -translate-x-1/2 flex flex-col items-center cursor-grab active:cursor-grabbing outline-none ${dragging ? 'z-20 opacity-90' : 'z-10'}`}
                      style={{ left: `${x * 100}%`, top: top + NODE_Y - 16 }}>
                      {marker
                        ? <img src={marker} alt="" draggable={false} className={`h-[32px] w-auto ${selected === f.id ? 'drop-shadow-[0_0_8px_rgba(90,174,255,0.95)]' : ''}`} />
                        : <span className={`w-4 h-4 mt-[5px] mb-[5px] rounded-full ${tone.dot}`} />}
                      <span className={`mt-1 px-2 h-[20px] rounded-[7px] border bg-[#0A1020]/95 text-[11px] whitespace-nowrap max-w-[150px] truncate flex items-center ${tone.ring} ${tone.text} ${selected === f.id ? 'ring-1 ring-neon-300' : ''}`}
                        style={{ marginTop: 4 + p.row * TAG_ROW }}>
                        {f.state === 'late' && <span aria-hidden="true" className="mr-1">▲</span>}{f.name}
                      </span>
                    </div>
                  );
                }))}
              </div>
            </div>
          </div>
        </div>
        {everyFeature.length === 0 && <p className="text-[13px] text-gray-500 mt-3">No features to plan yet. Add features to the project, then give them an epic and a date here.</p>}
        <p className="text-[12px] text-gray-500 mt-3">Drag a feature along its lane to change its date, or into another lane to change its epic. Select one to set what it waits on.</p>
      </div>

      {/* ── THE SELECTED FEATURE ───────────────────────────────────────────── */}
      {picked && (
        <FeaturePanel key={picked.id} feature={picked} chart={chart} names={names} busy={busy}
          onPlan={(data) => void change(() => api.planFeature(picked.id, data))} onOpen={() => onOpenFeature(picked.id)} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function EpicEditor({ epic, busy, onSave, onDelete, onClose }: {
  epic: RoadmapEpic; busy: boolean; onSave: (d: { name: string; outcome: string; icon: string }) => void; onDelete: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(epic.name);
  const [outcome, setOutcome] = useState(epic.outcome);
  const [icon, setIcon] = useState(epic.icon);
  return (
    <form data-epic-editor className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name, outcome, icon }); }}>
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Epic name" className="glass-input w-full h-7 px-2 rounded-[7px] text-[12px]" />
      <input value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="What this epic delivers" placeholder="What it delivers" className="glass-input w-full h-7 px-2 rounded-[7px] text-[12px]" />
      <div className="flex gap-1 flex-wrap">
        {ART.icons.map((g) => (
          <button type="button" key={g.id} onClick={() => setIcon(g.id)} aria-label={`Icon: ${g.id}`} aria-pressed={icon === g.id}
            className={`w-6 h-6 rounded-[5px] border ${icon === g.id ? 'border-neon-400 bg-neon-500/15' : 'border-white/10'}`}>
            <img src={g.src} alt="" className="w-full h-full" />
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !name.trim()} className="btn-primary h-6 px-2 rounded-[7px] text-[11px] font-semibold disabled:opacity-40">Save</button>
        <button type="button" onClick={onClose} className="btn-ghost h-6 px-2 rounded-[7px] text-[11px]">Cancel</button>
        <button type="button" onClick={onDelete} className="ml-auto h-6 px-2 rounded-[7px] text-[11px] text-red-300 hover:text-red-200">Remove</button>
      </div>
    </form>
  );
}

function FeaturePanel({ feature: f, chart, names, busy, onPlan, onOpen, onClose }: {
  feature: RoadmapFeature; chart: Chart; names: ReadonlyMap<string, string>; busy: boolean;
  onPlan: (d: { epicId?: string; startDate?: string; targetDate?: string; dependsOn?: string[] }) => void; onOpen: () => void; onClose: () => void;
}) {
  const others = [...chart.epics.flatMap((e) => e.features), ...chart.unassigned].filter((o) => o.id !== f.id);
  const why = startBlock(f, names);
  const tone = STATE_TONE[f.state];
  const epicName = chart.epics.find((e) => e.id === f.epicId)?.name;
  return (
    <div data-selected-feature={f.id} className="glass-light rounded-[16px] px-5 py-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.16em] text-gray-400 uppercase">Selected {word('waypoint').toLowerCase()}</p>
          <p className="text-[18px] font-semibold text-gray-100 flex items-center gap-2"><span className={`w-3 h-3 rounded-full shrink-0 ${tone.dot}`} />{f.name}</p>
          <p className="text-[12px] text-gray-400 mt-0.5">
            {epicName ?? 'No epic'} · <span className={tone.text}>{STATE_LABEL[f.state]}</span>
            {f.blockedBy.length > 0 && <span className="text-ember-300"> · waits on {f.blockedBy.map((id) => names.get(id)).join(', ')}</span>}
          </p>
          {f.summary && <p className="text-[13px] text-gray-300 mt-2 max-w-[640px] line-clamp-3">{f.summary}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button data-start disabled={why !== ''} onClick={onOpen} title={why || 'Open the feature and start its pipeline'} className="btn-primary h-10 px-5 rounded-[10px] text-[14px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed">START ▸</button>
          <button onClick={onOpen} className="btn-ghost h-10 px-3 rounded-[10px] text-[13px]">Open</button>
          <button onClick={onClose} aria-label="Close" className="btn-ghost h-10 w-10 rounded-[10px] text-[15px]">×</button>
        </div>
      </div>
      {why && <p className="text-[12px] text-gray-400 mt-2">{why}.</p>}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3 text-[12px] text-gray-400">
        <label className="flex flex-col gap-1">Epic
          <select disabled={busy} value={f.epicId} onChange={(e) => onPlan({ epicId: e.target.value })} className="glass-input h-9 px-2 rounded-[9px] text-[13px] text-gray-100">
            <option value="">No epic</option>
            {chart.epics.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Starts
          <input type="date" disabled={busy} value={f.startDate} max={f.targetDate || undefined} onChange={(e) => onPlan({ startDate: e.target.value })} className="glass-input h-9 px-2 rounded-[9px] text-[13px] text-gray-100" />
        </label>
        <label className="flex flex-col gap-1">Target date
          <input type="date" disabled={busy} value={f.targetDate} min={f.startDate || undefined} onChange={(e) => onPlan({ targetDate: e.target.value })} className="glass-input h-9 px-2 rounded-[9px] text-[13px] text-gray-100" />
        </label>
        <div className="flex flex-col gap-1">Waits on
          <div data-depends className="glass-input rounded-[9px] px-2 py-1.5 max-h-[92px] overflow-y-auto space-y-0.5">
            {others.length === 0 ? <span className="text-gray-500">No other feature</span> : others.map((o) => (
              <label key={o.id} className="flex items-center gap-1.5 text-[12px] text-gray-200 cursor-pointer">
                <input type="checkbox" disabled={busy} checked={f.dependsOn.includes(o.id)} className="accent-neon-500"
                  onChange={(e) => onPlan({ dependsOn: e.target.checked ? [...f.dependsOn, o.id] : f.dependsOn.filter((id) => id !== o.id) })} />
                <span className="truncate">{o.name}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
