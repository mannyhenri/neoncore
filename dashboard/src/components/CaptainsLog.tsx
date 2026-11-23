/**
 * THE CAPTAIN'S LOG — the header of a project's changelog. The project's captain (in his rank's
 * uniform) logging on his tablet, a recording light, the project and today's stardate, how much is
 * on the log, and the plain CHANGELOG.md to take away. The entries below are the same as ever:
 * one per feature marked done, edited and released by a person.
 */
import { DECK_ART } from '../world/bridge/art';
import { DeckSprite } from '../world/bridge/Decks';
import { captainSheet, useProjectRank } from '../world/bridge/rank';
import type { ChangelogEntry } from '../types';

/** Today as a stardate: the year since 2000 in thousands, plus how far through the year it is — one decimal. */
export function stardate(at: Date): string {
  const y = at.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const days = (Date.UTC(y + 1, 0, 1) - start) / 86_400_000;
  const through = (at.getTime() - start) / 86_400_000 / days;
  return ((y - 2000) * 1000 + through * 1000).toFixed(1);
}

export function logCounts(entries: readonly Pick<ChangelogEntry, 'goalId'>[], inFlight: number): { entries: number; missions: number; inFlight: number } {
  return { entries: entries.length, missions: entries.filter((e) => !!e.goalId).length, inFlight };
}

export function CaptainsLogHeader({ projectId, projectName, entries, inFlight, downloadHref, now = new Date() }: {
  projectId: string; projectName: string; entries: readonly Pick<ChangelogEntry, 'goalId'>[];
  /** Features under way right now. */
  inFlight: number;
  downloadHref: string;
  now?: Date;
}) {
  const rank = useProjectRank(projectId);
  const sheet = captainSheet(DECK_ART.sheets.captain ?? null, rank?.id);
  const n = logCounts(entries, inFlight);
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return (
    <header data-captains-log className="relative overflow-hidden rounded-[20px] border border-[rgba(245,170,70,0.5)] px-6 py-4 flex items-center gap-6 flex-wrap"
      style={{ background: 'linear-gradient(100deg, rgba(40,28,10,0.85), rgba(14,22,34,0.92) 45%, rgba(10,18,30,0.95))', boxShadow: 'inset 0 0 40px rgba(245,170,70,0.12)' }}>
      {sheet && <div data-log-captain className="shrink-0 -my-2"><DeckSprite sheet={sheet} cycle={sheet.rows.log ? 'log' : 'idle'} fps={4} height={118} /></div>}
      <div className="min-w-0 flex-1">
        <p data-recording className="flex items-center gap-2 font-mono text-[12px] tracking-[0.3em] uppercase text-[#FF7A6A]">
          <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-[#FF4A3A] shadow-[0_0_8px_#FF4A3A] animate-pulse" />Recording
        </p>
        <h3 className="font-mono text-[30px] font-bold tracking-[0.14em] uppercase text-[#FFC25A] leading-tight drop-shadow-[0_0_10px_rgba(255,180,70,0.35)]">Captain&apos;s Log</h3>
        <p data-log-stardate className="font-mono text-[15px] tracking-[0.06em] text-[#8FE3D9]">{projectName} · Stardate {stardate(now)}</p>
        <p data-log-counts className="font-mono text-[14px] tracking-[0.04em] text-gray-300 mt-1">
          {plural(n.entries, 'entry', 'entries')} · {plural(n.missions, 'mission logged', 'missions logged')} · {n.inFlight} in flight
        </p>
      </div>
      <div className="text-right max-w-[300px]">
        <a data-log-download href={downloadHref} className="font-mono text-[15px] text-[#8FE3D9] hover:text-white">↓ Download CHANGELOG.md</a>
        <p className="text-[12px] text-gray-400 mt-1 leading-snug">Published in the official wording — the log look stays on this screen.</p>
      </div>
    </header>
  );
}
