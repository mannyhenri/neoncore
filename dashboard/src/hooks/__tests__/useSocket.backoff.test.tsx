import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ServerEntry } from '../../types';

/**
 * Reconnect policy for fleet sockets.
 *
 * The dashboard opens one socket per server. With `reconnectionDelayMax: 5000` and
 * unlimited attempts, a server that cannot be reached is retried roughly every five
 * seconds forever — around twelve connection attempts a minute, per browser tab, for as
 * long as the tab is open. Adding one unreachable machine to a fleet therefore points a
 * permanent, self-inflicted connection storm at it; we watched a laptop log an unbroken
 * connect/disconnect cycle because of exactly this.
 *
 * The fix is backoff, NOT a retry cap: a sleeping laptop must still rejoin on its own when
 * it wakes, so attempts stay unlimited and only the pacing changes.
 */

const created: { target: string; opts: Record<string, unknown> }[] = [];

const fakeSocket = () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn(), close: vi.fn(), connected: false });

vi.mock('socket.io-client', () => ({
  io: (target: string, opts: Record<string, unknown>) => {
    created.push({ target, opts });
    return fakeSocket();
  },
  Socket: class {},
}));

import { useSockets } from '../useSocket';

const servers: ServerEntry[] = [
  { url: '', serverId: 'a', name: 'local', token: null, manual: true } as ServerEntry,
  { url: 'http://emmanuels-macbook-pro.local:4040', serverId: 'b', name: 'macbook', token: 'tok', manual: true } as ServerEntry,
];

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal('window', { ...globalThis.window, location: { origin: 'http://localhost:4040' } });
});

/** The retry policy every fleet socket must carry. */
const POLICY: { key: string; check: (v: unknown) => boolean; why: string }[] = [
  { key: 'reconnection', check: (v) => v === true, why: 'a woken laptop must rejoin by itself' },
  { key: 'reconnectionAttempts', check: (v) => v === Infinity, why: 'capping attempts would strand a server that comes back later' },
  { key: 'reconnectionDelayMax', check: (v) => typeof v === 'number' && v >= 30000, why: 'a 5s ceiling is ~12 attempts/min against a dead server, forever' },
  { key: 'randomizationFactor', check: (v) => typeof v === 'number' && v > 0, why: 'without jitter every tab retries in lockstep' },
];

describe('fleet socket reconnect policy', () => {
  it('opens one socket per server', () => {
    renderHook(() => useSockets(servers, {}));
    expect(created.length).toBe(servers.length);
  });

  // Set-based: every server gets the full policy, not just the first one opened.
  it('applies the whole backoff policy to EVERY server', () => {
    renderHook(() => useSockets(servers, {}));

    const violations: string[] = [];
    for (const c of created) {
      for (const rule of POLICY) {
        if (!rule.check(c.opts[rule.key])) {
          violations.push(`${c.target || '(local)'} ${rule.key}=${String(c.opts[rule.key])} — ${rule.why}`);
        }
      }
    }
    expect(violations, `retry policy violations:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('backs off to at least 30s — the storm ceiling', () => {
    renderHook(() => useSockets(servers, {}));
    const ceilings = created.map((c) => c.opts.reconnectionDelayMax);
    for (const c of ceilings) {
      expect(c, `ceiling ${String(c)}ms still storms an unreachable server`).toBeGreaterThanOrEqual(30000);
    }
  });

  it('still starts fast — a blip must not cost 30 seconds', () => {
    renderHook(() => useSockets(servers, {}));
    for (const c of created) {
      expect(c.opts.reconnectionDelay, 'first retry should stay ~1s').toBeLessThanOrEqual(2000);
    }
  });
});
