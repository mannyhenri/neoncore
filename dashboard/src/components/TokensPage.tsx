import { useState, useEffect, useMemo, useRef } from 'react';
import { api, apiFor } from '../lib/api';
import { activeServers } from '../lib/servers';
import { mergeSeries, type UsageSeries, type FleetSeries } from '../lib/usageSeries';
import { describeProblems } from '../lib/serverAnswer';
import type { ServerEntry } from '@neoncore/client';

/**
 * Token reporting: burn over time, so a change in how you work can be seen in what it costs.
 *
 * Two questions drive the layout. "Did my spend move, and when" is the chart. "On what" is the
 * cartridge table under it — a single line cannot answer the second, and it is always the next
 * thing asked, so both come off one fetch.
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
    const load = async () => {
      const list = activeServers(servers);
      const answers = await Promise.all(
        list.map(async (s) => ({
          label: s.name || (s.url ? new URL(s.url).hostname : 'This machine'),
          result: await (s.url ? apiFor(s.url, s.token) : api)
            .getUsageSeries(range.days, bucket)
            .then((r) => r as UsageSeries)
            .catch(() => null),
        })),
      );
      if (!alive) return;
      setData(mergeSeries(answers, bucket, range.days));
      setLoading(false);
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetKey, range.days, bucket]);

  const points = useMemo(() => {
    const raw = data?.series ?? [];
    if (!cumulative) return raw.map((p) => ({ ...p, v: p[metric] }));
    // Cumulative answers "where was I when I hit the ceiling" — a running total makes the
    // moment a plan limit was reached readable off the curve.
    let run = 0;
    return raw.map((p) => { run += p[metric]; return { ...p, v: run }; });
  }, [data, metric, cumulative]);

  const max = points.reduce((m, p) => Math.max(m, p.v), 0) || 1;
  const problems = data?.problems ?? [];

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-gray-400 text-base md:text-lg font-semibold uppercase tracking-wide">
          Token Report
        </h2>
        {data && (
          <div className="flex items-baseline gap-5 text-sm font-mono">
            <span className="text-gray-500">
              <span className="text-gl-blue/90 text-xl">{compact(data.total.tokens)}</span> tokens
            </span>
            <span className="text-gray-500">
              <span className="text-emerald-500/90 text-xl">{money(data.total.costUsd)}</span> spend
            </span>
            <span className="text-gray-600">{data.total.samples.toLocaleString()} turns</span>
          </div>
        )}
      </div>

      {problems.length > 0 && (
        <div className="text-[13px] text-amber-500/90 border border-amber-500/20 bg-amber-500/5 rounded-md px-3 py-2">
          Partial: {data!.serversReporting} of {data!.serversAsked} servers reported.
          The figures below are lower than reality — {describeProblems(problems)}.
        </div>
      )}

      {/* Controls. Range and granularity are separate questions: "how far back" and "how fine". */}
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <Segmented options={RANGES.map((r) => ({ key: r.key, label: r.label }))} value={rangeKey} onChange={selectRange} accent="violet" />
        <Segmented options={BUCKETS.map((b) => ({ key: b.key, label: b.label }))} value={bucket} onChange={(k) => setBucket(k as 'hour' | 'day' | 'week')} accent="blue" />
        <Segmented
          options={[{ key: 'tokens', label: 'Tokens' }, { key: 'costUsd', label: 'Cost' }]}
          value={metric} onChange={(k) => setMetric(k as Metric)} accent="blue"
        />
        <button
          onClick={() => setCumulative((c) => !c)}
          className={`px-3.5 py-1.5 rounded-md border transition-colors ${
            cumulative
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-white/10 bg-white/[0.04] text-gray-500 hover:text-gray-300'
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

      {data && data.byCartridge.length > 0 && (
        <section>
          <h3 className="text-gray-500 text-sm font-semibold uppercase tracking-wide mb-2">
            By cartridge — {range.label.toLowerCase()}
          </h3>
          <div className="border border-white/[0.06] rounded-lg overflow-hidden">
            {data.byCartridge.map((c, i) => {
              const share = data.total.tokens > 0 ? c.tokens / data.total.tokens : 0;
              return (
                <div
                  key={`${c.agentId}-${i}`}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm border-b border-white/[0.04] last:border-0"
                >
                  <span className="flex-1 min-w-0 truncate text-gray-300">{c.name}</span>
                  {/* The share bar is the point of the row: which cartridge is the spend. */}
                  <span className="hidden sm:block w-36 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                    <span className="block h-full bg-gl-blue/60" style={{ width: `${Math.max(2, share * 100)}%` }} />
                  </span>
                  <span className="w-14 text-right text-gray-600 font-mono">{(share * 100).toFixed(1)}%</span>
                  <span className="w-20 text-right text-gray-400 font-mono">{compact(c.tokens)}</span>
                  <span className="w-24 text-right text-gray-600 font-mono">{c.samples.toLocaleString()} turns</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Segmented({ options, value, onChange, accent }: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (k: string) => void;
  accent: 'violet' | 'blue';
}) {
  const on = accent === 'violet' ? 'bg-violet-900/60 text-violet-300' : 'bg-white/10 text-gray-200';
  return (
    <div className="flex rounded-md overflow-hidden border border-white/10 w-fit">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-3.5 py-1.5 font-medium transition-colors ${
            value === o.key ? on : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'
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
    <div ref={box} className="border border-white/[0.06] rounded-lg bg-white/[0.02] p-3 relative">
      {loading && !points.length ? (
        <div className="h-[300px] flex items-center justify-center text-gray-600 text-sm">Loading…</div>
      ) : !points.length ? (
        <div className="h-[300px] flex items-center justify-center text-gray-600 text-sm">
          No usage recorded in this window.
        </div>
      ) : (
        <svg width="100%" height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Token burn over time">
          {gridlines.map(({ f, v }) => {
            const y = PAD_T + plotH * (1 - f);
            return (
              <g key={f}>
                <line x1={PAD_L} x2={w - 8} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                <text x={PAD_L - 10} y={y + 4} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.38)" fontFamily="ui-monospace, monospace">
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
                className={hover === i ? 'fill-gl-pink' : 'fill-gl-blue/70'}
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
                textAnchor="middle" fontSize={11} fill="rgba(255,255,255,0.38)" fontFamily="ui-monospace, monospace"
              >
                {tickLabel(p.t, bucket)}
              </text>
            );
          })}
        </svg>
      )}

      {hovered && (
        <div className="absolute top-3 right-3 text-[13px] font-mono bg-black/80 border border-white/15 rounded-md px-3 py-2 pointer-events-none">
          <div className="text-gray-300">{new Date(hovered.t).toUTCString().replace(' GMT', ' UTC')}</div>
          <div className="text-gl-blue/90">{compact(hovered.tokens)} tokens</div>
          <div className="text-emerald-500/90">{money(hovered.costUsd)}</div>
          <div className="text-gray-600">{hovered.samples.toLocaleString()} turns</div>
        </div>
      )}
    </div>
  );
}
