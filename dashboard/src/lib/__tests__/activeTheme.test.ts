import { describe, it, expect, vi } from 'vitest';
import { syncActiveTheme } from '../activeTheme';

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe('the theme in use for everyone decides how this browser draws NeonCore', () => {
  it('a browser on the other base switches to it', async () => {
    const choose = vi.fn();
    expect(await syncActiveTheme({ fetch: async () => ({ activeBase: 'fantasy' }), current: 'scifi', choose, session: store() })).toBe('fantasy');
    expect(choose).toHaveBeenCalledWith('fantasy');
  });
  it('a browser already on it does nothing', async () => {
    const choose = vi.fn();
    expect(await syncActiveTheme({ fetch: async () => ({ activeBase: 'scifi' }), current: 'scifi', choose, session: store() })).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });
  it('a browser that could not keep the switch does not reload again and again', async () => {
    const choose = vi.fn(); const session = store();
    await syncActiveTheme({ fetch: async () => ({ activeBase: 'fantasy' }), current: 'scifi', choose, session });
    await syncActiveTheme({ fetch: async () => ({ activeBase: 'fantasy' }), current: 'scifi', choose, session });
    expect(choose).toHaveBeenCalledTimes(1);
  });
  it('no server (demo, offline): keeps what it has', async () => {
    const choose = vi.fn();
    expect(await syncActiveTheme({ fetch: async () => { throw new Error('offline'); }, current: 'fantasy', choose, session: store() })).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });
});
