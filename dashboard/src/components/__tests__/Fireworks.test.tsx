/**
 * A feature marked done gets fireworks: rockets that burst, a banner naming it, the "delivered"
 * cue — and then they are gone. Reduced motion: the banner only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

const sound = vi.hoisted(() => ({ playCue: vi.fn(() => true) }));
vi.mock('../../lib/sound/engine', () => sound);
import { Fireworks, FIREWORKS_MS, ROCKETS, SPARKS } from '../Fireworks';
import { celebrateFeature } from '../../lib/celebrate';

const motion = (reduce: boolean) => { window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as never; };
beforeEach(() => { vi.useFakeTimers(); sound.playCue.mockClear(); motion(false); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const q = (s: string) => document.querySelector(s);

describe('fireworks for a feature marked done', () => {
  it('nothing until a feature is marked done; then every rocket bursts into its sparks, the banner names it, the cue plays — and it is gone after FIREWORKS_MS', () => {
    render(<Fireworks />);
    expect(q('[data-fireworks]')).toBeNull();
    act(() => celebrateFeature('Points per visit'));
    expect(q('[data-fireworks]')).not.toBeNull();
    expect(q('[data-fireworks-banner]')!.textContent).toBe('✦ Feature complete ✦Points per visit');
    expect(document.querySelectorAll('[data-firework]')).toHaveLength(ROCKETS.length);
    for (const r of document.querySelectorAll('[data-firework]')) expect(r.querySelectorAll('[data-spark]')).toHaveLength(SPARKS);
    expect(sound.playCue).toHaveBeenCalledWith('delivered');
    expect(q('[data-fireworks]')!.className).toContain('pointer-events-none');
    act(() => { vi.advanceTimersByTime(FIREWORKS_MS - 1); });
    expect(q('[data-fireworks]')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(q('[data-fireworks]')).toBeNull();
  });

  it('a second one while the first is still up: it names the newest and starts over', () => {
    render(<Fireworks />);
    act(() => celebrateFeature('Cart'));
    act(() => { vi.advanceTimersByTime(FIREWORKS_MS - 500); });
    act(() => celebrateFeature('Checkout'));
    expect(q('[data-fireworks-banner]')!.textContent).toContain('Checkout');
    act(() => { vi.advanceTimersByTime(FIREWORKS_MS - 1); });
    expect(q('[data-fireworks]')).not.toBeNull();
    expect(sound.playCue).toHaveBeenCalledTimes(2);
  });

  it('with reduced motion: the banner, no rockets', () => {
    motion(true);
    render(<Fireworks />);
    act(() => celebrateFeature('Cart'));
    expect(q('[data-fireworks-banner]')).not.toBeNull();
    expect(document.querySelectorAll('[data-firework]')).toHaveLength(0);
  });
});
