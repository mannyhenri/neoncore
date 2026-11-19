import { useState, useEffect, useMemo, useRef } from 'react';
import { api, apiFor } from '../lib/api';
import { activeServers } from '../lib/servers';
import { mergeSeries, type UsageSeries, type FleetSeries } from '../lib/usageSeries';
import { mergeBurnRates, budgetStats, type ServerBurnRate, type FleetBurnRate } from '../lib/burnRate';
import { fanOut } from '../lib/fanOut';
import type { ServerEntry } from '@neoncore/client';
import {
  SUBSCRIPTION_PROVIDERS, reachEstimate, groupFleetReadings,
  type SubscriptionProvider, type UsageWindow, type UsageCheckpoint, type FleetReading,
} from '../lib/subscriptionUsage';

/**
 * Token reporting: burn over time, so a change in how you work can be seen in what it costs.
 *
 * Two questions drive the layout. "Did my spend move, and when" is the chart. "On what" is the
 * project table under it — a single line cannot answer the second, and it is always the next
 * thing asked, so both come off one fetch.
 *
 * ── ONE BREAKDOWN, NOT TWO ────────────────────────────────────────────────────────────
 * There was a per-CARTRIDGE table under the per-project one. On a fleet where each repo runs a
 * single cartridge — which is every fleet observed — the two are the same table twice, row for
 * row, in the same order, differing only in that the cartridge names carry a `<machine>/` prefix.
 * A reader comparing them learns nothing and spends the effort anyway.
 *
 * The project grouping is the one that survives, because it is the one that stays correct when
 * they diverge: a repo run by two cartridges sums into one project row, and a per-cartridge list
 * cannot be sorted into that answer. What the cartridge table alone used to show — turns — moved
 * onto the project row, and the cartridge COUNT appears there only when it is greater than one,
 * which is the only time it says anything.
 *
 * THE NUMBERS HERE ARE THE MEASURED ONES. `session_usage`, written per turn from the transcript,
 * counting all four token classes. Not `workflow_steps.tokens_in/out`, which is a `length / 4`
 * estimate of the prompt and the result and understates a real run by more than an order of
 * magnitude — a reporting page built on that would show a trend in the estimator, not in spend.
 */

/** THE RANGES, and the granularity each one opens at. Hourly across six months is 4,000+ bars:
 *  available if asked for, but not what the range should default to. */
const RANGES = [
  { key: 'week', label: 'Last week', days: 7, bucket: 'hour' as const },
  { key: 'month', label: 'Last month', days: 30, bucket: 'day' as const },
  { key: 'sixmonths', label: 'Last 6 months', days: 182, bucket: 'week' as const },
];

const BUCKETS = [
  { key: 'hour' as const, label: 'Per hour' },
  { key: 'day' as const, label: 'Per day' },
  { key: 'week' as const, label: 'Per week' },
];

type Metric = 'tokens' | 'costUsd';

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
const money = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);
const fmt = (n: number, m: Metric) => (m === 'costUsd' ? money(n) : compact(n));

/** Bucket labels: enough to locate a point, short enough to fit under a bar. */
function tickLabel(iso: string, bucket: string): string {
  const d = new Date(iso);
  if (bucket === 'hour') {
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
  }
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

export function TokensPage({ servers }: { servers: ServerEntry[] }) {
  const [rangeKey, setRangeKey] = useState('month');
  const [bucket, setBucket] = useState<'hour' | 'day' | 'week'>('day');
  const [metric, setMetric] = useState<Metric>('tokens');
  const [cumulative, setCumulative] = useState(false);
  const [data, setData] = useState<FleetSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const [rate, setRate] = useState<FleetBurnRate | null>(null);
  const [limitProvider, setLimitProvider] = useState<SubscriptionProvider>('claude');
  const [limitRefresh, setLimitRefresh] = useState(0);
  // A reading of the provider's own meter — see server/src/lib/usage-checkpoint.ts.
  const [cpWindow, setCpWindow] = useState<UsageWindow>('weekly');
  const [cpPct, setCpPct] = useState('');
  const [cpResetsAt, setCpResetsAt] = useState(() => {
    const d = new Date(Date.now() + 3 * 86_400_000 - new Date().getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
  });
  const [cpMessage, setCpMessage] = useState('');
  const [loggingCp, setLoggingCp] = useState(false);
  const [readings, setReadings] = useState<FleetReading[]>([]);
  // Removing is two clicks: the first arms this row, the second deletes. A reading is the
  // gauge's anchor, and one stray click should not throw it away.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];
  const fleetKey = activeServers(servers).map((s) => s.url).join('|');

  // Picking a range also picks its natural granularity. Changing granularity afterwards is
  // still free — this sets a starting point rather than locking the pair together.
  const selectRange = (key: string) => {
    setRangeKey(key);
    const r = RANGES.find((x) => x.key === key);
    if (r) setBucket(r.bucket);
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = () => {
      // The chart appears as soon as ANY server answers and fills in as the rest arrive. The
      // alternative — waiting for all of them — makes an asleep machine cost you the page.
      fanOut<UsageSeries>(
        activeServers(servers),
        (s) => (s.url ? apiFor(s.url, s.token) : api)
          .getUsageSeries(range.days, bucket).then((r) => r as UsageSeries),
        (answers) => {
          if (!alive) return;
          setData(mergeSeries(answers, bucket, range.days));
          setLoading(false);
        },
      );
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetKey, range.days, bucket]);

  // The budget block needs the RATE, which this page does not otherwise fetch. Same fan-out
  // and same merge as the header badge, so the two cannot disagree about the fleet.
  useEffect(() => {
    let alive = true;
    const load = () => {
      fanOut<ServerBurnRate>(
        activeServers(servers),
        (s) => (s.url ? apiFor(s.url, s.token) : api).getBurnRate(7).then((r) => r as ServerBurnRate),
        (answers) => { if (alive) setRate(mergeBurnRates(answers, 7)); },
      );
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetKey, limitRefresh]);

  // Every server's readings, grouped into what the person actually logged — see groupFleetReadings.
  useEffect(() => {
    let alive = true;
    const targets = activeServers(servers);
    Promise.allSettled(targets.map((s) =>
      (s.url ? apiFor(s.url, s.token) : api).getUsageCheckpoints()))
      .then((settled) => {
        if (!alive) return;
        setReadings(groupFleetReadings(settled.map((r) =>
          r.status === 'fulfilled' && Array.isArray(r.value?.checkpoints) ? r.value.checkpoints as UsageCheckpoint[] : null)));
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetKey, limitRefresh]);

  const removeReading = async (reading: FleetReading) => {
    if (confirmingKey !== reading.key) { setConfirmingKey(reading.key); return; }
    setConfirmingKey(null);
    setRemovingKey(reading.key);
    setCpMessage('');
    try {
      const targets = activeServers(servers);
      const settled = await Promise.allSettled(reading.copies.map(({ serverIndex, id }) => {
        const s = targets[serverIndex];
        return (s?.url ? apiFor(s.url, s.token) : api).removeUsageCheckpoint(id);
      }));
      // A 404 means that copy was already gone, which is the outcome asked for.
      const failed = settled.filter((r): r is PromiseRejectedResult =>
        r.status === 'rejected' && !/404|no such reading/i.test(String((r.reason as Error)?.message ?? r.reason)));
      setCpMessage(failed.length
        ? `Removed from ${reading.copies.length - failed.length} of ${reading.copies.length} server(s); the rest did not answer.`
        : `Removed the ${Math.round(reading.pctUsed * 100)}% reading.`);
    } finally {
      setRemovingKey(null);
      setLimitRefresh((n) => n + 1);
    }
  };

  const stats = useMemo(() => (rate ? budgetStats(rate) : null), [rate]);

  const logCheckpoint = async () => {
    setLoggingCp(true);
    setCpMessage('');
    try {
      const pct = Number(cpPct);
      const resets = new Date(cpResetsAt);
      if (cpPct.trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        setCpMessage('Enter the percentage as the provider shows it, 0 to 100.');
        return;
      }
      if (!cpResetsAt || !Number.isFinite(resets.getTime())) {
        setCpMessage('Choose the reset time the provider shows next to the percentage.');
        return;
      }
      // Every server, like the calibration above: the meter is one account, and each server
      // keeps its own gauge, so each needs the reading to anchor on.
      const targets = activeServers(servers);
      const observedAt = new Date().toISOString();
      const settled = await Promise.allSettled(targets.map((s) =>
        (s.url ? apiFor(s.url, s.token) : api).logUsageCheckpoint({
          provider: limitProvider, window: cpWindow, pctUsed: pct, resetsAt: resets.toISOString(),
          // Shared, so every server's copy of this reading can be found and removed as one.
          observedAt,
        })));
      const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length) {
        const why = failures[0].reason instanceof Error ? failures[0].reason.message : String(failures[0].reason);
        setCpMessage(`Could not log on ${failures.length} of ${targets.length} server(s): ${why}`);
        setLimitRefresh((n) => n + 1);
        return;
      }
      setCpMessage(`${limitProvider === 'claude' ? 'Claude' : 'Codex'} ${cpWindow === 'weekly' ? 'weekly' : '5-hour'} reading recorded: ${pct}%.`);
      setCpPct('');
      setLimitRefresh((n) => n + 1);
    } finally {
      setLoggingCp(false);
    }
  };

  const points = useMemo(() => {
    const raw = data?.series ?? [];
    if (!cumulative) return raw.map((p) => ({ ...p, v: p[metric] }));
    // Cumulative answers "where was I when I hit the ceiling" — a running total makes the
    // moment a plan limit was reached readable off the curve.
    let run = 0;
    return raw.map((p) => { run += p[metric]; return { ...p, v: run }; });
  }, [data, metric, cumulative]);

  const max = points.reduce((m, p) => Math.max(m, p.v), 0) || 1;

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-display text-gray-100 text-2xl font-semibold">
          Token Report
        </h2>
        {data && (
          <div className="flex items-baseline gap-5 text-sm font-mono">
            <span className="text-gray-500">
              <span className="text-gray-100 text-xl">{compact(data.total.tokens)}</span> tokens
            </span>
            <span className="text-gray-500">
              <span className="text-gray-100 text-xl">{money(data.total.costUsd)}</span> spend
            </span>
            <span className="text-gray-500">{data.total.samples.toLocaleString()} turns</span>
          </div>
        )}
      </div>

      {stats && (
        <section>
          <h3 className="text-gray-100 text-lg font-semibold mb-3">
            Weekly budget
          </h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
            <Stat label="budget" value={money(stats.budgetUsd)} note={stats.basis} />
            <Stat label="spent" value={money(stats.consumedUsd)}
                  note={`${Math.round((stats.consumedUsd / stats.budgetUsd) * 100)}% of the week`} />
            <Stat label="left" value={money(stats.remainingUsd)}
                  note={stats.exhaustionAt
                    ? `runs out ${new Date(stats.exhaustionAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
                    : 'nothing is being spent'} />
            {/* Pace is the one figure the badge cannot show: 100% is exactly on plan. */}
            <Stat label="pace" value={`${Math.round(stats.pacePct * 100)}%`}
                  accent={stats.pacePct > 1 ? 'text-amber-200' : 'text-emerald-300'}
                  note={stats.pacePct > 1 ? 'above what the budget allows' : 'within the budget'} />
          </div>
        </section>
      )}

      <section className="glass-light rounded-[18px] p-5 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            {/* The usage log: type what the provider's meter shows; read back when 100% arrives. */}
            <h3 className="text-[17px] font-semibold text-gray-100">Usage log</h3>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={limitProvider} onChange={(e) => setLimitProvider(e.target.value as SubscriptionProvider)}
              aria-label="reading provider"
              className="glass-input rounded-[10px] px-2 py-2.5 text-sm text-gray-300">
              {SUBSCRIPTION_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>{provider === 'claude' ? 'Claude' : 'Codex'}</option>
              ))}
            </select>
            <select value={cpWindow} onChange={(e) => setCpWindow(e.target.value as UsageWindow)}
              aria-label="reading window"
              className="glass-input rounded-[10px] px-2 py-2.5 text-sm text-gray-300">
              <option value="weekly">Weekly limit</option>
              <option value="session">5-hour limit</option>
            </select>
            <input type="number" min={0} max={100} step={1} placeholder="% used" value={cpPct}
              onChange={(e) => setCpPct(e.target.value)} aria-label="percent used"
              className="w-24 glass-input rounded-[10px] px-2 py-2.5 text-sm text-gray-300" />
            <input type="datetime-local" value={cpResetsAt} onChange={(e) => setCpResetsAt(e.target.value)}
              title="When the provider says this window resets" aria-label="resets at"
              className="glass-input rounded-[10px] px-2 py-2.5 text-sm text-gray-300" />
            <button onClick={logCheckpoint} disabled={loggingCp}
              className="btn-primary h-10 rounded-[10px] px-3.5 text-[13px] font-semibold disabled:opacity-50">
              {loggingCp ? 'Logging…' : 'Log reading'}
            </button>
          </div>
        </div>
        {cpMessage && <p className="text-xs text-emerald-200">{cpMessage}</p>}
        {rate?.usageAnchor?.length ? (
          <ul className="space-y-1.5" aria-label="estimate">
            {rate.usageAnchor.map((a) => (
              <li key={`${a.provider}-${a.window}`} data-testid="reach-estimate"
                className={`rounded-xl bg-gl-code border border-white/[0.1] px-3 py-2.5 font-mono text-sm ${a.pace === 'hold' ? 'text-red-300' : a.pace === 'watch' ? 'text-amber-300' : 'text-emerald-300'}`}>
                {a.provider === 'claude' ? 'Claude' : a.provider === 'codex' ? 'Codex' : a.provider} {a.window === 'weekly' ? 'weekly' : '5-hour'} · {Math.round(Math.max(0, a.pctUsed) * 100)}% used · {reachEstimate(a)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-500">No reading yet. Log what the provider's usage page shows to get an estimate.</p>
        )}
        {readings.length > 0 && (
          <ul className="text-xs font-mono space-y-1" aria-label="logged readings">
            {readings.slice(0, 8).map((r) => (
              <li key={r.key} className="flex items-center gap-3 text-gray-400">
                <span className="text-gray-300">{r.provider === 'claude' ? 'Claude' : r.provider === 'codex' ? 'Codex' : r.provider}</span>
                <span>{r.window === 'weekly' ? 'weekly' : '5-hour'}</span>
                <span className="text-emerald-300">{Math.round(r.pctUsed * 100)}%</span>
                <span className="text-gray-500">read {new Date(r.observedAt).toLocaleString()}</span>
                <span className="text-gray-500">· resets {new Date(r.resetsAt).toLocaleString()}</span>
                <button
                  onClick={() => void removeReading(r)}
                  onBlur={() => setConfirmingKey((k) => (k === r.key ? null : k))}
                  disabled={removingKey === r.key}
                  className={`ml-auto shrink-0 disabled:opacity-40 ${confirmingKey === r.key ? 'text-red-300 hover:text-red-200' : 'text-gray-500 hover:text-red-400'}`}
                >
                  {removingKey === r.key ? 'removing…' : confirmingKey === r.key ? 'confirm remove' : 'remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Controls. Range and granularity are separate questions: "how far back" and "how fine". */}
      <section className="panel-live rounded-[20px] p-[22px] flex flex-col gap-4">
      <div className="flex items-center gap-2.5 flex-wrap text-sm">
        <h3 className="text-lg font-semibold text-gray-100 mr-auto">Burn over time</h3>
        <Segmented options={RANGES.map((r) => ({ key: r.key, label: r.label }))} value={rangeKey} onChange={selectRange} accent="violet" />
        <Segmented options={BUCKETS.map((b) => ({ key: b.key, label: b.label }))} value={bucket} onChange={(k) => setBucket(k as 'hour' | 'day' | 'week')} accent="blue" />
        <Segmented
          options={[{ key: 'tokens', label: 'Tokens' }, { key: 'costUsd', label: 'Cost' }]}
          value={metric} onChange={(k) => setMetric(k as Metric)} accent="blue"
        />
        <button
          onClick={() => setCumulative((c) => !c)}
          aria-pressed={cumulative}
          className={`h-10 px-3.5 rounded-[10px] border text-[13px] font-semibold transition-colors ${
            cumulative
              ? 'border-neon-500 bg-neon-500/20 text-neon-50'
              : 'border-white/[0.14] text-gray-300 hover:text-gray-100'
          }`}
          title="Running total across the window — where you were when a plan limit was reached"
        >
          Cumulative
        </button>
      </div>

      <Chart
        points={points} max={max} metric={metric} bucket={bucket}
        loading={loading} hover={hover} setHover={setHover}
      />
      </section>


      {/* "What did this project cost me" is the question you arrive with. See the header for
          why this is the only breakdown. */}
      {data && data.byProject.length > 0 && (

        <section className="mb-6">
          <h3 className="text-gray-100 text-lg font-semibold mb-3">
            By project — {range.label.toLowerCase()}
          </h3>
          <div className="glass-light rounded-[18px] overflow-hidden">
            {data.byProject.map((p) => {
              const share = data.total.tokens > 0 ? p.tokens / data.total.tokens : 0;
              return (
                <div
                  key={p.project}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm border-b border-white/[0.04] last:border-0"
                >
                  <span className="flex-1 min-w-0 truncate text-gray-300">{p.project}</span>
                  <span className="hidden sm:block w-36 h-2 rounded-sm bg-[rgba(120,150,255,0.12)] overflow-hidden">
                    <span className="block h-full seg-on" style={{ width: `${Math.max(2, share * 100)}%` }} />
                  </span>
                  <span className="w-14 text-right text-gray-500 font-mono">{(share * 100).toFixed(1)}%</span>
                  <span className="w-20 text-right text-gray-400 font-mono">{compact(p.tokens)}</span>
                  {/* Turns, which the removed cartridge table used to be the only place to see.
                      The cartridge count rides along ONLY when a project spans more than one —
                      "1 cartridge" repeated down every row was the noise, but a project that
                      really does span several is the one case this row hides something. */}
                  <span className="w-28 text-right text-gray-500 font-mono">
                    {p.samples.toLocaleString()} turns{p.cartridges > 1 ? ` · ${p.cartridges} cart` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

    </div>
  );
}

function Stat({ label, value, note, accent = 'text-gray-300' }: {
  label: string; value: string; note?: string; accent?: string;
}) {
  return (
    <div className="glass-light rounded-[18px] p-5 flex flex-col gap-2.5">
      <div className="text-gray-400 text-[13px] capitalize">{label}</div>
      <div className={`${accent} font-display text-[34px] leading-none font-semibold`}>{value}</div>
      {note && <div className="text-gray-400 text-[13px]">{note}</div>}
    </div>
  );
}

function Segmented({ options, value, onChange, accent }: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (k: string) => void;
  accent: 'violet' | 'blue';
}) {
  const on = accent === 'violet' || accent === 'blue' ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : '';
  return (
    <div className="flex gap-1 p-1 rounded-[10px] bg-gl-code border border-white/[0.1] w-fit">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`h-8 px-3 rounded-[7px] text-xs font-semibold transition-colors ${
            value === o.key ? on : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Hand-rolled SVG rather than a charting dependency: this is a bar series with a hover
 * readout, and the repo has no chart library to be consistent with.
 *
 * Width comes from a ResizeObserver rather than a `preserveAspectRatio` stretch, because a
 * stretched viewBox distorts the axis text along with the bars.
 */
function Chart({ points, max, metric, bucket, loading, hover, setHover }: {
  points: { t: string; v: number; tokens: number; costUsd: number; samples: number }[];
  max: number; metric: Metric; bucket: string; loading: boolean;
  hover: number | null; setHover: (i: number | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  const H = 300, PAD_L = 68, PAD_B = 30, PAD_T = 14;

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(1, w - PAD_L - 8);
  const plotH = H - PAD_T - PAD_B;
  const step = plotW / Math.max(1, points.length);
  const barW = Math.max(1, step - (step > 6 ? 2 : 0.5));

  // Four gridlines is enough to read a magnitude off without turning the plot into a grid.
  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, v: max * f }));
  const hovered = hover != null ? points[hover] : null;

  return (
    <div ref={box} className="rounded-xl bg-gl-code p-3 relative">
      {loading && !points.length ? (
        <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">Loading…</div>
      ) : !points.length ? (
        <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">
          No usage recorded in this window.
        </div>
      ) : (
        <svg width="100%" height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Token burn over time">
          <defs>
            <linearGradient id="nc-bar" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#5AAEFF" />
              <stop offset="100%" stopColor="#5AAEFF" stopOpacity="0.15" />
            </linearGradient>
          </defs>
          {gridlines.map(({ f, v }) => {
            const y = PAD_T + plotH * (1 - f);
            return (
              <g key={f}>
                <line x1={PAD_L} x2={w - 8} y1={y} y2={y} stroke="rgba(120,150,255,0.1)" strokeWidth={1} />
                <text x={PAD_L - 10} y={y + 4} textAnchor="end" fontSize={11} fill="#8A97B8" fontFamily="JetBrains Mono, ui-monospace, monospace">
                  {fmt(v, metric)}
                </text>
              </g>
            );
          })}

          {points.map((p, i) => {
            const h = max > 0 ? (p.v / max) * plotH : 0;
            const x = PAD_L + i * step;
            return (
              <rect
                key={p.t}
                x={x} y={PAD_T + plotH - h} width={barW} height={Math.max(p.v > 0 ? 1 : 0, h)}
                fill={hover === i ? '#CFE6FF' : 'url(#nc-bar)'}
                rx={3}
                style={{ filter: 'drop-shadow(0 0 5px rgba(90,174,255,0.6))' }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}

          {/* A label every Nth bar — dense windows would otherwise print an unreadable smear. */}
          {points.map((p, i) => {
            const every = Math.max(1, Math.ceil(points.length / Math.max(4, Math.floor(w / 115))));
            if (i % every !== 0) return null;
            return (
              <text
                key={`t-${p.t}`} x={PAD_L + i * step + barW / 2} y={H - 8}
                textAnchor="middle" fontSize={11} fill="#8A97B8" fontFamily="JetBrains Mono, ui-monospace, monospace"
              >
                {tickLabel(p.t, bucket)}
              </text>
            );
          })}
        </svg>
      )}

      {hovered && (
        <div className="absolute top-3 right-3 text-[13px] font-mono bg-[#0A1020] border border-neon-500/40 rounded-[10px] px-3 py-2 pointer-events-none">
          <div className="text-gray-300">{new Date(hovered.t).toUTCString().replace(' GMT', ' UTC')}</div>
          <div className="text-neon-300">{compact(hovered.tokens)} tokens</div>
          <div className="text-emerald-300">{money(hovered.costUsd)}</div>
          <div className="text-gray-500">{hovered.samples.toLocaleString()} turns</div>
        </div>
      )}
    </div>
  );
}
