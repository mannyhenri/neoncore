/**
 * THE CAPTAIN'S RANK. A project's captain is promoted each time the project delivers an epic on or
 * before its date — a commendation (server lib/project-rewards.ts RANKS, rankFor):
 *
 *   Captain → General → Commander → Admiral → President
 *
 * The rank is counted by the server from the project's own epics; nothing here awards one. This
 * file is how a rank LOOKS: the plate under the captain (stars and the title), and the costume.
 *
 * THE COSTUME: a captain sheet per rank, the same man and the same six cycles as his own
 * (designs/captain-<rank>-sheet*.png → scripts/world/build_bridge.py). A rank with no sheet drawn
 * for the theme is null and the captain wears what he has — the plate still says who he is now.
 */
import { useEffect, useState } from 'react';
import type { ProjectRank } from '../../types';
import { api } from '../../lib/api';
import type { DeckSheet } from './bridge.generated';
import { DECK_ART as DECKS_SCIFI } from './bridge.generated';
import { THEME, type ThemeId } from '../theme';

export const RANKS = [
  { id: 'captain', title: 'Captain' },
  { id: 'general', title: 'General' },
  { id: 'commander', title: 'Commander' },
  { id: 'admiral', title: 'Admiral' },
  { id: 'president', title: 'President' },
] as const;
export type RankId = (typeof RANKS)[number]['id'];

/**
 * Each rank's costume, for a theme. Only the sheets drawn FOR THAT THEME's captain: the theme packs
 * fall back to the base theme's sprites for anything they lack (theme.ts packFor), which would put
 * the sci-fi captain's coat on the guildmaster — so costumes are read from the theme's own registry.
 */
export function costumesFor(theme: ThemeId): Record<RankId, DeckSheet | null> {
  const own: Record<string, DeckSheet | null | undefined> = theme === 'scifi' ? DECKS_SCIFI.sheets : {};
  return Object.fromEntries(RANKS.map((r) => [r.id, r.id === 'captain' ? null : own[`captain-${r.id}`] ?? null])) as Record<RankId, DeckSheet | null>;
}
/** The costumes of the theme this page was loaded with. */
export const RANK_COSTUMES: Record<RankId, DeckSheet | null> = costumesFor(THEME);
/** @deprecated the same as RANK_COSTUMES. */
export const RANK_SHEETS = RANK_COSTUMES;

/** The sheet to draw the captain from: his rank's costume when it exists, else his own. */
export function captainSheet(base: DeckSheet | null, rank: string | null | undefined, sheets: Partial<Record<string, DeckSheet | null>> = RANK_SHEETS): DeckSheet | null {
  return (rank ? sheets[rank] : null) ?? base;
}

const POLL_MS = 60_000;

/**
 * The last rank seen for each project, kept for the session and across reloads.
 *
 * Without it every visit to a project started with no rank — the captain in his own coat — and
 * swapped to his rank's costume a moment later when the rewards came back: a visible flash of the
 * wrong uniform each time you came back to a project. The remembered rank is shown at once and
 * replaced by the server's as soon as it answers (a promotion shows on that answer).
 */
const RANK_CACHE_KEY = 'neoncore.projectRanks';
const known = new Map<string, ProjectRank>();
function readCache(): void {
  try {
    const raw = globalThis.localStorage?.getItem(RANK_CACHE_KEY);
    if (!raw) return;
    for (const [id, r] of Object.entries(JSON.parse(raw) as Record<string, ProjectRank>)) {
      if (r && typeof r.index === 'number' && typeof r.id === 'string') known.set(id, r);
    }
  } catch { /* nothing remembered */ }
}
readCache();
function remember(projectId: string, rank: ProjectRank | null): void {
  if (rank) known.set(projectId, rank); else known.delete(projectId);
  try { globalThis.localStorage?.setItem(RANK_CACHE_KEY, JSON.stringify(Object.fromEntries(known))); } catch { /* storage full or off */ }
}
/** The remembered rank of a project, if any (for tests and first paint). */
export function rememberedRank(projectId: string): ProjectRank | null { return known.get(projectId) ?? null; }

/** A project's rank, read with its rewards. null while unknown (an older server, no project): no plate is shown. */
export function useProjectRank(projectId: string | null | undefined): ProjectRank | null {
  const [rank, setRank] = useState<{ id: string; rank: ProjectRank } | null>(() => {
    const r = projectId ? known.get(projectId) : undefined;
    return projectId && r ? { id: projectId, rank: r } : null;
  });
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    // Switching projects: show the one we are going to at once, from memory.
    const cached = known.get(projectId);
    setRank(cached ? { id: projectId, rank: cached } : null);
    const load = () => {
      try {
        void Promise.resolve(api.getProjectRewards?.(projectId))
          .then((r) => {
            if (!alive) return;
            const next = r && r.rank && typeof r.rank.index === 'number' ? r.rank : null;
            remember(projectId, next);
            setRank(next ? { id: projectId, rank: next } : null);
          })
          // A failed read keeps what we knew rather than undressing the captain.
          .catch(() => { /* keep the remembered rank */ });
      } catch { /* no rank shown */ }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [projectId]);
  if (rank && rank.id === projectId) return rank.rank;
  // First render after a switch, before the effect: the remembered rank, never the last project's.
  return projectId ? known.get(projectId) ?? null : null;
}

/** What a rank's plate says when you point at it. */
export function rankLine(rank: ProjectRank, name: string): string {
  const n = rank.commendations;
  const earned = n === 0 ? 'No commendation yet' : `${n} ${n === 1 ? 'epic' : 'epics'} delivered on or before ${n === 1 ? 'its' : 'their'} date`;
  const next = rank.next ? `Next: ${rank.next.title}, at ${rank.next.at}.` : 'The highest rank.';
  return `${name}: ${rank.title}. ${earned}. ${next}`;
}

/** The plate under the captain: one star per rank reached, and the title. */
export function RankPlate({ rank, name, compact = false }: { rank: ProjectRank; name: string; compact?: boolean }) {
  return (
    <div data-rank={rank.id} data-rank-index={rank.index} role="img" aria-label={rankLine(rank, name)} title={rankLine(rank, name)}
      className={`inline-flex flex-col items-center rounded-[9px] border border-[rgba(245,197,66,0.55)] bg-[rgba(24,16,4,0.88)] shadow-[0_0_12px_rgba(245,197,66,0.25)] ${compact ? 'px-2 py-0.5' : 'px-3 py-1'}`}>
      <span aria-hidden="true" className="flex gap-0.5 leading-none">
        {RANKS.map((r, i) => (
          <span key={r.id} data-rank-star data-on={i <= rank.index} className={`text-[11px] ${i <= rank.index ? 'text-[#F5C542]' : 'text-white/15'}`}>★</span>
        ))}
      </span>
      <span data-rank-title className={`font-display font-bold tracking-[0.14em] uppercase text-[#FFE39A] ${compact ? 'text-[11px]' : 'text-[12px]'}`}>{rank.title}</span>
    </div>
  );
}
