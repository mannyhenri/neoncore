/**
 * THE ROUTE VIEW — the roadmap as a flight path (routeLayout.ts). The project launches at the left
 * and flies to its destination, the vision; every epic is a stop on the way, in plan order, lit by
 * where it stands; the ship is where the project is now. Select a stop to see the epic: what it
 * delivers, its date, what it waits on, and its features — each one opens the same card the
 * timeline does. The timeline (dates, dragging) is the other view of the same plan.
 *
 * Art rule (docs/DESIGN.md): the destination, the ship and the glyphs are the roadmap deck's own
 * drawn art, handed in by the chart; the path, rings and plates are drawn in code.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RoadmapChart as Chart, RoadmapEpic, RoadmapFeature, RoadmapFeatureState } from '../../types';
import { ROUTE, STAGE_COLOUR, STAGE_LABEL, currentStop, epicStage, routeLayout } from './routeLayout';
import { EpicCards } from './EpicCards';

const LEG_STYLE = {
  travelled: { stroke: '#34D36B', width: 3, dash: undefined, opacity: 0.95 },
  flying: { stroke: '#3FB4FF', width: 3, dash: '10 8', opacity: 1 },
  ahead: { stroke: '#9FB2D2', width: 2, dash: '4 9', opacity: 0.5 },
} as const;
const CANVAS_H = 380;
const short = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const FEATURE_WORD: Record<RoadmapFeatureState, string> = { delivered: 'Delivered', 'under-way': 'Under way', planned: 'Planned', late: 'Late' };

export function RouteView({ chart, busy, selectedFeature, iconOf, notesOf, node, destination, ship, editor, onPickFeature, onStart, onAddEpic, onAddFeature, onReorder, onDeleteEpic, onMoveFeature, padBottom }: {
  chart: Chart; busy: boolean;
  /** The feature whose card is open, if any. */
  selectedFeature: string | null;
  iconOf: (epic: RoadmapEpic, i: number) => { src: string } | undefined;
  /** What an epic's date and dependencies say (RoadmapChart epicStatus). */
  notesOf: (epic: RoadmapEpic) => { kind: string; text: string }[];
  /** A feature's dot, in its state's colour. */
  node: (state: RoadmapFeatureState) => ReactNode;
  /** The drawn destination and the drawn ship (the deck's art), or nothing when a theme has none. */
  destination: ReactNode; ship: ReactNode;
  /** The epic editor, for the epic being edited. */
  editor: (epic: RoadmapEpic, close: () => void) => ReactNode;
  onPickFeature: (id: string) => void;
  onStart: (featureId: string) => void;
  onAddEpic: () => void;
  onAddFeature: (epicId: string, name: string, date: string) => void;
  onReorder: (ids: string[]) => void;
  onDeleteEpic: (epic: RoadmapEpic) => void;
  onMoveFeature: (featureId: string, epicId: string) => void;
  padBottom?: number;
}) {
  const stages = useMemo(() => chart.epics.map(epicStage), [chart.epics]);
  const at = currentStop(stages);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !box.current) return;
    const el = box.current;
    const measure = () => setWidth((w) => (el.clientWidth > 0 && el.clientWidth !== w ? el.clientWidth : w));
    const ro = new ResizeObserver(measure);
    ro.observe(el); measure();
    return () => ro.disconnect();
  }, []);
  const route = useMemo(() => routeLayout(stages, width, CANVAS_H), [stages, width]);
  // A long route scrolls: open it on the ship, not on the launch pad.
  useEffect(() => {
    const el = box.current;
    if (el && route.width > el.clientWidth && el.clientWidth > 0) el.scrollLeft = Math.max(0, route.ship.x - el.clientWidth / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.width, chart.project.id]);

  // The stop on show: the one you picked, else where the project is now (the last one when all is delivered).
  const [picked, setPicked] = useState<string | null>(null);
  const shownIndex = Math.max(0, chart.epics.findIndex((e) => e.id === picked) >= 0 ? chart.epics.findIndex((e) => e.id === picked) : Math.min(at, chart.epics.length - 1));
  const shown = chart.epics[shownIndex] ?? null;
  const pick = (id: string) => setPicked(id);
  const names = new Map(chart.epics.flatMap((e) => e.features).concat(chart.unassigned).map((f) => [f.id, f.name]));
  const total = chart.epics.reduce((n, e) => n + e.progress.total, 0);
  const delivered = chart.epics.reduce((n, e) => n + e.progress.done, 0);

  const chip = (f: RoadmapFeature) => {
    const on = selectedFeature === f.id;
    const waits = f.blockedBy.length > 0 || (f.waitsOnEpics ?? []).length > 0;
    return (
      <button key={f.id} data-route-feature={f.id} data-state={f.state} data-selected={on || undefined} onClick={() => onPickFeature(f.id)}
        title={`${f.name} — ${FEATURE_WORD[f.state]}${f.targetDate ? `, due ${f.targetDate}` : ''}${waits ? ` · waits on ${[...f.blockedBy.map((id) => names.get(id) ?? 'another feature'), ...(f.waitsOnEpics ?? []).map((id) => `the epic ${chart.epics.find((e) => e.id === id)?.name ?? ''}`)].join(', ')}` : ''}`}
        className={`flex items-center gap-2 h-9 pl-2.5 pr-3 rounded-[9px] border text-left text-[13px] transition-colors ${on ? 'border-[#3FB4FF] bg-[rgba(20,70,130,0.6)] text-white' : 'border-white/[0.12] bg-[rgba(10,18,36,0.7)] text-gray-200 hover:border-white/30'}`}>
        {node(f.state)}
        <span className={`min-w-0 flex-1 truncate ${f.state === 'delivered' ? 'text-gray-400' : ''}`}>{f.name}</span>
        {waits && <span data-waits aria-hidden="true" className="text-[11px] text-amber-200">⛓</span>}
        {f.targetDate && <span className={`shrink-0 text-[11px] tabular-nums ${f.state === 'late' ? 'text-[#FF8A3D]' : 'text-gray-400'}`}>{short(f.targetDate)}</span>}
      </button>
    );
  };

  return (
    <div data-route-view className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 pt-3" style={{ paddingBottom: padBottom }}>
      {/* ── THE FLIGHT PATH ─────────────────────────────────────────────── */}
      <div ref={box} data-route-canvas className="relative rounded-[14px] border border-[rgba(96,160,255,0.22)] overflow-x-auto overflow-y-hidden"
        style={{
          height: CANVAS_H,
          background: 'radial-gradient(1px 1px at 12% 22%, #fff9 50%, transparent 51%), radial-gradient(1px 1px at 31% 71%, #fff7 50%, transparent 51%), radial-gradient(1.5px 1.5px at 47% 14%, #cfe6ff 50%, transparent 51%), radial-gradient(1px 1px at 63% 83%, #fff8 50%, transparent 51%), radial-gradient(1px 1px at 78% 31%, #fff6 50%, transparent 51%), radial-gradient(1.5px 1.5px at 91% 64%, #ffe9b0 50%, transparent 51%), radial-gradient(1px 1px at 22% 48%, #fff5 50%, transparent 51%), radial-gradient(1px 1px at 55% 52%, #fff5 50%, transparent 51%), radial-gradient(ellipse at 85% 40%, rgba(40,90,170,0.35), transparent 55%), linear-gradient(180deg, #050A18, #071226 60%, #050A18)',
        }}>
        <div className="relative" style={{ width: route.width, height: CANVAS_H }}>
          <svg width={route.width} height={CANVAS_H} className="absolute inset-0" aria-hidden="true">
            {route.legs.map((leg, i) => {
              const st = LEG_STYLE[leg.state];
              return (
                <g key={i} data-route-leg={i} data-state={leg.state}>
                  {leg.state !== 'ahead' && <path d={leg.d} fill="none" stroke={st.stroke} strokeWidth={st.width + 6} strokeLinecap="round" opacity={0.16} />}
                  <path d={leg.d} fill="none" stroke={st.stroke} strokeWidth={st.width} strokeDasharray={st.dash} strokeLinecap="round" opacity={st.opacity}
                    className={leg.state === 'flying' ? 'route-flying' : undefined} />
                </g>
              );
            })}
            <circle cx={route.launch.x} cy={route.launch.y} r={7} fill="#08101F" stroke="#34D36B" strokeWidth={2} />
          </svg>
          <span className="absolute -translate-x-1/2 text-[10px] font-bold tracking-[0.16em] uppercase text-gray-400" style={{ left: route.launch.x, top: route.launch.y + 14 }}>Launch</span>

          {/* the destination: where the vision is */}
          <div data-route-destination data-reached={at >= chart.epics.length && chart.epics.length > 0 || undefined} className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center text-center" style={{ left: route.destination.x, top: route.destination.y, width: ROUTE.right - 20 }}
            title={chart.vision || 'No vision yet — say where this project is going.'}>
            <div style={{ filter: at >= chart.epics.length && chart.epics.length > 0 ? 'drop-shadow(0 0 18px rgba(245,197,66,0.8))' : 'drop-shadow(0 0 14px rgba(63,180,255,0.5))' }}>{destination ?? <span className="block w-[96px] h-[96px] rounded-full bg-neon-500/40" />}</div>
            <span className="mt-1 text-[10px] font-bold tracking-[0.18em] uppercase text-neon-300">Destination</span>
            <span className="font-display text-[14px] font-semibold text-white leading-tight line-clamp-2">{chart.project.name}</span>
            <span data-route-progress className="text-[11px] text-gray-400 tabular-nums">{delivered} of {total} features</span>
          </div>

          {/* the stops: one per epic */}
          {chart.epics.map((e, i) => {
            const s = route.stops[i];
            const stage = stages[i];
            const c = STAGE_COLOUR[stage];
            const on = shown?.id === e.id;
            const frac = e.progress.total > 0 ? e.progress.done / e.progress.total : 0;
            const R = ROUTE.node / 2 - 3;
            const glyph = iconOf(e, i);
            const note = notesOf(e)[0];
            const label = (
              <span className="block text-center" style={{ width: ROUTE.label }}>
                <span className="block text-[10px] font-bold tracking-[0.14em] uppercase" style={{ color: c }}>Epic {i + 1} · {STAGE_LABEL[stage]}</span>
                <span className="block text-[12px] font-semibold text-gray-100 leading-tight line-clamp-2">{e.name}</span>
                <span className="block text-[11px] text-gray-400 tabular-nums truncate">{e.progress.done}/{e.progress.total}{note ? ` · ${note.text.replace(/^★ Commendation · /, '★ ').replace(/^Delivered .*$/, 'done')}` : ''}</span>
              </span>
            );
            return (
              <button key={e.id} data-route-stop={e.id} data-stage={stage} data-current={i === at || undefined} data-selected={on || undefined} aria-pressed={on}
                aria-label={`Epic ${i + 1}, ${e.name}: ${STAGE_LABEL[stage].toLowerCase()}, ${e.progress.done} of ${e.progress.total} features delivered`}
                onClick={() => pick(e.id)}
                className="absolute -translate-x-1/2 flex flex-col items-center outline-none group"
                style={s.side === 'above' ? { left: s.x, bottom: CANVAS_H - s.y - ROUTE.node / 2 } : { left: s.x, top: s.y - ROUTE.node / 2 }}>
                {s.side === 'above' && <span className="mb-1.5">{label}</span>}
                <span className={`relative block rounded-full transition-transform group-hover:scale-105 group-focus-visible:scale-105 ${stage === 'under-way' ? 'route-pulse' : ''}`}
                  style={{ width: ROUTE.node, height: ROUTE.node, background: 'radial-gradient(circle at 35% 30%, #1B2B4D, #070D1C 70%)', boxShadow: `0 0 ${on ? 22 : stage === 'planned' ? 0 : 12}px ${c}${on ? '' : '99'}, inset 0 0 0 ${on ? 3 : 2}px ${on ? '#FFFFFF' : `${c}66`}` }}>
                  {/* the ring fills as the epic's features are delivered */}
                  <svg width={ROUTE.node} height={ROUTE.node} className="absolute inset-0 -rotate-90" aria-hidden="true">
                    <circle cx={ROUTE.node / 2} cy={ROUTE.node / 2} r={R} fill="none" stroke="rgba(160,180,215,0.18)" strokeWidth={4} />
                    <circle data-route-ring cx={ROUTE.node / 2} cy={ROUTE.node / 2} r={R} fill="none" stroke={c} strokeWidth={4} strokeLinecap="round" strokeDasharray={`${(2 * Math.PI * R * frac).toFixed(1)} ${(2 * Math.PI * R).toFixed(1)}`} />
                  </svg>
                  {glyph ? <img src={glyph.src} alt="" draggable={false} className="absolute inset-0 m-auto w-9 h-9" style={{ imageRendering: 'pixelated', opacity: stage === 'planned' || stage === 'blocked' ? 0.55 : 1, filter: stage === 'planned' || stage === 'blocked' ? 'grayscale(0.7)' : undefined }} /> : null}
                  {stage === 'blocked' && <span aria-hidden="true" className="absolute -right-1 -bottom-1 text-[15px]">🔒</span>}
                  {stage === 'commended' && <span aria-hidden="true" className="absolute -right-1 -top-1.5 text-[16px] text-[#F5C542] drop-shadow-[0_0_6px_rgba(245,197,66,0.9)]">★</span>}
                  {stage === 'late' && <span aria-hidden="true" className="absolute -right-1 -top-1.5 text-[14px] text-[#FF8A3D]">⚠</span>}
                </span>
                {s.side === 'below' && <span className="mt-1.5">{label}</span>}
              </button>
            );
          })}

          {/* the ship: where the project is now */}
          <div data-route-ship className="absolute -translate-x-1/2 pointer-events-none route-ship" style={{ left: route.ship.x - ROUTE.node / 2 - 22, top: route.ship.y - 13 }} title="Where the project is now">
            {ship ?? <span className="block w-4 h-4 rotate-45 bg-[#3FB4FF] shadow-[0_0_12px_#3FB4FF]" />}
          </div>

          {/* nothing plotted yet */}
          {chart.epics.length === 0 && (
            <button data-route-first onClick={onAddEpic} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-11 px-5 rounded-[10px] border border-[rgba(96,160,255,0.6)] bg-[rgba(8,16,34,0.92)] font-display text-[14px] font-semibold tracking-[0.12em] uppercase text-white hover:border-white">
              + Plot the first epic on the route
            </button>
          )}
        </div>
      </div>

      {/* ── THE EPICS, AS CARDS (EpicCards.tsx) ─────────────────────────── */}
      {chart.epics.length > 0 && (
        <EpicCards chart={chart} stages={stages} selected={shown?.id ?? null} onSelect={pick} selectedFeature={selectedFeature} onPickFeature={onPickFeature}
          iconOf={iconOf} editor={editor} busy={busy} onStart={onStart} onAddEpic={onAddEpic} onAddFeature={onAddFeature}
          onReorder={onReorder} onDelete={onDeleteEpic} onMoveFeature={onMoveFeature} />
      )}

      {/* features in no epic: not on the route until they are given one */}
      {chart.unassigned.length > 0 && (
        <section data-route-unassigned className="mt-3 rounded-[12px] border border-white/[0.1] bg-[rgba(10,18,36,0.5)] px-4 py-3">
          <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-gray-300">Features in no epic <span className="text-gray-500 tabular-nums">{chart.unassigned.length}</span></p>
          <p className="text-[12px] text-gray-400 mt-0.5 mb-2">Not on the route yet. Select one and use “Edit plan” to give it an epic.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">{chart.unassigned.map(chip)}</div>
        </section>
      )}
    </div>
  );
}
