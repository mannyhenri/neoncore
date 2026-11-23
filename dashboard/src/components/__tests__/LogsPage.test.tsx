import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import type { LogLine, LogSource } from '../../types';

const calls = vi.hoisted(() => ({ getLogs: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: calls }));
import { LogsPage, sourceColour } from '../LogsPage';

const line = (i: number, over: Partial<LogLine> = {}): LogLine => ({ cursor: `c${String(i).padStart(4, '0')}`, at: new Date(Date.UTC(2026, 10, 23, 9, 0, i)).toISOString(), kind: 'event', source: 'harbour-ledger', engine: 'claude', machine: 'vm', level: 'info', text: `line ${i}`, ...over });
const SOURCES: LogSource[] = [
  { source: 'diner-menu-api', kind: 'event', engine: 'codex', machine: 'mac', count: 9 },
  { source: 'harbour-ledger', kind: 'event', engine: 'claude', machine: 'vm', count: 52 },
  { source: 'NeonCore', kind: 'neoncore', engine: '', machine: '', count: 203 },
];
const lastCall = () => calls.getLogs.mock.calls[calls.getLogs.mock.calls.length - 1][0];
beforeEach(() => { calls.getLogs.mockReset(); calls.getLogs.mockResolvedValue({ lines: [line(1), line(2, { kind: 'neoncore', source: 'NeonCore', level: 'problem', text: 'request failed' })], hasMore: true, sources: SOURCES }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the Logs section', () => {
  it('shows the newest lines, each with its time, source, kind and text; a chip per source with its engine and count', async () => {
    render(<LogsPage pollMs={60_000} />);
    await waitFor(() => expect(document.querySelectorAll('[data-log-line]')).toHaveLength(2));
    expect(lastCall()).toEqual({ limit: 200 });
    const rows = [...document.querySelectorAll('[data-log-line]')];
    expect(rows.map((r) => [r.getAttribute('data-log-line'), r.getAttribute('data-level')])).toEqual([['event', 'info'], ['neoncore', 'problem']]);
    expect(rows[1].textContent).toContain('NeonCore');
    expect(rows[1].textContent).toContain('request failed');
    const chips = [...document.querySelectorAll('[data-log-source]')];
    expect(chips.map((c) => c.textContent)).toEqual(['diner-menu-apicodex9', 'harbour-ledgerclaude52', 'NeonCore203']);
    expect(sourceColour('NeonCore')).toBe('#B79CFF');
    expect(sourceColour('harbour-ledger')).toBe(sourceColour('harbour-ledger'));
  });

  it('a source chip: click hides it, click again shows it; double-click shows it alone; All sources resets', async () => {
    render(<LogsPage pollMs={60_000} />);
    await waitFor(() => expect(document.querySelector('[data-log-source="harbour-ledger"]')).not.toBeNull());
    const chip = document.querySelector<HTMLElement>('[data-log-source="harbour-ledger"]')!;
    fireEvent.click(chip);
    await waitFor(() => expect(lastCall()).toEqual({ limit: 200, hide: ['harbour-ledger'] }));
    expect(chip.getAttribute('data-shown')).toBe('false');
    fireEvent.click(chip);
    await waitFor(() => expect(lastCall()).toEqual({ limit: 200 }));
    fireEvent.click(document.querySelector('[data-log-source="NeonCore"]')!);
    fireEvent.click(document.querySelector('[data-log-source="NeonCore"]')!);
    fireEvent.doubleClick(document.querySelector('[data-log-source="NeonCore"]')!);
    await waitFor(() => expect(lastCall()).toEqual({ limit: 200, only: 'NeonCore' }));
    expect([...document.querySelectorAll('[data-log-source]')].map((c) => c.getAttribute('data-shown'))).toEqual(['false', 'false', 'true']);
    fireEvent.click(document.querySelector('[data-logs-all]')!);
    await waitFor(() => expect(lastCall()).toEqual({ limit: 200 }));
  });

  it.each([
    [['event'], { kinds: ['terminal', 'neoncore'] }],
    [['terminal'], { kinds: ['event', 'neoncore'] }],
    [['neoncore'], { kinds: ['event', 'terminal'] }],
    [['event', 'terminal'], { kinds: ['neoncore'] }],
    [['event', 'terminal', 'neoncore'], {}],
  ] as const)('turning off %j asks for the rest — and turning every kind off shows them all again', async (off, want) => {
    render(<LogsPage pollMs={60_000} />);
    await waitFor(() => expect(calls.getLogs).toHaveBeenCalled());
    for (const k of off) fireEvent.click(document.querySelector(`[data-log-kind="${k}"]`)!);
    await waitFor(() => expect(lastCall()).toEqual({ limit: 200, ...want }));
  });

  it('Problems only and the search are sent; the search waits until typing stops', async () => {
    render(<LogsPage pollMs={60_000} />);
    await waitFor(() => expect(calls.getLogs).toHaveBeenCalled());
    fireEvent.click(document.querySelector('[data-logs-problems]')!);
    await waitFor(() => expect(lastCall()).toEqual({ limit: 200, problems: true }));
    fireEvent.change(screen.getByLabelText('Search the logs'), { target: { value: 'taxFor' } });
    await waitFor(() => expect(lastCall()).toEqual({ limit: 200, problems: true, q: 'taxFor' }));
  });

  it('new lines arrive after the last one; Pause stops asking, Resume asks again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LogsPage pollMs={1000} />);
    await waitFor(() => expect(document.querySelectorAll('[data-log-line]')).toHaveLength(2));
    calls.getLogs.mockResolvedValue({ lines: [line(3)], hasMore: false, sources: SOURCES });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await waitFor(() => expect(document.querySelectorAll('[data-log-line]')).toHaveLength(3));
    expect(lastCall()).toEqual({ limit: 500, after: 'c0002' });
    fireEvent.click(document.querySelector('[data-logs-pause]')!);
    const n = calls.getLogs.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(calls.getLogs.mock.calls.length).toBe(n);
    expect(document.querySelector('[data-logs-pause]')!.textContent).toBe('▶ Resume');
    calls.getLogs.mockResolvedValue({ lines: [], hasMore: false, sources: SOURCES });
    fireEvent.click(document.querySelector('[data-logs-pause]')!);
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(calls.getLogs.mock.calls.length).toBeGreaterThan(n);
  });

  it('scrolling to the top loads the older lines before the first one', async () => {
    render(<LogsPage pollMs={60_000} />);
    await waitFor(() => expect(document.querySelectorAll('[data-log-line]')).toHaveLength(2));
    calls.getLogs.mockResolvedValue({ lines: [line(0)], hasMore: false, sources: SOURCES });
    const box = document.querySelector<HTMLElement>('[data-logs-lines]')!;
    box.scrollTop = 0;
    fireEvent.scroll(box);
    await waitFor(() => expect(document.querySelectorAll('[data-log-line]')).toHaveLength(3));
    expect(lastCall()).toEqual({ limit: 200, before: 'c0001' });
    expect(document.querySelector('[data-log-line]')!.textContent).toContain('line 0');
    expect(document.querySelector('[data-logs-older]')).toBeNull();
  });
});
