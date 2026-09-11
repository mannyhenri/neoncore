import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEntry } from '@neoncore/client';
import { SUBSCRIPTION_PROVIDERS } from '../lib/subscriptionUsage';

const mocks = vi.hoisted(() => ({
  mark: vi.fn(),
  getUsageSeries: vi.fn(async () => ({ bucket: 'day', days: 30, since: '', series: [], projects: [], cartridges: [] })),
  getBurnRate: vi.fn(async () => ({
    windowHours: 168, days: 7, tokens: 0, tokensPerHour: 0, tokensPerDay: 0,
    costUsd: 0, costPerDay: 0, samples: 0, activeCartridges: 0, subscriptionUsage: [],
  })),
}));

vi.mock('../lib/api', () => {
  const client = {
    getUsageSeries: mocks.getUsageSeries,
    getBurnRate: mocks.getBurnRate,
    markTokenLimit: mocks.mark,
    getUsageCheckpoints: vi.fn(async () => ({ checkpoints: [], anchors: [] })),
  };
  return { api: client, apiFor: () => client };
});

import { TokensPage } from '../components/TokensPage';

const servers: ServerEntry[] = [
  { url: '', serverId: 'local', name: 'Local', token: null, manual: true },
  { url: 'http://studio.local:4040', serverId: 'studio', name: 'Studio', token: null, manual: true },
];

describe('subscription calibration control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mark.mockResolvedValue({ id: 'calibration', weeklyTokens: 11_000_000_000 });
  });

  it('submits every registered provider to every active server and refreshes reporting', async () => {
    render(<TokensPage servers={servers} />);
    // The page now also carries the usage-reading form's selects; this one is the calibration's.
    const select = screen.getByRole('combobox', { name: 'provider that reached 100%' });
    const date = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Mark 100%' });

    for (const provider of SUBSCRIPTION_PROVIDERS) {
      fireEvent.change(select, { target: { value: provider } });
      fireEvent.change(date, { target: { value: '2026-09-10T08:30' } });
      fireEvent.click(button);
      await waitFor(() => expect(mocks.mark).toHaveBeenCalledTimes(servers.length));
      for (const call of mocks.mark.mock.calls) {
        expect(call[0]).toBe(provider);
        expect(new Date(call[1]).toISOString()).toBe(call[1]);
      }
      expect(await screen.findByText(`${provider === 'claude' ? 'Claude' : 'Codex'} 100% recorded.`)).toBeVisible();
      mocks.mark.mockClear();
    }
    expect(mocks.getBurnRate.mock.calls.length).toBeGreaterThan(servers.length);
  });

  it('reports partial fleet failure and still refreshes successful observations', async () => {
    mocks.mark.mockResolvedValueOnce({ id: 'saved' }).mockRejectedValueOnce(new Error('offline'));
    render(<TokensPage servers={servers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark 100%' }));
    expect(await screen.findByText('Could not calibrate 1 of 2 server(s).')).toBeVisible();
    await waitFor(() => expect(mocks.getBurnRate.mock.calls.length).toBeGreaterThan(servers.length));
  });
});
