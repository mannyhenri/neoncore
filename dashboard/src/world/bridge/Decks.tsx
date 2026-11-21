/**
 * THE DECKS — Flows as the engine deck, Tokens as the power core, beside the Projects bridge.
 *
 * Like the bridge (Bridge.tsx), nothing about what the pages DO changes: the workflow panel
 * and the tokens page are the same components, placed in a console frame. This file adds the
 * figure that stands beside each one and the gauges under it; index.css (".bridge") gives the
 * controls their console look. The figures are drawn sheets built by
 * scripts/world/build_bridge.py — no art, no figure.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Task, Workflow } from '../../types';
import { api } from '../../lib/api';
import { DECK_ART } from './art';
import type { DeckSheet } from './art';
import { formatSpent } from './captainState';
import { compactTokens, coreHeat, coreLevel, engineerAnim, flowGauges, quartermasterAnim, quotaOf, taskGauges, HEAT_LINE, USAGE_CHANGED } from './deckState';

/** The screens that are decks, and the backdrop each one stands on. */
export const DECK_VIEWS = ['projects', 'workflows', 'tasks', 'tokens'] as const;
export type DeckView = (typeof DECK_VIEWS)[number];
export const isDeckView = (v: string): v is DeckView => (DECK_VIEWS as readonly string[]).includes(v);

/** The `.bridge` scope and the drawn backdrop for a deck. */
export function deckProps(view: DeckView): { className: string; style?: React.CSSProperties } {
  const plate = DECK_ART.backdrops[view];
  return {
    className: 'bridge',
    style: plate ? { backgroundImage: `linear-gradient(rgba(5,9,20,0.12), rgba(5,9,20,0.5) 38%, rgba(5,9,20,0.72)), url(${plate})` } : undefined,
  };
}

/** One cycle of a drawn sheet, played in place (the same player as the crew, world/Avatar.tsx). */
export function DeckSprite({ sheet, cycle, fps, height }: { sheet: DeckSheet | null; cycle: string; fps: number; height: number }) {
  if (!sheet || !sheet.rows[cycle]) return null;
  const { row, frames } = sheet.rows[cycle];
  const width = (height * sheet.frameW) / sheet.frameH;
  const cols = Math.max(...Object.values(sheet.rows).map((r) => r.frames));
  const rows = Object.keys(sheet.rows).length;
  return (
    <div data-deck-sprite aria-hidden="true" className="overflow-hidden mx-auto" style={{ width, height }}>
      <div
        key={cycle}
        className="world-strip"
        style={{
          width: width * frames,
          height,
          backgroundImage: `url(${sheet.src})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${width * cols}px ${height * rows}px`,
          backgroundPosition: `0 ${-row * height}px`,
          animationDuration: `${frames / fps}s`,
          animationTimingFunction: `steps(${frames})`,
        }}
      />
    </div>
  );
}

function Gauge({ name, label, value, fill, tone }: { name: string; label: string; value: string; fill: number; tone?: 'amber' }) {
  return (
    <div data-gauge={name} data-tone={tone} className="bridge-gauge">
      <div className="min-w-0">
        <div className="bridge-gauge-label">{label}</div>
        <div className="bridge-gauge-value" data-gauge-value>{value}</div>
      </div>
      <div className="bridge-bars" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => <span key={i} data-on={i < Math.round(Math.min(1, Math.max(0, fill)) * 8) || undefined} style={{ height: `${30 + i * 10}%` }} />)}
      </div>
    </div>
  );
}

// ── Flows: the engine deck ─────────────────────────────────────────────────────────────

function useRuns(): Workflow[] {
  const [runs, setRuns] = useState<Workflow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { api.getWorkflows().then((w) => { if (alive && Array.isArray(w)) setRuns(w); }).catch(() => {}); };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return runs;
}

const ENGINEER_LINE = { idle: 'Standing by', work: 'Run in progress', call: 'A run needs you' } as const;
const ENGINEER_FPS = { idle: 3, work: 6, call: 6 } as const;

/** The engineer and his helper, beside the workflows. His cycle is the state of the runs. */
export function EngineerPost({ height = 210 }: { height?: number }) {
  const anim = engineerAnim(useRuns());
  return (
    <div className="bridge-captain" data-deck-state={anim}>
      <DeckSprite sheet={DECK_ART.sheets.engineer} cycle={anim} fps={ENGINEER_FPS[anim]} height={height} />
      <div className="bridge-readout" role="status" data-alert={anim === 'call' || undefined}>{ENGINEER_LINE[anim]}</div>
    </div>
  );
}

export function FlowGauges() {
  const g = flowGauges(useRuns(), Date.now());
  return (
    <div className="bridge-gauges" aria-label="Readings · runs">
      <Gauge name="running" label="Running" value={String(g.running)} fill={g.running / 4} />
      <Gauge name="waiting" label="Waiting on you" value={String(g.waiting)} fill={g.waiting / 4} tone="amber" />
      <Gauge name="done" label="Done today" value={String(g.doneToday)} fill={g.doneToday / 8} />
    </div>
  );
}

// ── Tasks: the cargo bay ───────────────────────────────────────────────────────────────

const QUARTERMASTER_LINE = { idle: 'Standing by', work: 'Task in hand', call: 'A task failed' } as const;
const QUARTERMASTER_FPS = { idle: 3, work: 6, call: 6 } as const;

/** The quartermaster and her cargo drone, beside the task queue. Her cycle is the state of the tasks. */
export function QuartermasterPost({ tasks, height = 210 }: { tasks: readonly Task[]; height?: number }) {
  const anim = quartermasterAnim(tasks, Date.now());
  return (
    <div className="bridge-captain" data-deck-state={anim}>
      <DeckSprite sheet={DECK_ART.sheets.quartermaster} cycle={anim} fps={QUARTERMASTER_FPS[anim]} height={height} />
      <div className="bridge-readout" role="status" data-alert={anim === 'call' || undefined}>{QUARTERMASTER_LINE[anim]}</div>
    </div>
  );
}

export function TaskGauges({ tasks }: { tasks: readonly Task[] }) {
  const g = taskGauges(tasks, Date.now());
  return (
    <div className="bridge-gauges" aria-label="Readings · tasks">
      <Gauge name="queued" label="Queued" value={String(g.queued)} fill={g.queued / 8} tone="amber" />
      <Gauge name="active" label="In progress" value={String(g.active)} fill={g.active / 4} />
      <Gauge name="done" label="Done today" value={String(g.doneToday)} fill={g.doneToday / 8} />
    </div>
  );
}

// ── Tokens: the power core ─────────────────────────────────────────────────────────────

type Rate = Awaited<ReturnType<typeof api.getBurnRate>>;

/** This server's burn rate over the trailing week — the same reading the header badge starts from. */
function useRate(): Rate | null {
  const [rate, setRate] = useState<Rate | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getBurnRate(7)
        .then((r) => { if (alive) setRate(r && typeof r.tokensPerHour === 'number' && Number.isFinite(r.tokensPerHour) ? r : null); })
        .catch(() => { if (alive) setRate(null); });
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    // A reading logged or removed on the Tokens page changes the quota now, not in five minutes.
    window.addEventListener(USAGE_CHANGED, load);
    return () => { alive = false; clearInterval(t); window.removeEventListener(USAGE_CHANGED, load); };
  }, []);
  return rate;
}

const CORE_LINE = { low: 'Core idling', normal: 'Core steady', high: 'Core running hot', warn: 'Quota nearly gone' } as const;
const CORE_FPS = { low: 3, normal: 5, high: 8, warn: 8 } as const;
/** How many embers rise off the core at each heat stage. */
const EMBERS = { none: 0, amber: 4, orange: 8, red: 12 } as const;

/** The reactor core and the drone: how hard the fleet is burning, and how much quota is left. */
export function CorePost({ height = 250 }: { height?: number }) {
  const rate = useRate();
  const quota = quotaOf(rate);
  const level = coreLevel({ tokensPerHour: rate?.tokensPerHour ?? 0, warn: quota?.warn ?? false });
  const heat = coreHeat(quota?.pct);
  const hot = heat.stage !== 'none';
  return (
    <div className="bridge-captain" data-deck-state={level}>
      {/* The heat is laid over the drawn core — a tint, a glow and embers — never a second drawing. */}
      <div className="core-heat" data-core-heat={heat.stage} style={{ '--heat': heat.glow } as CSSProperties}>
        <DeckSprite sheet={DECK_ART.sheets.core} cycle={level} fps={CORE_FPS[level]} height={height} />
        {hot && <div className="core-heat-glow" aria-hidden="true" />}
        {hot && Array.from({ length: EMBERS[heat.stage] }, (_, i) => (
          <span key={i} className="core-ember" aria-hidden="true" style={{ left: `${22 + ((i * 37) % 56)}%`, animationDelay: `${(i * 0.43) % 2.4}s`, animationDuration: `${2.2 + (i % 3) * 0.5}s` }} />
        ))}
      </div>
      <div className="bridge-readout" role="status" data-alert={level === 'warn' || hot || undefined} data-heat={hot ? heat.stage : undefined}>{heat.stage === 'red' ? HEAT_LINE.red : level === 'warn' ? CORE_LINE.warn : hot ? HEAT_LINE[heat.stage as keyof typeof HEAT_LINE] : CORE_LINE[level]}</div>
      <div className="bridge-rate" data-core-rate>{rate ? `${compactTokens(rate.tokensPerHour)} TOK / HR` : 'NO READING'}</div>
      {quota && (
        <div className="bridge-tank" data-quota-tank={quota.pct} data-alert={quota.warn || undefined} data-heat={hot ? heat.stage : undefined} title="What the tank holds is what is LEFT of the subscription quota">
          <div className="bridge-tank-glass" aria-hidden="true"><div data-quota-fill style={{ height: `${Math.max(0, 100 - quota.pct)}%` }} /></div>
          <div>
            <div className="bridge-gauge-label">Claude quota</div>
            <div className="bridge-gauge-value">{quota.pct}% used</div>
            {quota.resetsIn && <div className="bridge-gauge-label">Resets in {quota.resetsIn}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export function TokenGauges() {
  const rate = useRate();
  const none = '—';
  return (
    <div className="bridge-gauges" aria-label="Readings · burn">
      <Gauge name="day" label="Tokens / day" value={rate ? compactTokens(rate.tokensPerDay) : none} fill={rate ? rate.tokensPerDay / 1e9 : 0} />
      <Gauge name="cost" label="Cost / day" value={rate ? formatSpent(rate.costPerDay) : none} fill={rate ? rate.costPerDay / 1000 : 0} tone="amber" />
      <Gauge name="cartridges" label="Cartridges burning" value={rate ? String(rate.activeCartridges) : none} fill={rate ? rate.activeCartridges / 8 : 0} />
    </div>
  );
}
