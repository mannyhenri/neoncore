import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const calls = vi.hoisted(() => ({ getProjectRewards: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: calls }));
import { CaptainsLogHeader, stardate, logCounts } from '../CaptainsLog';
afterEach(cleanup);

describe('the Captain\'s Log', () => {
  it.each([
    ['2026-01-01T00:00:00Z', '26000.0'],
    ['2026-07-02T12:00:00Z', '26500.0'],
    ['2026-11-22T00:00:00Z', '26890.4'],
    ['2026-12-31T23:59:59Z', '27000.0'],
    ['2028-02-29T12:00:00Z', '28162.6'],
  ])('%s is stardate %s', (iso, want) => expect(stardate(new Date(iso))).toBe(want));

  it('counts entries, the missions among them (entries from a feature) and what is in flight', () => {
    expect(logCounts([], 0)).toEqual({ entries: 0, missions: 0, inFlight: 0 });
    expect(logCounts([{ goalId: 'g1' }, { goalId: '' }, { goalId: 'g2' }], 2)).toEqual({ entries: 3, missions: 2, inFlight: 2 });
  });

  it.each([
    [[], 0, '0 entries · 0 missions logged · 0 in flight'],
    [[{ goalId: 'g' }], 1, '1 entry · 1 mission logged · 1 in flight'],
    [[{ goalId: 'g' }, { goalId: '' }, { goalId: 'h' }], 3, '3 entries · 2 missions logged · 3 in flight'],
  ] as const)('the header: recording, the title, the project and stardate, %#: the counts, and the download', async (entries, inFlight, counts) => {
    calls.getProjectRewards.mockResolvedValue({ families: [], rank: { index: 3, id: 'admiral', title: 'Admiral', commendations: 3, next: null } });
    const { container } = render(<CaptainsLogHeader projectId="p1" projectName="Lighthouse Site" entries={entries} inFlight={inFlight} downloadHref="/api/x?download=1" now={new Date('2026-11-22T00:00:00Z')} />);
    expect(container.querySelector('[data-recording]')!.textContent).toBe('Recording');
    expect(container.querySelector('h3')!.textContent).toBe("Captain's Log");
    expect(container.querySelector('[data-log-stardate]')!.textContent).toBe('Lighthouse Site · Stardate 26890.4');
    expect(container.querySelector('[data-log-counts]')!.textContent).toBe(counts);
    expect(container.querySelector('[data-log-download]')!.getAttribute('href')).toBe('/api/x?download=1');
    // He wears his rank's uniform, logging on his tablet.
    await waitFor(() => expect(container.querySelector('[data-log-captain] [style*="captain-admiral.png"]')).not.toBeNull());
  });
});
