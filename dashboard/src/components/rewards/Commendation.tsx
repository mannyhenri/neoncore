/**
 * THE COMMENDATION — an epic delivered on or before its due date (server lib/project-rewards.ts).
 *
 * Unlike the other badges it is a decoration, not a medal: a laurel wreath around the explorer
 * statue (the map's own statue sprite), a red ribbon hanging below, and its name. Five of them:
 * General's Star, Commander's Cross, Admiral's Anchor, Presidential Medal (each with a promotion of
 * the project's captain) and the Order of the Fleet at ten. The trophy case shows the rank ladder
 * beside them, the captain's current rank lit.
 */
import { PACK } from '../../world/theme';
import { RANKS } from '../../world/bridge/rank';
import type { ProjectRank } from '../../types';
import { metalOf } from './RewardMedal';

/** One leaf of the wreath, as a path around (0,0) pointing up; placed along an arc. */
const LEAF = 'M0 0 C 3 -3, 3 -8, 0 -11 C -3 -8, -3 -3, 0 0 Z';

export function CommendationMedal({ tier, threshold, earned, label, name, size = 56 }: {
  tier: number; threshold: number; earned: boolean; label: string; name?: string; size?: number;
}) {
  const metal = metalOf(tier);
  const statue = PACK.kit.statue?.src;
  // Seven leaves a side, from the bottom up round to the top.
  const leaves = Array.from({ length: 7 }, (_, i) => 200 - i * 22);
  return (
    <span data-reward-medal data-commendation data-family="commend" data-threshold={threshold} data-earned={earned} data-metal={metal.name}
      role="img" aria-label={`${label}${earned ? '' : ' — not earned yet'}`} title={`${name ? `${name} — ` : ''}${label}${earned ? '' : ' — not earned yet'}`}
      className="relative inline-flex flex-col items-center shrink-0 select-none"
      style={{ width: size, opacity: earned ? 1 : 0.3, filter: earned ? `drop-shadow(0 0 ${Math.round(size / 6)}px ${metal.glow})` : 'grayscale(1)' }}>
      <svg data-laurel viewBox="-30 -30 60 60" width={size} height={size} aria-hidden="true" className="block">
        {/* the red ribbon, hanging behind the wreath */}
        <g data-ribbon>
          <path d="M-9 8 L-15 29 L-9.5 25.5 L-5 30 L0 10 Z" fill="#C8262E" stroke="#7A1018" strokeWidth="0.8" />
          <path d="M9 8 L15 29 L9.5 25.5 L5 30 L0 10 Z" fill="#E0343C" stroke="#7A1018" strokeWidth="0.8" />
        </g>
        {/* the disc */}
        <circle r="17" fill="#0B1322" stroke={metal.ring} strokeWidth="2.4" />
        {/* the wreath: leaves along both sides, tied at the bottom */}
        {[-1, 1].map((side) => (
          <g key={side} transform={`scale(${side} 1)`}>
            {leaves.map((deg, i) => {
              const a = (deg * Math.PI) / 180;
              const x = 22 * Math.cos(a), y = 22 * Math.sin(a);
              return <path key={i} d={LEAF} transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${(deg + 90 + 8).toFixed(1)}) scale(0.9)`} fill={i % 2 ? '#7FBF4D' : '#5E9E3A'} stroke="#2F5A1E" strokeWidth="0.5" />;
            })}
          </g>
        ))}
        <circle cy="21" r="2.6" fill={metal.ring} />
      </svg>
      {/* the explorer statue in the middle */}
      {statue && <img src={statue} alt="" draggable={false} className="absolute pointer-events-none" style={{ top: size * 0.24, left: size * 0.36, width: size * 0.28, height: size * 0.4, objectFit: 'contain', imageRendering: 'pixelated' }} />}
      <span className="absolute left-1/2 -translate-x-1/2 px-1 rounded-[4px] font-display font-bold leading-none text-[#0B1322]"
        style={{ top: size * 0.62, background: metal.ring, fontSize: Math.max(9, Math.round(size * 0.18)), paddingTop: 1, paddingBottom: 1 }}>{threshold}</span>
    </span>
  );
}

/** The ranks from Captain up, the current one lit, the ones passed ticked, the next saying what it takes. */
export function RankLadder({ rank }: { rank: ProjectRank }) {
  return (
    <ol data-rank-ladder aria-label="The captain's rank" className="flex items-stretch gap-1.5 flex-wrap">
      {RANKS.map((r, i) => {
        const now = i === rank.index;
        const passed = i < rank.index;
        return (
          <li key={r.id} data-rank-step={r.id} data-current={now || undefined} data-passed={passed || undefined} aria-current={now ? 'step' : undefined}
            className={`px-2.5 py-1 rounded-[8px] border text-[12px] font-semibold ${now ? 'border-[#F5C542] bg-[rgba(245,197,66,0.16)] text-[#FFE39A] shadow-[0_0_12px_rgba(245,197,66,0.35)]' : passed ? 'border-emerald-400/40 text-emerald-200' : 'border-white/[0.12] text-gray-400'}`}>
            {passed ? '✓ ' : now ? '★ ' : ''}{r.title}
            <span className="block text-[10px] font-normal text-gray-400">{i === 0 ? 'to start' : `${i} on time`}</span>
          </li>
        );
      })}
    </ol>
  );
}
