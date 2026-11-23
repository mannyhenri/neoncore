/**
 * THE SCOPE'S MEASURES OF SUCCESS (§10): how much is triaged with no human effort, how many agent
 * PRs merge without rework, how often "not a bug" was wrong (reopened), how fast the first reply
 * and the released fix come, and what an issue costs. A dash means not enough data yet.
 */
import type { TriageMetrics } from './types';
import { CARD, Empty, Loading, agentMin } from './ui';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const minutes = (v: number | null) => (v === null ? '—' : v < 60 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`);
const hours = (v: number | null) => (v === null ? '—' : v < 48 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} d`);

export const TRIAGE_METRICS: { key: keyof TriageMetrics; label: string; show: (m: TriageMetrics) => string; hint: string; goodLow?: boolean }[] = [
  { key: 'triagedNoHuman', label: 'Triaged with no human effort', show: (m) => pct(m.triagedNoHuman), hint: 'Share of bugs the agent took past triage on its own' },
  { key: 'mergedWithoutRework', label: 'Agent PRs merged without rework', show: (m) => pct(m.mergedWithoutRework), hint: 'Of the PRs merged, those with no changes requested' },
  { key: 'falseNotABug', label: 'False "not a bug"', show: (m) => pct(m.falseNotABug), hint: 'Labelled not a bug, then reopened', goodLow: true },
  { key: 'firstResponseMinutes', label: 'Report → first response', show: (m) => minutes(m.firstResponseMinutes), hint: 'Average time to the first comment', goodLow: true },
  { key: 'fixReleasedHours', label: 'Report → fix released', show: (m) => hours(m.fixReleasedHours), hint: 'Average, for released fixes', goodLow: true },
  { key: 'agentMinutesPerIssue', label: 'Agent time per issue', show: (m) => agentMin(m.agentMinutesPerIssue), hint: 'Average cartridge minutes, for issues the agent worked', goodLow: true },
];

export function MetricsTab({ metrics }: { metrics: TriageMetrics | undefined }) {
  if (metrics === undefined) return <Loading what="metrics" />;
  if (metrics.issues === 0) {
    return <Empty art="stage-follow-up" title="No measures yet"><p>They fill in as bugs move through the pipeline.</p></Empty>;
  }
  return (
    <div className="space-y-3">
      <div className="text-[13px] text-gray-400">{metrics.issues} issue(s) · {metrics.prsOpened} pull request(s) opened</div>
      <div data-triage-metrics className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {TRIAGE_METRICS.map((m) => (
          <div key={m.key} data-triage-metric={m.key} className={`${CARD} space-y-1`} title={m.hint}>
            <div className="text-[12px] text-gray-400">{m.label}</div>
            <div className="font-display text-3xl text-gray-50">{m.show(metrics)}</div>
            <div className="text-[11px] text-gray-500">{m.hint}{m.goodLow ? ' · lower is better' : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
