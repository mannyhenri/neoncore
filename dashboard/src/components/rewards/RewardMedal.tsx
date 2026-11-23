/**
 * A REWARD MEDAL — one tier of one reward family, earned or not yet.
 *
 * The medal is a ring in the tier's metal (bronze → silver → gold → …), the family's emblem in the
 * middle, and the threshold on a plate at the bottom ("25"). An unearned medal is the same medal,
 * dimmed: you can see what is next.
 *
 * THE EMBLEM IS AN ART SLOT (like the QA and Triage sections): when `public/rewards/<family>.png`
 * exists it is drawn; until then the slot shows a line icon, so the medals are complete either way.
 */
import { useState } from 'react';
import type { RewardFamilyId } from '../../types';

/** The metals, in tier order. A family with fewer tiers uses the first ones. */
export const TIER_METALS = [
  { name: 'Bronze', ring: '#C8803A', glow: 'rgba(200,128,58,0.55)' },
  { name: 'Silver', ring: '#C9D2E0', glow: 'rgba(201,210,224,0.5)' },
  { name: 'Gold', ring: '#F5C542', glow: 'rgba(245,197,66,0.6)' },
  { name: 'Platinum', ring: '#8FE3F0', glow: 'rgba(143,227,240,0.6)' },
  { name: 'Diamond', ring: '#B79CFF', glow: 'rgba(183,156,255,0.6)' },
  { name: 'Legend', ring: '#FF7AC8', glow: 'rgba(255,122,200,0.6)' },
  { name: 'Mythic', ring: '#FF5A4A', glow: 'rgba(255,90,74,0.65)' },
] as const;
export const metalOf = (tier: number) => TIER_METALS[Math.min(Math.max(tier, 0), TIER_METALS.length - 1)];

/** The stand-in emblems: one line icon per family (24 × 24). */
export const REWARD_ICONS: Record<RewardFamilyId, string> = {
  features: 'M12 3c3 2 5 5.5 5 9.5L15 16H9l-2-3.5C7 8.5 9 5 12 3zM9 16l-2 4 3-1.5M15 16l2 4-3-1.5M12 9.2a1.4 1.4 0 100 2.8 1.4 1.4 0 000-2.8z',
  epics: 'M3 20l6-10 3.5 5L15 11l6 9H3zM9 10V4l5 2-5 2',
  releases: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9M8 5.2l8 4.6',
  bugs: 'M9 8a3 3 0 016 0v1H9V8zM8 9h8v6a4 4 0 01-8 0V9zM4 10l4 1.5M20 10l-4 1.5M4 18l4-2M20 18l-4-2M3.5 14H8M16 14h4.5M12 9v10',
  qa: 'M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6l7-3zM8.5 12l2.5 2.5 4.5-5',
  clean: 'M7 4h10l4 5-9 11L3 9l4-5zM3 9h18M9.5 9L12 20l2.5-11M7 4l2.5 5M17 4l-2.5 5',
  streak: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3.2 2-4.2.2 1.8 1 2.7 2 3.2-.6-3 .2-6.5 1-9z',
  ontime: 'M7 3h10M7 21h10M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4M10 18.5h4',
  fastfix: 'M13 2L5 13.5h6L10 22l9-12.5h-6.5L13 2z',
  // A star over a ribbon: the commendation.
  commend: 'M12 2.5l2.3 4.7 5.2.7-3.8 3.6.9 5.1L12 14.2 7.4 16.6l.9-5.1L4.5 7.9l5.2-.7L12 2.5zM8.5 16.5L7 21.5l5-2.5 5 2.5-1.5-5',
};

export function RewardMedal({ family, tier, threshold, earned, label, size = 44 }: {
  family: RewardFamilyId;
  /** The tier's position in its family, 0 first: which metal. */
  tier: number;
  threshold: number;
  earned: boolean;
  /** What it is for, in full: "Gridlight AI — 10 features delivered". */
  label: string;
  size?: number;
}) {
  const [art, setArt] = useState(false);
  const metal = metalOf(tier);
  const plate = size >= 34;
  return (
    <span data-reward-medal data-family={family} data-threshold={threshold} data-earned={earned} data-metal={metal.name}
      role="img" aria-label={`${label}${earned ? '' : ' — not earned yet'}`} title={`${label}${earned ? ` · ${metal.name}` : ' — not earned yet'}`}
      className="relative inline-flex items-center justify-center rounded-full shrink-0 select-none"
      style={{
        width: size, height: size,
        background: `radial-gradient(circle at 35% 30%, #fff8, transparent 45%), ${metal.ring}`,
        boxShadow: earned ? `0 0 ${Math.round(size / 3)}px ${metal.glow}, inset 0 0 0 1px rgba(0,0,0,0.35)` : 'inset 0 0 0 1px rgba(0,0,0,0.35)',
        opacity: earned ? 1 : 0.28, filter: earned ? undefined : 'grayscale(1)',
      }}>
      <span className="absolute rounded-full bg-[#0B1322] flex items-center justify-center overflow-hidden" style={{ inset: Math.max(2, Math.round(size * 0.1)) }}>
        {/* The art, when it exists; it replaces the line icon once it has loaded. */}
        <img src={`/rewards/${family}.png`} alt="" draggable={false} onLoad={() => setArt(true)} onError={() => setArt(false)}
          className="absolute inset-0 w-full h-full object-contain" style={{ display: art ? 'block' : 'none', imageRendering: 'pixelated' }} />
        {!art && (
          <svg viewBox="0 0 24 24" width="62%" height="62%" fill="none" stroke={metal.ring} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={REWARD_ICONS[family]} />
          </svg>
        )}
      </span>
      {plate && (
        <span className="absolute left-1/2 -translate-x-1/2 px-1 rounded-[4px] font-display font-bold leading-none text-[#0B1322]"
          style={{ bottom: -Math.round(size * 0.1), background: metal.ring, fontSize: Math.max(9, Math.round(size * 0.24)), paddingTop: 1, paddingBottom: 1 }}>
          {threshold}
        </span>
      )}
    </span>
  );
}
