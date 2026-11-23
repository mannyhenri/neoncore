import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { NeedsYouItem } from '../types';

/**
 * Everything waiting on the person, read from the server's STATE (GET /needs-you) — so it is here
 * after a reload, when the dashboard was closed while it happened, and however many routine
 * notices came after it. Re-read every 15 s and whenever a notification arrives (`bump`).
 */
export function useNeedsYou(bump: unknown, intervalMs = 15_000): NeedsYouItem[] {
  const [items, setItems] = useState<NeedsYouItem[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { api.getNeedsYou().then((list) => { if (alive) setItems(list); }).catch(() => { /* keep the last list */ }); };
    load();
    const t = setInterval(load, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [bump, intervalMs]);
  return items;
}
