/**
 * A NEW MAP TO DISCOVER. The whole outfit — every project together — opens a new map by what it
 * delivers (server lib/project-rewards.ts worldProgress). On the map this is one chip: how many of
 * the map's requirements are met; open, it lists each one with its count and a bar, so it is always
 * clear what is left. Once every requirement is met the map is unlocked, and stays unlocked.
 */
import { useState } from 'react';
import type { MapProgress } from '../types';

export function NewMapPanel({ map, ready }: {
  map: MapProgress;
  /** The unlocked map's terrain exists and can be travelled to. Until then an unlocked map says it is being charted. */
  ready?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const when = map.unlockedAt ? new Date(map.unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return (
    <div data-new-map={map.id} data-unlocked={map.unlocked} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        title={map.unlocked ? `${map.name} — unlocked` : `${map.name} — ${map.met} of ${map.total} done`}
        className={`h-full px-3 py-1.5 rounded-[10px] text-left whitespace-nowrap transition-colors ${map.unlocked ? 'bg-amber-400/15 shadow-[inset_0_0_0_1px_rgba(245,197,66,0.7)]' : 'hover:bg-white/[0.06]'}`}>
        <span className={`block font-display text-[13px] font-bold tracking-[0.1em] uppercase ${map.unlocked ? 'text-amber-200' : 'text-gray-300'}`}>
          {map.unlocked ? '★ New map open' : '🔒 New map'}
        </span>
        <span data-new-map-count className="block text-[12px] text-gray-400 tabular-nums">{map.unlocked ? map.name : `${map.met} of ${map.total} done`}</span>
      </button>
      {open && (
        <div data-new-map-panel role="dialog" aria-label={map.name}
          className="absolute top-full mt-2 left-1/2 -translate-x-1/2 z-40 w-[360px] max-w-[92vw] rounded-[14px] border border-white/[0.16] bg-[rgba(10,16,32,0.97)] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
          <p className="font-display text-[16px] font-semibold text-gray-100">{map.name}</p>
          <p data-new-map-state className="text-[13px] text-gray-400 mt-0.5 leading-snug">
            {map.unlocked
              ? `Unlocked ${when}. ${ready ? 'It is open — travel there from the map switch.' : 'Its terrain is still being drawn: the map opens here as soon as the art is in.'}`
              : 'Opens when all your projects together have done every one of these.'}
          </p>
          <ul className="mt-3 space-y-2.5">
            {map.requirements.map((r) => (
              <li key={r.family} data-map-requirement={r.family} data-met={r.met}>
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className={r.met ? 'text-emerald-300' : 'text-gray-200'}>{r.met ? '✓ ' : ''}{r.label}</span>
                  <span className="text-gray-400 tabular-nums">{Math.min(r.count, r.target)} / {r.target}</span>
                </div>
                <div role="progressbar" aria-label={r.label} aria-valuemin={0} aria-valuemax={r.target} aria-valuenow={Math.min(r.count, r.target)}
                  className="mt-1 h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                  <span className={`block h-full ${r.met ? 'bg-emerald-400' : 'bg-neon-400'}`} style={{ width: `${Math.min(100, Math.round((r.count / r.target) * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
