/**
 * The theme in use for everyone (Settings → Themes) decides how this browser draws NeonCore.
 * Pictures and sounds of a theme of your own are served at their usual addresses by the server, so
 * all a browser has to get right is which base it was built with (sci-fi or fantasy).
 */
import { useEffect } from 'react';
import type { ThemesList } from '../types';
import { THEME, chooseTheme, themeFrom, type ThemeId } from '../world/theme';
import { api } from './api';

const SYNC_KEY = 'neoncore.theme.synced';

export interface SyncDeps {
  fetch: () => Promise<Pick<ThemesList, 'activeBase'>>;
  current: ThemeId;
  choose: (t: ThemeId) => void;
  /** Where the last switch is remembered for this tab, so a browser that cannot keep the choice never reloads in a loop. */
  session?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/** Switch this browser to the base of the theme in use, once. Returns the base it switched to, or null. */
export async function syncActiveTheme({ fetch, current, choose, session }: SyncDeps): Promise<ThemeId | null> {
  let base: ThemeId;
  try { base = themeFrom((await fetch()).activeBase); } catch { return null; } // no server (demo, offline): keep what this browser has
  if (base === current) return null;
  try { if (session?.getItem(SYNC_KEY) === base) return null; session?.setItem(SYNC_KEY, base); } catch { /* no session storage: still switch once per load */ }
  choose(base);
  return base;
}

export function useActiveTheme(): void {
  useEffect(() => {
    let session: Storage | null = null;
    try { session = globalThis.sessionStorage ?? null; } catch { session = null; }
    void syncActiveTheme({ fetch: () => api.getThemes(), current: THEME, choose: chooseTheme, session });
  }, []);
}
