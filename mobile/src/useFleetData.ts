import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useNeonCore } from './NeonCoreProvider';

/** One server's answer. */
export interface FromServer<T> { base: string; name: string; data: T | null; error: string }

/**
 * Ask every reachable server the same question, and keep asking: every `everyMs`, and whenever the
 * app comes back to the front. A server that fails does not hold up the others (allSettled), and
 * the result always reaches a decided state — data or an error, never an endless spinner.
 */
export function useFleetData<T>(load: (base: string) => Promise<T>, deps: unknown[] = [], everyMs = 15_000) {
  const { servers, serverStatuses } = useNeonCore();
  const visible = servers.filter((s) => !s.hidden);
  const key = visible.map((s) => s.url).join('|');
  const [results, setResults] = useState<FromServer<T>[]>([]);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      const reachable = visible.filter((s) => serverStatuses.find((x) => x.url === s.url)?.reachable !== false);
      const settled = await Promise.allSettled(reachable.map((s) => loadRef.current(s.url)));
      setResults(reachable.map((s, i) => {
        const r = settled[i];
        return { base: s.url, name: s.name, data: r.status === 'fulfilled' ? r.value : null, error: r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : '' };
      }));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, everyMs);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void refresh(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [refresh, everyMs]);

  return { results, loading, refresh, many: visible.length > 1 };
}
