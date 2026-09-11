import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEntry } from '@neoncore/client';
import { groupFleetReadings, type UsageCheckpoint } from '../lib/subscriptionUsage';

/**
 * REPORTED: "can you also remove the last one I added it was wrong" — and then "yes add a
 * remove action". A reading anchors the whole gauge, so a typo must be undoable from the page.
 *
 * The desk logs a reading to every server, so each machine holds its own copy with its own id.
 * Removing it from one would leave the others still anchored on the mistake — the removal must
 * reach every copy, and must not fire on a single stray click.
 */
const mocks = vi.hoisted(() => ({
  getUsageCheckpoints: vi.fn(),
  removeUsageCheckpoint: vi.fn(),
}));

vi.mock('../lib/api', () => {
  const client = {
    getUsageSeries: vi.fn(async () => ({ bucket: 'day', days: 30, since: '', series: [], projects: [], cartridges: [] })),
    getBurnRate: vi.fn(async () => ({
      windowHours: 168, days: 7, tokens: 0, tokensPerHour: 0, tokensPerDay: 0,
      costUsd: 0, costPerDay: 0, samples: 0, activeCartridges: 0, subscriptionUsage: [], usageAnchor: [],
    })),
    markTokenLimit: vi.fn(),
    logUsageCheckpoint: vi.fn(),
    getUsageCheckpoints: mocks.getUsageCheckpoints,
    removeUsageCheckpoint: mocks.removeUsageCheckpoint,
  };
  return { api: client, apiFor: () => client };
});

import { TokensPage } from '../components/TokensPage';

const servers: ServerEntry[] = [
  { url: '', serverId: 'local', name: 'Local', token: null, manual: true },
  { url: 'http://studio.local:4040', serverId: 'studio', name: 'Studio', token: null, manual: true },
];

const reading = (id: string, over: Partial<UsageCheckpoint> = {}): UsageCheckpoint => ({
  id, provider: 'claude', window: 'weekly', pctUsed: 0.32,
  resetsAt: '2026-09-14T14:24:00.000Z', observedAt: '2026-09-11T14:24:37.443Z', localTokens: 1, ...over,
});

describe('groupFleetReadings: one logged reading is one row, however many servers hold it', () => {
  const CASES: { label: string; answers: (UsageCheckpoint[] | null)[]; want: { rows: number; copies: number[] } }[] = [
    { label: 'the same reading on two servers', answers: [[reading('a')], [reading('b')]], want: { rows: 1, copies: [2] } },
    { label: 'a server that did not answer', answers: [[reading('a')], null], want: { rows: 1, copies: [1] } },
    { label: 'seconds apart in the same minute still one reading', answers: [[reading('a')], [reading('b', { observedAt: '2026-09-11T14:24:59.000Z' })]], want: { rows: 1, copies: [2] } },
    { label: 'a different percent is a different reading', answers: [[reading('a')], [reading('b', { pctUsed: 0.4 })]], want: { rows: 2, copies: [1, 1] } },
    { label: 'a different window is a different reading', answers: [[reading('a'), reading('c', { window: 'session' })]], want: { rows: 2, copies: [1, 1] } },
    { label: 'nothing anywhere', answers: [[], null], want: { rows: 0, copies: [] } },
  ];
  for (const c of CASES) {
    it(c.label, () => {
      const rows = groupFleetReadings(c.answers);
      expect(rows.length).toBe(c.want.rows);
      expect(rows.map((r) => r.copies.length).sort()).toEqual([...c.want.copies].sort());
    });
  }
  it('lists the newest reading first', () => {
    const rows = groupFleetReadings([[reading('old', { observedAt: '2026-09-09T10:00:00.000Z', pctUsed: 0.1 }), reading('new')]]);
    expect(rows.map((r) => r.copies[0].id)).toEqual(['new', 'old']);
  });
});

describe('removing a reading from the Tokens page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Local answers first, then Studio — each holds its own copy of the one reading.
    mocks.getUsageCheckpoints
      .mockResolvedValueOnce({ checkpoints: [reading('local-copy')], anchors: [] })
      .mockResolvedValueOnce({ checkpoints: [reading('studio-copy')], anchors: [] })
      .mockResolvedValue({ checkpoints: [], anchors: [] });
    mocks.removeUsageCheckpoint.mockResolvedValue({ ok: true, anchors: [] });
  });

  it('shows the reading once, asks to confirm, then removes every copy', async () => {
    render(<TokensPage servers={servers} />);
    const list = await screen.findByRole('list', { name: 'logged readings' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('32%');

    fireEvent.click(within(list).getByRole('button', { name: 'remove' }));
    expect(mocks.removeUsageCheckpoint, 'one click must only arm the removal').not.toHaveBeenCalled();

    fireEvent.click(within(list).getByRole('button', { name: 'confirm remove' }));
    await waitFor(() => expect(mocks.removeUsageCheckpoint).toHaveBeenCalledTimes(2));
    expect(mocks.removeUsageCheckpoint.mock.calls.map((c) => c[0]).sort()).toEqual(['local-copy', 'studio-copy']);
    expect(await screen.findByText('Removed the 32% reading.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('list', { name: 'logged readings' })).toBeNull());
  });

  it('a copy that is already gone counts as removed, not as a failure', async () => {
    mocks.removeUsageCheckpoint
      .mockResolvedValueOnce({ ok: true, anchors: [] })
      .mockRejectedValueOnce(new Error('404: no such reading — it may already be removed'));
    render(<TokensPage servers={servers} />);
    const list = await screen.findByRole('list', { name: 'logged readings' });
    fireEvent.click(within(list).getByRole('button', { name: 'remove' }));
    fireEvent.click(within(list).getByRole('button', { name: 'confirm remove' }));
    expect(await screen.findByText('Removed the 32% reading.')).toBeTruthy();
  });
});
