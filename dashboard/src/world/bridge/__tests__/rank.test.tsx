/**
 * THE CAPTAIN'S RANK, as it is shown. Set-based over every rank: the plate's title and stars, what
 * it says of the next one, and which sheet the captain is drawn from (his rank's costume when its
 * art is in, his own until then).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { ProjectRank } from '../../../types';

const calls = vi.hoisted(() => ({ getProjectRewards: vi.fn() }));
vi.mock('../../../lib/api', () => ({ api: calls }));
import { RANKS, RANK_SHEETS, RANK_COSTUMES, RankPlate, captainSheet, costumesFor, rankLine, useProjectRank } from '../rank';
import { DECK_ART as DECK_ART_BASE } from '../bridge.generated';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

afterEach(() => { cleanup(); calls.getProjectRewards.mockReset(); });

/** The server's rankFor, for a number of commendations. */
const rank = (n: number): ProjectRank => {
  const index = Math.min(n, RANKS.length - 1);
  return { index, id: RANKS[index].id, title: RANKS[index].title, commendations: n, next: index < RANKS.length - 1 ? { title: RANKS[index + 1].title, at: index + 1 } : null };
};
const base = { src: '/world/bridge/captain.png', frameW: 224, frameH: 320, rows: { idle: { row: 0, frames: 4 } } };

describe('the captain\'s rank', () => {
  it('the ranks, in order', () => {
    expect(RANKS.map((r) => r.title)).toEqual(['Captain', 'General', 'Commander', 'Admiral', 'President']);
    expect(Object.keys(RANK_SHEETS)).toEqual(RANKS.map((r) => r.id));
  });

  it.each([0, 1, 2, 3, 4, 5, 6].map((n) => ({ n })))('$n commendations: the plate names the rank, lights one star per rank reached, and says what is next', ({ n }) => {
    const r = rank(n);
    const { container } = render(<RankPlate rank={r} name="Gridlight" />);
    const plate = container.querySelector('[data-rank]')!;
    expect(plate.getAttribute('data-rank')).toBe(r.id);
    expect(plate.querySelector('[data-rank-title]')!.textContent).toBe(r.title);
    const stars = [...plate.querySelectorAll('[data-rank-star]')].map((s) => s.getAttribute('data-on'));
    expect(stars).toEqual(RANKS.map((_, i) => String(i <= r.index)));
    const line = plate.getAttribute('aria-label')!;
    expect(line).toBe(rankLine(r, 'Gridlight'));
    expect(line).toContain(`Gridlight: ${r.title}.`);
    expect(line).toContain(n === 0 ? 'No commendation yet' : n === 1 ? '1 epic delivered on or before its date' : `${n} epics delivered on or before their date`);
    expect(line).toContain(r.next ? `Next: ${r.next.title}, at ${r.next.at}.` : 'The highest rank.');
  });

  it.each(RANKS.map((r) => ({ id: r.id })))('$id: the captain wears his rank\'s costume when its art is in, and his own until then', ({ id }) => {
    // With no costume in the set given, every rank falls back to the captain's own sheet.
    expect(captainSheet(base, id, {})).toBe(base);
    const costume = { ...base, src: `/world/bridge/captain-${id}.png` };
    expect(captainSheet(base, id, { [id]: costume })).toBe(costume);
    // Another rank's costume is not his.
    expect(captainSheet(base, id, { someone: costume })).toBe(base);
    expect(captainSheet(base, null, { [id]: costume })).toBe(base);
    expect(captainSheet(null, id, {})).toBeNull();
    // With this theme's own costumes (the default), a rank above Captain wears his: never the base sheet.
    expect(captainSheet(base, id)).toBe(id === 'captain' ? base : RANK_COSTUMES[id as keyof typeof RANK_COSTUMES]);
  });

  it('a project\'s rank is read from its rewards; none is shown for a server that sends no rank, or no project', async () => {
    const seen: (string | null)[] = [];
    function Probe({ id }: { id: string | null }) { const r = useProjectRank(id); seen.push(r ? r.title : null); return <span data-probe>{r?.title ?? 'none'}</span>; }
    calls.getProjectRewards.mockResolvedValue({ families: [], rank: rank(2) });
    const view = render(<Probe id="p1" />);
    await waitFor(() => expect(view.container.querySelector('[data-probe]')!.textContent).toBe('Commander'));
    expect(calls.getProjectRewards).toHaveBeenCalledWith('p1');
    cleanup();
    calls.getProjectRewards.mockResolvedValue({ families: [] });
    const old = render(<Probe id="p2" />);
    await waitFor(() => expect(calls.getProjectRewards).toHaveBeenCalledWith('p2'));
    expect(old.container.querySelector('[data-probe]')!.textContent).toBe('none');
    cleanup();
    calls.getProjectRewards.mockClear();
    render(<Probe id={null} />);
    expect(calls.getProjectRewards).not.toHaveBeenCalled();
  });
});

describe('the sci-fi captain\'s costumes', () => {
  it('every rank above Captain has its own costume: his six cycles, served from public/; Captain wears his own sheet', () => {
    const own = DECK_ART_BASE.sheets.captain!;
    expect(RANK_COSTUMES.captain).toBeNull();
    for (const r of RANKS.slice(1)) {
      const s = RANK_COSTUMES[r.id];
      expect(s, r.id).not.toBeNull();
      expect(s!.src, r.id).toBe(`/world/bridge/captain-${r.id}.png`);
      expect(Object.keys(s!.rows), r.id).toEqual(Object.keys(own.rows));
      expect(existsSync(resolve(HERE, '../../../../public', s!.src.replace(/^\//, ''))), `${s!.src} is missing from public/`).toBe(true);
    }
    // A theme whose captain is someone else never borrows them.
    for (const r of RANKS) expect(costumesFor('fantasy')[r.id], r.id).toBeNull();
    expect(costumesFor('scifi')).toEqual(RANK_COSTUMES);
  });
});
