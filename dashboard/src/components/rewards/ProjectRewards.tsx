/**
 * A PROJECT'S REWARDS, on its page: every medal it has earned, and the next one in each family.
 *
 * Closed, it is one row — the highest medal earned in each family, with the project's name on
 * each (its tooltip and label). Open, it is the whole board: every family, every tier, the count
 * so far and how far the next one is. Rewards are counted by the server from the project's own
 * records (lib/project-rewards.ts); nothing is awarded by hand.
 */
import { useEffect, useState } from 'react';
import type { Project, ProjectRewards as Rewards, RewardFamily } from '../../types';
import { api } from '../../lib/api';
import { RewardMedal } from './RewardMedal';

/** The highest tier earned in a family: its index, or -1 when none is. */
export const topTier = (f: Pick<RewardFamily, 'tiers'>): number => f.tiers.reduce((top, t, i) => (t.earned ? i : top), -1);

export function ProjectRewards({ project, version = 0 }: { project: Pick<Project, 'id' | 'name'>; version?: number }) {
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    // A server (or a client) without rewards yet: nothing is shown, and nothing breaks.
    Promise.resolve().then(() => api.getProjectRewards(project.id)).then((r) => { if (alive) setRewards(r && Array.isArray(r.families) ? r : null); }).catch(() => { if (alive) setRewards(null); });
    return () => { alive = false; };
  }, [project.id, version]);
  if (!rewards) return null;
  const earnedFamilies = rewards.families.filter((f) => topTier(f) >= 0);

  return (
    <section data-project-rewards data-earned={rewards.earned} className="rounded-[16px] border border-white/[0.1] bg-white/[0.02] px-4 py-3">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-3 flex-wrap text-left">
        <span className="text-[11px] font-bold tracking-[0.14em] uppercase text-neon-300">Rewards</span>
        <span data-rewards-count className="font-display text-[16px] font-bold text-gray-100">{rewards.earned}<span className="text-gray-500 font-semibold"> / {rewards.total}</span></span>
        <span data-rewards-top className="flex items-center gap-2.5 flex-wrap">
          {earnedFamilies.map((f) => {
            const i = topTier(f);
            return <RewardMedal key={f.id} family={f.id} tier={i} threshold={f.tiers[i].threshold} earned label={f.tiers[i].label} size={38} />;
          })}
          {earnedFamilies.length === 0 && <span className="text-[13px] text-gray-400">None yet — the first comes with the first feature {project.name} delivers.</span>}
        </span>
        <span className="flex-1" />
        <span className="text-[12px] font-semibold text-neon-300">{open ? 'Hide ▴' : 'All rewards ▾'}</span>
      </button>
      {open && (
        <ul data-rewards-board className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
          {rewards.families.map((f) => {
            const prev = [...f.tiers].reverse().find((t) => t.earned)?.threshold ?? 0;
            const pct = f.next === null ? 100 : Math.round(((f.count - prev) / (f.next - prev)) * 100);
            return (
              <li key={f.id} data-reward-family={f.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-semibold text-gray-100">{f.label}</span>
                  <span data-reward-progress className="text-[12px] text-gray-400">
                    {f.next === null ? `${f.count} — every medal earned` : `${f.count} so far · ${f.next - f.count} more to the next`}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-wrap mt-2.5 pb-1.5">
                  {f.tiers.map((t, i) => <RewardMedal key={t.threshold} family={f.id} tier={i} threshold={t.threshold} earned={t.earned} label={t.label} />)}
                </div>
                <div role="progressbar" aria-label={`${f.label}: progress to the next medal`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
                  className="mt-2 h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                  <span className="block h-full bg-neon-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
