import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEntry } from '@neoncore/client';
import { reachEstimate, type UsageAnchor } from '../lib/subscriptionUsage';

const anchor = (over: Partial<UsageAnchor> = {}): UsageAnchor => ({
  provider: 'claude', window: 'weekly', basis: 'checkpoint', pctUsed: 0.66, pctAtCheckpoint: 0.48,
  observedAt: '2026-11-16T12:44:00.000Z', resetsAt: '2026-11-19T23:00:00.000Z', pctPerDay: 0.099,
  hoursToReset: 8, hoursToWall: 84, hitsWallBeforeReset: false, tokensPerPct: 159_400_000, samples: 1,
  pace: 'ok', recommendation: '66% used, on pace to reset in 8h with headroom.', ...over,
});

const mocks = vi.hoisted(() => ({
  anchors: [] as unknown[],
  checkpoints: [] as unknown[],
  offline: false,
}));

vi.mock('../lib/api', () => {
  const client = (down: boolean) => ({
    getUsageSeries: vi.fn(async () => {
      if (down) throw new Error('offline');
      return { bucket: 'day', days: 30, since: '', series: [], projects: [], cartridges: [] };
    }),
    getBurnRate: vi.fn(async () => ({
      windowHours: 168, days: 7, tokens: 0, tokensPerHour: 0, tokensPerDay: 0,
      costUsd: 0, costPerDay: 0, samples: 0, activeCartridges: 0,
      subscriptionUsage: [{ provider: 'claude', ceilingTokens: 18_800_000_000, tokensUsed: 1, tokensPerDay: 1, pctUsed: 3.72, daysRemaining: 0, samples: 1, confidence: 0.44, lastHitAt: '' }],
      usageAnchor: mocks.anchors,
    })),
    getUsageCheckpoints: vi.fn(async () => ({ checkpoints: mocks.checkpoints, anchors: [] })),
  });
  return { api: client(false), apiFor: () => client(mocks.offline) };
});

import { TokensPage } from '../components/TokensPage';

const servers: ServerEntry[] = [
  { url: '', serverId: 'local', name: 'Local', token: null, manual: true },
  { url: 'http://studio.local:4040', serverId: 'studio', name: 'Studio', token: null, manual: true },
];

/**
 * THE USAGE LOG. One place to type what the provider's meter shows, the list of what was
 * typed, and ONE line that answers the only question: when do we reach 100%?
 */
describe('when we reach 100%', () => {
  it('is said in one sentence for every case the estimate can be in', () => {
    const cases: [Partial<UsageAnchor>, string][] = [
      // At this pace the limit comes before the reset.
      [{ hoursToWall: 31, hitsWallBeforeReset: true, hoursToReset: 60 }, 'reaches 100% in 31h — before it resets (in 2.5d)'],
      // The reset comes first.
      [{ hoursToWall: 84, hitsWallBeforeReset: false, hoursToReset: 8 }, 'resets in 8h, before reaching 100% (3.5d away at this pace)'],
      // Already there.
      [{ pctUsed: 1, hoursToReset: 5 }, 'at 100% now — resets in 5h'],
      [{ pctUsed: 1.2, hoursToReset: 50 }, 'at 100% now — resets in 2.1d'],
      // Nothing is being used, so there is no pace to project.
      [{ hoursToWall: null, hitsWallBeforeReset: false, hoursToReset: 12 }, 'not moving toward 100% — resets in 12h'],
    ];
    for (const [over, want] of cases) expect(reachEstimate(anchor(over)), JSON.stringify(over)).toBe(want);
  });
});

describe('the usage log on the Tokens page', () => {
  beforeEach(() => { mocks.anchors = []; mocks.checkpoints = []; mocks.offline = false; });

  it('keeps the entry form, the log and the estimate — and nothing else of the two old sections', async () => {
    mocks.anchors = [anchor()];
    mocks.checkpoints = [
      { id: 'c1', provider: 'claude', window: 'weekly', pctUsed: 0.48, resetsAt: '2026-11-19T23:00:00.000Z', observedAt: '2026-11-16T12:44:00.000Z', createdAt: '2026-11-16T12:44:00.000Z' },
      { id: 'c2', provider: 'claude', window: 'weekly', pctUsed: 0.87, resetsAt: '2026-09-24T23:00:00.000Z', observedAt: '2026-09-22T01:57:00.000Z', createdAt: '2026-09-22T01:57:00.000Z' },
    ];
    render(<TokensPage servers={servers} />);
    expect(await screen.findByRole('heading', { name: 'Usage log' })).toBeVisible();
    // The entry form.
    for (const name of ['reading provider', 'reading window', 'percent used', 'resets at']) expect(screen.getByLabelText(name)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log reading' })).toBeVisible();
    // The estimate: one line.
    const estimate = await screen.findByTestId('reach-estimate');
    expect(estimate.textContent).toBe('Claude weekly · 66% used · resets in 8h, before reaching 100% (3.5d away at this pace)');
    // The log.
    await waitFor(() => expect(screen.getByRole('list', { name: 'logged readings' }).querySelectorAll('li')).toHaveLength(2));
    // Gone: the second section, its button, and the first section's fine print.
    for (const gone of [/Subscription usage gauges/, /Mark 100%/, /what the provider shows/, /tokens\/week/, /confidence/, /pins the gauge/, /pace \d/]) {
      expect(screen.queryByText(gone), String(gone)).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Mark 100%/ })).toBeNull();
  });

  it('says how to get an estimate when nothing has been logged', async () => {
    render(<TokensPage servers={servers} />);
    expect(await screen.findByText('No reading yet. Log what the provider\'s usage page shows to get an estimate.')).toBeVisible();
    expect(screen.queryByTestId('reach-estimate')).toBeNull();
  });

  it.each([false, true])('shows no "Partial" warning — with every server answering, and with one offline (%s)', async (offline) => {
    mocks.offline = offline;
    render(<TokensPage servers={servers} />);
    await screen.findByRole('heading', { name: 'Usage log' });
    await waitFor(() => expect(screen.getByRole('heading', { name: /token report/i })).toBeVisible());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Partial:/)).toBeNull();
    expect(screen.queryByText(/servers reported/)).toBeNull();
  });
});
